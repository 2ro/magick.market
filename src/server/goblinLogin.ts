/**
 * "Sign in with Goblin" challenge login (kind 22242, NIP-42 style).
 *
 * Instead of pasting an nsec, the user's Goblin wallet signs a one-time
 * challenge and POSTs the signed event back to this server. Three-step flow:
 *
 *   1. POST /api/v1/login/challenge  -> mints a 64-hex nonce, pending for 5 min
 *   2. POST /api/v1/login/callback   -> wallet submits the signed kind-22242
 *      event; on success the nonce is consumed and the pubkey recorded
 *   3. GET  /api/v1/login/status?c=  -> the browser polls until 'ok'
 *
 * This module holds the whole trust decision in one injectable place: the
 * factory takes a `now()` clock so unit tests cover expiry and clock skew
 * without timers, and the expected domain is resolved by the caller (env
 * override falling back to the request Host header) and passed in, so the
 * event's own `domain` tag is NEVER the source of truth. Pending nonces live
 * in an in-memory Map (single-instance server), pruned as new challenges are
 * minted.
 */

import { verifyEvent, type Event } from 'nostr-tools/pure'

/** NIP-42 client-authentication event kind, reused by Goblin wallet login. */
export const GOBLIN_LOGIN_EVENT_KIND = 22242

/** How long a minted challenge stays pending (the wire contract's 5 minutes). */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000

/** Accepted |created_at - now| clock skew on the signed event, in seconds. */
export const CREATED_AT_SKEW_SECONDS = 300

export interface GoblinLoginChallenge {
	nonce: string
	expiresAtMs: number
	consumed: boolean
	pubkey?: string
}

export type GoblinLoginStatusView = { status: 'pending' } | { status: 'ok'; pubkey: string }

export type GoblinLoginCallbackResult = { ok: true; pubkey: string } | { ok: false; error: string; status: number }

/**
 * Resolve the domain the signed event's `domain` tag must match. Explicit
 * server config (APP_LOGIN_DOMAIN) wins so proxied/CDN'd deployments compare
 * against the public domain; otherwise fall back to the request Host header.
 * Returns null when neither is available (the callback then fails closed).
 */
export function resolveExpectedDomain(requestHost: string | null | undefined, envDomain = process.env.APP_LOGIN_DOMAIN): string | null {
	const fromEnv = typeof envDomain === 'string' ? envDomain.trim() : ''
	if (fromEnv) return fromEnv
	const fromHost = typeof requestHost === 'string' ? requestHost.trim() : ''
	return fromHost || null
}

/** First value of the named tag, or null when absent/malformed. */
function firstTagValue(event: Event, name: string): string | null {
	const tag = event.tags.find((t) => Array.isArray(t) && t[0] === name)
	return typeof tag?.[1] === 'string' ? tag[1] : null
}

/** Structural check so verifyEvent never sees a shape it could throw on. */
function isEventShaped(event: unknown): event is Event {
	if (!event || typeof event !== 'object') return false
	const e = event as Record<string, unknown>
	return (
		typeof e.kind === 'number' &&
		typeof e.pubkey === 'string' &&
		typeof e.id === 'string' &&
		typeof e.sig === 'string' &&
		typeof e.created_at === 'number' &&
		Array.isArray(e.tags)
	)
}

export interface GoblinLoginServiceOptions {
	/** Injectable clock (ms since epoch) so tests drive expiry without sleeps. */
	now?: () => number
	/** Max callback attempts per key within the window (light abuse brake). */
	rateLimit?: { max: number; windowMs: number }
}

/**
 * Create the login service holding the pending-nonce Map and the per-key
 * callback rate limiter. One instance per server process.
 */
