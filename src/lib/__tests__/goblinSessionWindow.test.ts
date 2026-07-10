import { beforeEach, describe, expect, test } from 'bun:test'
import {
	ABSOLUTE_CAP_MS,
	clearPersistedSession,
	GOBLIN_SESSION_WINDOW_KEY,
	IDLE_TIMEOUT_MS,
	isSessionLive,
	loadPersistedSession,
	PERSISTED_SESSION_VERSION,
	savePersistedSession,
	sessionDeadlines,
	touchActivity,
	type PersistedGoblinSession,
} from '@/lib/goblin/session/sessionWindow'

class MemoryStorage {
	private s = new Map<string, string>()
	getItem(k: string) {
		return this.s.has(k) ? this.s.get(k)! : null
	}
	setItem(k: string, v: string) {
		this.s.set(k, v)
	}
	removeItem(k: string) {
		this.s.delete(k)
	}
	clear() {
		this.s.clear()
	}
}

const HEX64 = 'a'.repeat(64)

function makeSession(overrides: Partial<PersistedGoblinSession> = {}): PersistedGoblinSession {
	const now = Date.now()
	return {
		v: PERSISTED_SESSION_VERSION,
		siteSessionPrivateKey: HEX64,
		walletSessionPubkey: 'b'.repeat(64),
		identityPubkey: 'c'.repeat(64),
		relays: ['ws://localhost:10547'],
		authorizedAt: now,
		lastActivityAt: now,
		...overrides,
	}
}

describe('goblin session window clocks', () => {
	beforeEach(() => {
		;(globalThis as any).localStorage = new MemoryStorage()
	})

	test('a fresh session is live under both clocks', () => {
		const now = 1_000_000_000_000
		const s = makeSession({ authorizedAt: now, lastActivityAt: now })
		expect(isSessionLive(s, now)).toBe(true)
		expect(isSessionLive(s, now + 5 * 60 * 1000)).toBe(true) // 5 min later
	})

	test('the idle clock expires 60 minutes after the last activity', () => {
		const now = 1_000_000_000_000
		// Authorized recently (well under the cap) but idle for just over 60 minutes.
		const s = makeSession({ authorizedAt: now, lastActivityAt: now })
		expect(isSessionLive(s, now + IDLE_TIMEOUT_MS - 1)).toBe(true)
		expect(isSessionLive(s, now + IDLE_TIMEOUT_MS)).toBe(false) // idle-expired
		expect(isSessionLive(s, now + IDLE_TIMEOUT_MS + 60_000)).toBe(false)
	})

	test('the absolute cap expires 8 hours after authorization even with recent activity', () => {
		const now = 1_000_000_000_000
		// Kept active the whole time (idle clock always fresh) but past the 8h cap.
		const capExpired = now + ABSOLUTE_CAP_MS
		const s = makeSession({ authorizedAt: now, lastActivityAt: capExpired - 1_000 })
		expect(isSessionLive(s, capExpired - 1)).toBe(true)
		expect(isSessionLive(s, capExpired)).toBe(false) // cap-expired
	})

	test('activity extends the idle clock but NEVER the absolute cap', () => {
		const now = 1_000_000_000_000
		// Authorized 7h ago (under the 8h cap), idle for ~59 minutes (about to lapse).
		const authorizedAt = now - 7 * 60 * 60 * 1000
		const s = makeSession({ authorizedAt, lastActivityAt: now - (IDLE_TIMEOUT_MS - 60_000) })
		expect(isSessionLive(s, now)).toBe(true)

		// A fresh interaction rolls the idle clock forward...
		const rolled = touchActivity(s, now)
		expect(rolled.lastActivityAt).toBe(now)
		expect(rolled.authorizedAt).toBe(authorizedAt) // cap origin untouched
		expect(isSessionLive(rolled, now + IDLE_TIMEOUT_MS - 1)).toBe(true)

		// ...but the 8h cap still governs: once it passes, no amount of activity keeps
		// the session alive.
		const capExpiry = authorizedAt + ABSOLUTE_CAP_MS
		const rolledAtCap = touchActivity(rolled, capExpiry) // "activity" exactly at the cap
		expect(isSessionLive(rolledAtCap, capExpiry)).toBe(false)
		expect(sessionDeadlines(rolledAtCap).expiresAt).toBe(capExpiry) // cap is the earlier clock
	})

	test('sessionDeadlines reports the earlier of the two clocks as the effective expiry', () => {
		const now = 1_000_000_000_000
		// Idle clock earlier: last activity recent, cap far away.
		const idleFirst = makeSession({ authorizedAt: now, lastActivityAt: now })
		expect(sessionDeadlines(idleFirst).expiresAt).toBe(now + IDLE_TIMEOUT_MS)

		// Cap clock earlier: authorized long ago, but active right up to now.
		const capFirst = makeSession({ authorizedAt: now - (ABSOLUTE_CAP_MS - 5 * 60_000), lastActivityAt: now })
		expect(sessionDeadlines(capFirst).expiresAt).toBe(capFirst.authorizedAt + ABSOLUTE_CAP_MS)
	})

	test('a clock reporting a time before authorization fails closed', () => {
		const now = 1_000_000_000_000
		const s = makeSession({ authorizedAt: now, lastActivityAt: now })
		expect(isSessionLive(s, now - 1)).toBe(false)
	})

	test('a non-finite timestamp is never live', () => {
		const s = makeSession({ authorizedAt: Number.NaN })
		expect(isSessionLive(s, Date.now())).toBe(false)
	})
})

describe('goblin session window persistence', () => {
	beforeEach(() => {
		;(globalThis as any).localStorage = new MemoryStorage()
	})

	test('save then load round-trips the persisted session', () => {
		const s = makeSession()
		savePersistedSession(s)
		expect(loadPersistedSession()).toEqual(s)
	})

	test('clear wipes the persisted session completely', () => {
		savePersistedSession(makeSession())
		clearPersistedSession()
		expect(loadPersistedSession()).toBeNull()
		expect(localStorage.getItem(GOBLIN_SESSION_WINDOW_KEY)).toBeNull()
	})

	test('a corrupt record self-evicts on load', () => {
		localStorage.setItem(GOBLIN_SESSION_WINDOW_KEY, '{not json')
		expect(loadPersistedSession()).toBeNull()
		expect(localStorage.getItem(GOBLIN_SESSION_WINDOW_KEY)).toBeNull()
	})

	test('a record from an older/unknown version is rejected and evicted', () => {
		localStorage.setItem(GOBLIN_SESSION_WINDOW_KEY, JSON.stringify({ ...makeSession(), v: 999 }))
		expect(loadPersistedSession()).toBeNull()
		expect(localStorage.getItem(GOBLIN_SESSION_WINDOW_KEY)).toBeNull()
	})

	test('a record missing required fields is rejected', () => {
		localStorage.setItem(GOBLIN_SESSION_WINDOW_KEY, JSON.stringify({ v: PERSISTED_SESSION_VERSION, identityPubkey: 'x' }))
		expect(loadPersistedSession()).toBeNull()
	})
})
