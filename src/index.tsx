import { serve } from 'bun'
import { Relay } from 'nostr-tools'
import { getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import index from './index.html'
import { fetchAppSettings } from './lib/appSettings'
import { AppSettingsSchema } from './lib/schemas/app'
import { resolveCvmServerPubkey } from './lib/cvm-identity'
import { getEventHandler } from './server'
import { join } from 'path'
import { file } from 'bun'
import { computeConfigFlags } from './lib/configFlags'

import.meta.hot.accept()

const RELAY_URL = process.env.APP_RELAY_URL
const NIP46_RELAY_URL = process.env.NIP46_RELAY_URL || 'wss://relay.nsec.app'
const APP_PRIVATE_KEY = process.env.APP_PRIVATE_KEY

let appSettings: Awaited<ReturnType<typeof fetchAppSettings>> = null
let APP_PUBLIC_KEY: string
let CVM_SERVER_PUBKEY: string

function jsonError(message: string, status = 400) {
	return Response.json({ error: message }, { status })
}

function getCvmServerPublicKey(): string {
	if (CVM_SERVER_PUBKEY) return CVM_SERVER_PUBKEY
	CVM_SERVER_PUBKEY = resolveCvmServerPubkey()
	return CVM_SERVER_PUBKEY
}

// Retry the boot-time app-settings fetch so a slow or briefly-unreachable relay
// at startup does not strand the instance in setup mode. ~10 attempts x 3s
// comfortably covers a transient relay hiccup; a genuinely un-set-up instance
// simply exhausts them and correctly reports needsSetup.
const APP_SETTINGS_MAX_ATTEMPTS = 10
const APP_SETTINGS_RETRY_MS = 3000

// False until the boot-time settings resolution has finished (loaded or given
// up). While false the server reports `initializing` and NOT `needsSetup`, so a
// client that loads during the boot window waits instead of being bounced to
// /setup and stuck there.
let appSettingsResolved = false

async function initializeAppSettings() {
	if (!RELAY_URL || !APP_PRIVATE_KEY) {
		console.error('Missing required environment variables: APP_RELAY_URL, APP_PRIVATE_KEY')
		process.exit(1)
	}

	try {
		const privateKeyBytes = new Uint8Array(Buffer.from(APP_PRIVATE_KEY, 'hex'))
		APP_PUBLIC_KEY = getPublicKey(privateKeyBytes)
	} catch (error) {
		console.error('Failed to derive app public key:', error)
		process.exit(1)
	}

	for (let attempt = 1; attempt <= APP_SETTINGS_MAX_ATTEMPTS; attempt++) {
		try {
			const settings = await fetchAppSettings(RELAY_URL as string, APP_PUBLIC_KEY)
			if (settings) {
				appSettings = settings
				console.log(`App settings loaded successfully (attempt ${attempt})`)
				appSettingsResolved = true
				return
			}
			console.log(`No app settings found yet (attempt ${attempt}/${APP_SETTINGS_MAX_ATTEMPTS})`)
		} catch (error) {
			console.error(`App settings fetch failed (attempt ${attempt}/${APP_SETTINGS_MAX_ATTEMPTS}):`, error)
		}
		if (attempt < APP_SETTINGS_MAX_ATTEMPTS) {
			await new Promise((resolve) => setTimeout(resolve, APP_SETTINGS_RETRY_MS))
		}
	}

	console.log('No app settings after retries - setup required')
	appSettingsResolved = true
}
;(async () => await initializeAppSettings())()

export type NostrMessage = ['EVENT', Event]

// Track initialization state - mark as ready as soon as core components are initialized
// The heavy relay connections can fail/timeout without blocking setup
let eventHandlerReady = false

// Start initialization but don't block setup on relay connections
// Core components (signer, validator, admin manager) are set up synchronously in the constructor
// Only relay-dependent features (zaps, blacklist sync) may be delayed
const initPromise = getEventHandler()
	.initialize({
		appPrivateKey: process.env.APP_PRIVATE_KEY || '',
		adminPubkeys: [],
		relayUrl: RELAY_URL,
	})
	.then(() => {
		eventHandlerReady = true
		console.log('✅ EventHandler initialized successfully')
	})
	.catch((error) => {
		console.error('EventHandler initialization failed:', error)
		// Still mark as ready - core components are initialized, relay features may be degraded
		eventHandlerReady = true
	})

// For setup form: mark ready after short delay since core components are ready immediately
// This allows setup events to be processed even if relay connections are slow
setTimeout(() => {
	if (!eventHandlerReady) {
		console.log('Marking event handler ready after initial delay (core components ready)')
		eventHandlerReady = true
	}
}, 2000)

// Handle static files from the public directory
const serveStatic = async (path: string) => {
	const filePath = join(process.cwd(), 'public', path)
	try {
		const f = file(filePath)
		if (!f.exists()) {
			return new Response('File not found', { status: 404 })
		}
		// Determine content type based on file extension
		const contentType = path.endsWith('.svg')
			? 'image/svg+xml'
			: path.endsWith('.png')
				? 'image/png'
				: path.endsWith('.jpg') || path.endsWith('.jpeg')
					? 'image/jpeg'
					: path.endsWith('.css')
						? 'text/css'
						: path.endsWith('.js')
							? 'application/javascript'
							: path.endsWith('.json')
								? 'application/json'
								: path.endsWith('.ico')
									? 'image/x-icon'
									: 'application/octet-stream'

		return new Response(f, {
			headers: { 'Content-Type': contentType },
		})
	} catch (error) {
		console.error(`Error serving static file ${path}:`, error)
		return new Response('Internal server error', { status: 500 })
	}
}

/**
 * Determine the deployment stage from NODE_ENV
 */
function determineStage(): 'production' | 'staging' | 'development' {
	const explicitStage = process.env.APP_STAGE
	if (explicitStage === 'staging' || explicitStage === 'production' || explicitStage === 'development') {
		return explicitStage
	}

	const env = process.env.NODE_ENV
	if (env === 'staging') return 'staging'
	if (env === 'production') return 'production'
	return 'development'
}

const PORT = Number(process.env.PORT || 3000)

console.log(`App port: ${PORT}`)

export const server = serve({
	port: PORT,
	routes: {
		'/api/config': {
			GET: () => {
				const stage = determineStage()
				// Return cached settings loaded at startup
				return Response.json({
					appRelay: RELAY_URL,
					stage,
					nip46Relay: NIP46_RELAY_URL,
					appSettings: appSettings,
					appPublicKey: APP_PUBLIC_KEY,
					cvmServerPubkey: getCvmServerPublicKey(),
					...computeConfigFlags({ appSettings, appSettingsResolved, eventHandlerReady }),
				})
			},
		},
		// magick.market is GRIN-only: NIP-05 names and vanity URLs are paid in
		// Grin via the claim routes below.
		// Verifies a buyer-signed Grin payment receipt (kind 17) and registers the
		// NIP-05 username it pays for. See Nip05ManagerImpl.handleGrinPurchase for
		// the verification/registration logic; this route only unwraps the body.
		'/api/nip05/claim': {
			POST: async (req) => {
				let body: { event?: unknown }
				try {
					body = await req.json()
				} catch {
					return jsonError('Invalid JSON body', 400)
				}
				const event = body?.event
				if (!event || typeof event !== 'object') {
					return jsonError('Missing event', 400)
				}
				const nip05Manager = getEventHandler().getNip05Manager()
				const result = await nip05Manager.handleGrinPurchase(event as Parameters<typeof nip05Manager.handleGrinPurchase>[0])
				if (!result.ok) {
					return jsonError(result.error, result.status)
				}
				return Response.json({ username: result.username, validUntil: result.validUntil })
			},
		},
		// Verifies a buyer-signed Grin payment receipt (kind 17) and registers the
		// vanity URL it pays for. See VanityManagerImpl.handleGrinPurchase.
		'/api/vanity/claim': {
			POST: async (req) => {
				let body: { event?: unknown }
				try {
					body = await req.json()
				} catch {
					return jsonError('Invalid JSON body', 400)
				}
				const event = body?.event
				if (!event || typeof event !== 'object') {
					return jsonError('Missing event', 400)
				}
				const vanityManager = getEventHandler().getVanityManager()
				const result = await vanityManager.handleGrinPurchase(event as Parameters<typeof vanityManager.handleGrinPurchase>[0])
				if (!result.ok) {
					return jsonError(result.error, result.status)
				}
				return Response.json({ vanityName: result.vanityName, validUntil: result.validUntil })
			},
		},
		'/images/:file': ({ params }) => serveStatic(`images/${params.file}`),
		'/.well-known/nostr.json': {
			GET: (req) => {
				const url = new URL(req.url)
				const name = url.searchParams.get('name') ?? undefined
				const nip05Manager = getEventHandler().getNip05Manager()
				const result = nip05Manager.buildNostrJson(name)
				return Response.json(result, {
					headers: {
						'Access-Control-Allow-Origin': '*',
						'Cache-Control': 'max-age=300',
					},
				})
			},
		},
		'/manifest.json': () => serveStatic('manifest.json'),
		'/sw.js': () => serveStatic('sw.js'),
		// Off-main-thread NIP-49 key-decryption worker (built by `build:worker` into public/).
		'/nip49.worker.js': () => serveStatic('nip49.worker.js'),
		'/favicon.ico': () => serveStatic('favicon.ico'),
		'/*': index,
	},
	development: process.env.NODE_ENV !== 'production',
	fetch(req, server) {
		if (server.upgrade(req)) {
			return new Response()
		}
		return new Response('Upgrade failed', { status: 500 })
	},
	// @ts-ignore
	websocket: {
		async message(ws, message) {
			try {
				const messageStr = String(message)
				const data = JSON.parse(messageStr)

				if (Array.isArray(data) && data[0] === 'EVENT' && data[1].sig) {
					console.log('Processing EVENT message')

					// Check if EventHandler is ready
					if (!eventHandlerReady) {
						const errorResponse = ['OK', data[1].id, false, 'error: Server initializing, please try again']
						ws.send(JSON.stringify(errorResponse))
						return
					}

					if (!verifyEvent(data[1] as Event)) {
						ws.send(JSON.stringify(['OK', data[1].id, false, 'error: Unable to verify event signature']))
						return
					}

					let resignedEvent
					try {
						resignedEvent = getEventHandler().handleEvent(data[1])
					} catch (handleError) {
						console.error('Error in handleEvent:', handleError)
						ws.send(JSON.stringify(['OK', data[1].id, false, `error: Handler error: ${handleError}`]))
						return
					}

					if (resignedEvent) {
						try {
							const relay = await Promise.race([
								Relay.connect(RELAY_URL as string),
								new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay connect timeout')), 5000)),
							])
							await relay.publish(resignedEvent as Event)
						} catch (publishError) {
							console.error('Error publishing to relay:', publishError)
							ws.send(JSON.stringify(['OK', data[1].id, false, `error: relay publish failed: ${publishError}`]))
							return
						}

						// Update cached appSettings when a kind 31990 event is published
						if (resignedEvent.kind === 31990) {
							try {
								const parsed = AppSettingsSchema.parse(JSON.parse(resignedEvent.content))
								appSettings = parsed
								console.log('App settings cache updated from new kind 31990 event')
							} catch (e) {
								console.warn('Failed to update app settings cache:', e)
							}
						}

						const okResponse = ['OK', resignedEvent.id, true, '']
						ws.send(JSON.stringify(okResponse))
					} else {
						// If event was not from admin
						const okResponse = ['OK', data[1].id, false, 'Not authorized']
						ws.send(JSON.stringify(okResponse))
					}
				}
			} catch (error) {
				console.error('Error processing WebSocket message:', error)
				try {
					const parsed = JSON.parse(String(message))
					const failedId = Array.isArray(parsed) && parsed[0] === 'EVENT' ? parsed[1]?.id : parsed?.id
					if (failedId) {
						const errorResponse = ['OK', failedId, false, `error: Invalid message format ${error}`]
						ws.send(JSON.stringify(errorResponse))
						return
					}
				} catch {
					ws.send(JSON.stringify(['NOTICE', 'error: Invalid JSON']))
				}
			}
		},
	},
})

console.log(`🚀 Server running at ${server.url}`)