export function createGoblinLoginService(options: GoblinLoginServiceOptions = {}) {
	const now = options.now ?? Date.now
	const rateLimit = options.rateLimit ?? { max: 30, windowMs: 60_000 }

	const pending = new Map<string, GoblinLoginChallenge>()
	const callbackAttempts = new Map<string, { count: number; windowStartMs: number }>()

	// Drop entries a full TTL after expiry: long enough for a client to poll a
	// just-consumed nonce to 'ok', short enough that the map never grows unbounded.
	const pruneExpired = () => {
		const t = now()
		pending.forEach((challenge, nonce) => {
			if (t > challenge.expiresAtMs + CHALLENGE_TTL_MS) pending.delete(nonce)
		})
	}

	return {
		/** Mint a pending challenge and return its 64-hex nonce. */
		createChallenge(): { c: string } {
			pruneExpired()
			const bytes = new Uint8Array(32)
			crypto.getRandomValues(bytes)
			const nonce = Array.from(bytes)
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')
			pending.set(nonce, { nonce, expiresAtMs: now() + CHALLENGE_TTL_MS, consumed: false })
			return { c: nonce }
		},

		/**
		 * Light fixed-window rate limit for the callback route. Key is the
		 * client IP when the server can resolve one, else a global bucket.
		 */
		allowCallback(key: string): boolean {
			const t = now()
			if (callbackAttempts.size > 10_000) {
				callbackAttempts.forEach((entry, k) => {
					if (t - entry.windowStartMs >= rateLimit.windowMs) callbackAttempts.delete(k)
				})
			}
			const entry = callbackAttempts.get(key)
			if (!entry || t - entry.windowStartMs >= rateLimit.windowMs) {
				callbackAttempts.set(key, { count: 1, windowStartMs: t })
				return true
			}
			entry.count += 1
			return entry.count <= rateLimit.max
		},

		/**
		 * Verify a wallet-signed login event against a pending challenge.
		 * Checks, in order: expected domain resolvable (fail closed), event
		 * shape, kind 22242, signature (nostr-tools verifyEvent), challenge tag
		 * maps to a known + un-used + un-expired nonce, domain tag equals the
		 * server-derived expected domain (case-insensitive exact match including
		 * port), created_at within +/- CREATED_AT_SKEW_SECONDS of now. On
		 * success the nonce is consumed and the event pubkey recorded.
		 */
		handleCallback(event: unknown, expectedDomain: string | null): GoblinLoginCallbackResult {
			if (!expectedDomain) {
				return { ok: false, error: 'Login domain is not configured', status: 500 }
			}
			if (!isEventShaped(event)) {
				return { ok: false, error: 'Missing or malformed event', status: 400 }
			}
			if (event.kind !== GOBLIN_LOGIN_EVENT_KIND) {
				return { ok: false, error: `Wrong event kind, expected ${GOBLIN_LOGIN_EVENT_KIND}`, status: 400 }
			}
			if (!verifyEvent(event)) {
				return { ok: false, error: 'Invalid event signature', status: 400 }
			}
			const nonce = firstTagValue(event, 'challenge')
			if (!nonce) {
				return { ok: false, error: 'Missing challenge tag', status: 400 }
			}
			const challenge = pending.get(nonce)
			if (!challenge) {
				return { ok: false, error: 'Unknown challenge', status: 404 }
			}
			if (challenge.consumed) {
				return { ok: false, error: 'Challenge has already been used', status: 409 }
			}
			if (now() > challenge.expiresAtMs) {
				return { ok: false, error: 'Challenge has expired', status: 410 }
			}
			const domain = firstTagValue(event, 'domain')
			if (!domain || domain.toLowerCase() !== expectedDomain.toLowerCase()) {
				return { ok: false, error: 'Event domain does not match this site', status: 400 }
			}
			const nowSeconds = Math.floor(now() / 1000)
			if (Math.abs(event.created_at - nowSeconds) > CREATED_AT_SKEW_SECONDS) {
				return { ok: false, error: 'Event timestamp is outside the accepted clock skew', status: 400 }
			}
			challenge.consumed = true
			challenge.pubkey = event.pubkey
			return { ok: true, pubkey: event.pubkey }
		},

		/**
		 * Poll view for the browser. 'ok' once the wallet callback succeeded,
		 * 'pending' while the nonce is live, null (route 404s) when the nonce is
		 * unknown or expired unconsumed so the client stops polling.
		 */
		getStatus(nonce: string): GoblinLoginStatusView | null {
			const challenge = pending.get(nonce)
			if (!challenge) return null
			if (challenge.consumed && challenge.pubkey) return { status: 'ok', pubkey: challenge.pubkey }
			if (now() > challenge.expiresAtMs) return null
			return { status: 'pending' }
		},
	}
}

export type GoblinLoginService = ReturnType<typeof createGoblinLoginService>
