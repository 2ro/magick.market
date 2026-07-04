// Service Worker for Magick Market
// Focused on update detection with minimal caching.
//
// SW_VERSION is stamped by build.ts on every build (the `__SW_VERSION__` token is
// replaced with a unique build id). This guarantees the deployed sw.js changes
// bytes each deploy, so browsers detect the update and re-run install → activate:
// skipWaiting + clients.claim take over promptly and old caches are purged, forcing
// existing clients off any previously-cached (pre-filtering) bundle. Without a
// changing version the file is byte-identical every deploy and no update fires.
const SW_VERSION = '__SW_VERSION__'
const CACHE_NAME = `magick-${SW_VERSION}`

// Assets to cache (static files only)
const STATIC_ASSETS = ['/images/logo.svg', '/images/Magick_Logo_OpenGraph.png']

// Install: cache static assets
self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => {
			return cache.addAll(STATIC_ASSETS)
		}),
	)
	// Activate immediately for faster updates
	self.skipWaiting()
})

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((cacheNames) => {
			return Promise.all(cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))
		}),
	)
	// Take control of all clients immediately
	self.clients.claim()
})

// Fetch: Network-first strategy
// This ensures users always get fresh content while still having offline fallback
self.addEventListener('fetch', (event) => {
	const { request } = event

	// Skip non-GET requests
	if (request.method !== 'GET') return

	// Skip API requests and external URLs
	const url = new URL(request.url)
	if (url.pathname.startsWith('/api') || url.origin !== self.location.origin) {
		return
	}

	event.respondWith(
		fetch(request)
			.then((response) => {
				// Clone and cache successful responses for static assets
				if (response.ok && STATIC_ASSETS.some((asset) => url.pathname.endsWith(asset))) {
					const responseClone = response.clone()
					caches.open(CACHE_NAME).then((cache) => {
						cache.put(request, responseClone)
					})
				}
				return response
			})
			.catch(() => {
				// Network failed, try cache
				return caches.match(request)
			}),
	)
})
