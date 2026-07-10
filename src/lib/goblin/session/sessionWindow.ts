/**
 * Client-side signing-session window (owner-finalised, 2026-07-09).
 *
 * The "Sign in with Goblin" trust session used to live only in memory, so a page
 * refresh lost the live channel and degraded to view-only, forcing a fresh wallet
 * authorisation every time. This module makes the session survive a refresh
 * ENTIRELY CLIENT-SIDE by persisting the minimal channel state (never an identity
 * key) plus a dual clock:
 *
 *   - a 60-minute IDLE timeout that rolls forward on meaningful user activity, and
 *   - an 8-hour ABSOLUTE cap from the original authorisation that never extends.
 *
 * Whichever clock expires first ends the signing capability; the app then degrades
 * exactly as before (view-only, wallet re-authorisation required). Nothing here is
 * ever written to a relay or a server: state lives in localStorage so it survives
 * a tab close within the window, and is wiped completely on expiry or logout.
 *
 * Everything in this file is pure / storage-only and unit-tested without a relay.
 */

/** Rolling idle timeout: activity within the window pushes it forward. */
export const IDLE_TIMEOUT_MS = 60 * 60 * 1000 // 60 minutes

/** Hard cap measured from the original authorisation. NEVER extendable. */
export const ABSOLUTE_CAP_MS = 8 * 60 * 60 * 1000 // 8 hours

/** localStorage key holding the persisted, resumable trust session. */
export const GOBLIN_SESSION_WINDOW_KEY = 'goblin_session_window'

/** Bump when the persisted shape changes so stale records self-evict on load. */
export const PERSISTED_SESSION_VERSION = 1

/**
 * The minimal state needed to re-establish the signing channel after a refresh.
 *
 * `siteSessionPrivateKey` is the browser's EPHEMERAL channel key (spec 5.2 step 1),
 * NOT the user's identity key: the identity key never leaves the wallet, and the
 * channel private key only signs relay envelopes addressed to the wallet session
 * key. Persisting it (with the wallet session pubkey it is paired with) is exactly
 * what lets the wallet's "Authorize Sessions" resume the same channel after a
 * reload. The identity key is never stored, on-device or otherwise.
 */
export interface PersistedGoblinSession {
	v: typeof PERSISTED_SESSION_VERSION
	/** Ephemeral channel private key (hex). Never the identity key. */
	siteSessionPrivateKey: string
	/** The wallet's session pubkey learned from `session-open` (hex). */
	walletSessionPubkey: string
	/** The confirmed signing identity pubkey (hex). */
	identityPubkey: string
	/** The relay(s) the channel runs on. */
	relays: string[]
	/** Epoch ms of the original authorisation. Fixed for the whole session. */
	authorizedAt: number
	/** Epoch ms of the last meaningful activity. Rolls the idle clock. */
	lastActivityAt: number
}

/** Absolute (cap) and idle deadlines in epoch ms, and the effective (earlier) end. */
export interface SessionDeadlines {
	absoluteExpiresAt: number
	idleExpiresAt: number
	/** Whichever clock ends first governs the session. */
	expiresAt: number
}

/** Compute both clock deadlines and the effective (earliest) expiry. */
export function sessionDeadlines(s: Pick<PersistedGoblinSession, 'authorizedAt' | 'lastActivityAt'>): SessionDeadlines {
	const absoluteExpiresAt = s.authorizedAt + ABSOLUTE_CAP_MS
	const idleExpiresAt = s.lastActivityAt + IDLE_TIMEOUT_MS
	return { absoluteExpiresAt, idleExpiresAt, expiresAt: Math.min(absoluteExpiresAt, idleExpiresAt) }
}

/**
 * Is the session still within BOTH clocks at `now`? A session is live only while
 * it is under the absolute cap AND inside the rolling idle window. Either clock
 * lapsing (or a nonsensical/forward-dated record) makes it dead.
 */
export function isSessionLive(s: Pick<PersistedGoblinSession, 'authorizedAt' | 'lastActivityAt'>, now: number = Date.now()): boolean {
	if (!Number.isFinite(s.authorizedAt) || !Number.isFinite(s.lastActivityAt)) return false
	// A clock that reports a time before the session began is untrustworthy: fail closed.
	if (now < s.authorizedAt) return false
	const { expiresAt } = sessionDeadlines(s)
	return now < expiresAt
}

/**
 * Return a copy with the idle clock rolled to `now`. The absolute cap
 * (`authorizedAt`) is intentionally left untouched: activity extends idle but can
 * NEVER extend the 8-hour cap. Activity at or beyond the cap is a no-op for the
 * cap, so `isSessionLive` still returns false once the cap has passed.
 */
export function touchActivity(s: PersistedGoblinSession, now: number = Date.now()): PersistedGoblinSession {
	return { ...s, lastActivityAt: now }
}

/** True when the record has the exact shape we persist (defensive on load). */
function isPersistedGoblinSession(value: unknown): value is PersistedGoblinSession {
	if (!value || typeof value !== 'object') return false
	const s = value as Record<string, unknown>
	return (
		s.v === PERSISTED_SESSION_VERSION &&
		typeof s.siteSessionPrivateKey === 'string' &&
		typeof s.walletSessionPubkey === 'string' &&
		typeof s.identityPubkey === 'string' &&
		Array.isArray(s.relays) &&
		s.relays.every((r) => typeof r === 'string') &&
		typeof s.authorizedAt === 'number' &&
		typeof s.lastActivityAt === 'number'
	)
}

function storage(): Storage | null {
	try {
		if (typeof localStorage === 'undefined') return null
		return localStorage
	} catch {
		return null
	}
}

/** Load and validate the persisted session, or null if absent/corrupt/unavailable. */
export function loadPersistedSession(): PersistedGoblinSession | null {
	const store = storage()
	if (!store) return null
	try {
		const raw = store.getItem(GOBLIN_SESSION_WINDOW_KEY)
		if (!raw) return null
		const parsed = JSON.parse(raw) as unknown
		if (!isPersistedGoblinSession(parsed)) {
			store.removeItem(GOBLIN_SESSION_WINDOW_KEY)
			return null
		}
		return parsed
	} catch {
		// Corrupt JSON / quota: treat as no session.
		try {
			store.removeItem(GOBLIN_SESSION_WINDOW_KEY)
		} catch {
			// ignore
		}
		return null
	}
}

/** Persist the resumable session (best effort; private-mode / quota just skips it). */
export function savePersistedSession(session: PersistedGoblinSession): void {
	const store = storage()
	if (!store) return
	try {
		store.setItem(GOBLIN_SESSION_WINDOW_KEY, JSON.stringify(session))
	} catch {
		// Best effort: refresh-survival is a nicety, never a correctness requirement.
	}
}

/** Wipe the persisted session completely (expiry or explicit logout). */
export function clearPersistedSession(): void {
	const store = storage()
	if (!store) return
	try {
		store.removeItem(GOBLIN_SESSION_WINDOW_KEY)
	} catch {
		// ignore
	}
}
