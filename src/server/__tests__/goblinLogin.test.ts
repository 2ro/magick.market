import { describe, test, expect } from 'bun:test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
	CHALLENGE_TTL_MS,
	CREATED_AT_SKEW_SECONDS,
	GOBLIN_LOGIN_EVENT_KIND,
	createGoblinLoginService,
	resolveExpectedDomain,
} from '../goblinLogin'

const DOMAIN = 'magick.market'
const T0 = 1_750_000_000_000

// Injectable clock: tests advance `clock.ms` instead of sleeping.
function makeService(clock: { ms: number }) {
	return createGoblinLoginService({ now: () => clock.ms })
}

// A REAL signed kind-22242 login event, exactly as the wallet would produce it.
function loginEvent(sk: Uint8Array, params: { nonce: string; domain?: string; createdAt: number; kind?: number }) {
	return finalizeEvent(
		{
			kind: params.kind ?? GOBLIN_LOGIN_EVENT_KIND,
			created_at: params.createdAt,
			tags: [
				['challenge', params.nonce],
				['domain', params.domain ?? DOMAIN],
			],
			content: '',
		},
		sk,
	)
}

describe('resolveExpectedDomain', () => {
	test('explicit env domain wins over the request host', () => {
		expect(resolveExpectedDomain('internal.local:3000', 'magick.market')).toBe('magick.market')
	})

	test('falls back to the request Host header when env is unset', () => {
		expect(resolveExpectedDomain('magick.market:8443', undefined)).toBe('magick.market:8443')
		expect(resolveExpectedDomain('magick.market', '')).toBe('magick.market')
	})

	test('returns null when neither env nor host is available', () => {
		expect(resolveExpectedDomain(null, undefined)).toBeNull()
		expect(resolveExpectedDomain('  ', '  ')).toBeNull()
	})
})

describe('createGoblinLoginService', () => {
	test('happy path: challenge -> signed callback -> ok with pubkey recorded', () => {
		const clock = { ms: T0 }
		const service = makeService(clock)
		const sk = generateSecretKey()
		const pubkey = getPublicKey(sk)

		const { c } = service.createChallenge()
		expect(c).toMatch(/^[0-9a-f]{64}$/)
		expect(service.getStatus(c)).toEqual({ status: 'pending' })

		const result = service.handleCallback(loginEvent(sk, { nonce: c, createdAt: Math.floor(clock.ms / 1000) }), DOMAIN)
		expect(result).toEqual({ ok: true, pubkey })
		expect(service.getStatus(c)).toEqual({ status: 'ok', pubkey })
	})

	test('accepts a domain tag differing only in case', () => {
		const clock = { ms: T0 }
		const service = makeService(clock)
		const sk = generateSecretKey()
		const { c } = service.createChallenge()

		const result = service.handleCallback(
			loginEvent(sk, { nonce: c, domain: 'Magick.Market', createdAt: Math.floor(clock.ms / 1000) }),
			DOMAIN,
		)
		expect(result.ok).toBe(true)
	})

	test('rejects the wrong event kind', () => {
		const clock = { ms: T0 }
		const service = makeService(clock)
		const sk = generateSecretKey()
		const { c } = service.createChallenge()

		const result = service.handleCallback(loginEvent(sk, { nonce: c, createdAt: Math.floor(clock.ms / 1000), kind: 22243 }), DOMAIN)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/kind/)
		expect(service.getStatus(c)).toEqual({ status: 'pending' })
	})

	test('rejects an invalid signature (tampered event)', () => {
		const clock = { ms: T0 }
		const service = makeService(clock)
		const sk = generateSecretKey()
		const { c } = service.createChallenge()

		// Copy fields explicitly (a spread would carry nostr-tools' verified-cache
		// symbol along); a real callback body comes from JSON.parse and never has it.
		const ev = loginEvent(sk, { nonce: c, createdAt: Math.floor(clock.ms / 1000) })
		const tampered = {
			kind: ev.kind,
			pubkey: ev.pubkey,
			id: ev.id,
			created_at: ev.created_at,
			tags: ev.tags,
			content: ev.content,
			sig: (ev.sig.startsWith('0') ? '1' : '0') + ev.sig.slice(1),
		}
		const result = service.handleCallback(tampered, DOMAIN)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/signature/)
		expect(service.getStatus(c)).toEqual({ status: 'pending' })
	})

	test('rejects a wrong domain tag', () => {
		const clock = { ms: T0 }
		const service = makeService(clock)
		const sk = generateSecretKey()
		const { c } = service.createChallenge()

		const result = service.handleCallback(
			loginEvent(sk, { nonce: c, domain: 'evil.example', createdAt: Math.floor(clock.ms / 1000) }),
			DOMAIN,
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/domain/)
		expect(service.getStatus(c)).toEqual({ status: 'pending' })
	})

	test('rejects an expired nonce and the status endpoint forgets it', () => {
		const clock = { ms: T0 }
		const service = makeService(clock)
		const sk = generateSecretKey()
		const { c } = service.createChallenge()

		clock.ms = T0 + CHALLENGE_TTL_MS + 1000
		const result = service.handleCallback(loginEvent(sk, { nonce: c, createdAt: Math.floor(clock.ms / 1000) }), DOMAIN)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.status).toBe(410)
		expect(service.getStatus(c)).toBeNull()
	})

	test('rejects a replayed (already consumed) nonce', () => {
		const clock = { ms: T0 }
		const service = makeService(clock)
		const sk = generateSecretKey()
		const pubkey = getPublicKey(sk)
		const { c } = service.createChallenge()

		const first = service.handleCallback(loginEvent(sk, { nonce: c, createdAt: Math.floor(clock.ms / 1000) }), DOMAIN)
		expect(first.ok).toBe(true)

		const replay = service.handleCallback(loginEvent(sk, { nonce: c, createdAt: Math.floor(clock.ms / 1000) }), DOMAIN)
		expect(replay.ok).toBe(false)
		if (!replay.ok) expect(replay.status).toBe(409)
		// The recorded pubkey from the first callback is untouched.
		expect(service.getStatus(c)).toEqual({ status: 'ok', pubkey })
	})

	test('rejects an unknown nonce', () => {
		const clock = { ms: T0 }
		const service = makeService(clock)
		const sk = generateSecretKey()

		const nonce = 'f'.repeat(64)
		const result = service.handleCallback(loginEvent(sk, { nonce, createdAt: Math.floor(clock.ms / 1000) }), DOMAIN)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.status).toBe(404)
		expect(service.getStatus(nonce)).toBeNull()
	})

	test('rejects created_at outside the clock skew (past and future)', () => {
		const clock = { ms: T0 }
		const service = makeService(clock)
		const sk = generateSecretKey()
		const nowSeconds = Math.floor(clock.ms / 1000)

		const past = service.handleCallback(
			loginEvent(sk, { nonce: service.createChallenge().c, createdAt: nowSeconds - CREATED_AT_SKEW_SECONDS - 1 }),
			DOMAIN,
		)
		expect(past.ok).toBe(false)
		if (!past.ok) expect(past.error).toMatch(/clock skew/)

		const future = service.handleCallback(
			loginEvent(sk, { nonce: service.createChallenge().c, createdAt: nowSeconds + CREATED_AT_SKEW_SECONDS + 1 }),
			DOMAIN,
		)
		expect(future.ok).toBe(false)
		if (!future.ok) expect(future.error).toMatch(/clock skew/)

		// Exactly on the boundary is still accepted.
		const boundary = service.handleCallback(
			loginEvent(sk, { nonce: service.createChallenge().c, createdAt: nowSeconds - CREATED_AT_SKEW_SECONDS }),
			DOMAIN,
		)
		expect(boundary.ok).toBe(true)
	})

	test('fails closed when no expected domain can be resolved', () => {
		const clock = { ms: T0 }
		const service = makeService(clock)
		const sk = generateSecretKey()
		const { c } = service.createChallenge()

		const result = service.handleCallback(loginEvent(sk, { nonce: c, createdAt: Math.floor(clock.ms / 1000) }), null)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.status).toBe(500)
	})

	test('rejects a malformed (non-event) body', () => {
		const clock = { ms: T0 }
		const service = makeService(clock)
		const result = service.handleCallback({ hello: 'world' }, DOMAIN)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.status).toBe(400)
	})

	test('rate limiter allows up to the max per window, then blocks, then resets', () => {
		const clock = { ms: T0 }
		const service = createGoblinLoginService({ now: () => clock.ms, rateLimit: { max: 3, windowMs: 60_000 } })

		expect(service.allowCallback('1.2.3.4')).toBe(true)
		expect(service.allowCallback('1.2.3.4')).toBe(true)
		expect(service.allowCallback('1.2.3.4')).toBe(true)
		expect(service.allowCallback('1.2.3.4')).toBe(false)
		// Other keys are unaffected.
		expect(service.allowCallback('5.6.7.8')).toBe(true)
		// A fresh window resets the counter.
		clock.ms = T0 + 60_001
		expect(service.allowCallback('1.2.3.4')).toBe(true)
	})
})
