/**
 * Goblin trust session store (magick side of Authorize Sessions).
 *
 * Holds the browser-visible session state the UI renders: whether a session is
 * being established, live, waiting on a wallet money-tier confirm, or ended (so
 * the UI can offer a clear re-login affordance rather than a silent hang). The
 * live channel and signer instances are module singletons (not serializable).
 *
 * Refresh survival (owner-finalised, 2026-07-09): the MINIMAL channel state (the
 * ephemeral channel key, the wallet session pubkey, the identity, the relays) is
 * persisted CLIENT-SIDE in localStorage alongside a dual clock (60-minute rolling
 * idle timeout + 8-hour absolute cap). On boot, restore() rebinds the channel if
 * BOTH clocks still pass; an expired record is wiped, never used. Nothing is ever
 * written to a relay or server. See sessionWindow.ts for the clock + storage.
 */

import { Store } from '@tanstack/store'
import { bytesToHex } from '@noble/hashes/utils.js'
import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from 'nostr-tools/utils'
import { getMainRelay } from './ndk'
import { GoblinSessionChannel } from '@/lib/goblin/session/GoblinSessionChannel'
import { GoblinAuthorizeSigner } from '@/lib/goblin/session/GoblinAuthorizeSigner'
import { buildTrustUri, generateChannelKeypair, MAGICK_LOW_TIER_KINDS } from '@/lib/goblin/session/protocol'
import {
	clearPersistedSession,
	isSessionLive,
	loadPersistedSession,
	savePersistedSession,
	sessionDeadlines,
	touchActivity,
	type PersistedGoblinSession,
} from '@/lib/goblin/session/sessionWindow'

export type GoblinSessionStatus =
	| 'idle' // no session
	| 'establishing' // channel open, waiting for the wallet's session-open
	| 'active' // live, silent signs served
	| 'confirm' // a sign is outstanding: "confirm in your wallet"
	| 'ended' // wallet revoked / expired / logout: offer re-login
	| 'error'

export interface GoblinSessionState {
	status: GoblinSessionStatus
	domain: string | null
	identityPubkey: string | null
	pendingConfirmCount: number
	endedReason: string | null
}

const initialState: GoblinSessionState = {
	status: 'idle',
	domain: null,
	identityPubkey: null,
	pendingConfirmCount: 0,
	endedReason: null,
}

export const goblinSessionStore = new Store<GoblinSessionState>(initialState)

// Module singletons: the live channel and the signer bound to it. Never persisted.
let activeChannel: GoblinSessionChannel | null = null
let activeSigner: GoblinAuthorizeSigner | null = null

// Tears down the foreground/reconnect resync wiring for the current establishing
// channel (listeners + poll). Set while status is 'establishing', cleared on bind,
// timeout, or any local teardown so listeners never leak across sessions.
let stopResyncWiring: (() => void) | null = null

/** How often the foreground poll re-pulls the stored session-open while establishing. */
const RESYNC_POLL_MS = 2_000

/**
 * While the trust channel is still establishing, drive channel.resync() whenever
 * the page returns to the foreground or the network reconnects. This is the
 * same-device mobile fix: tapping "Open in Goblin" suspends the browser tab and
 * tears down its relay socket; the wallet publishes session-open into that gap,
 * and on resume nostr-tools never re-issues the REQ. Each trigger does a fresh
 * one-shot pull that reconnects the relay and drains the stored open. DOM-only, so
 * it lives here (the channel stays DOM-free for its in-memory tests). Returns a
 * cleanup that removes every listener and stops the poll; idempotent.
 */
function startResyncWiring(channel: GoblinSessionChannel): () => void {
	if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}

	const fire = () => {
		if (channel.isClosed) return
		void channel.resync().catch(() => {})
	}
	const onVisible = () => {
		if (document.visibilityState === 'visible') fire()
	}

	document.addEventListener('visibilitychange', onVisible)
	window.addEventListener('online', fire)
	window.addEventListener('focus', fire)

	// A foreground poll backstops any SimplePool reconnect quirk: even if no
	// visibility/focus/online event fires, we keep re-pulling until bound. The
	// open() timeout ends the establishing state, and teardown clears this poll.
	const poll = setInterval(fire, RESYNC_POLL_MS)

	let stopped = false
	return () => {
		if (stopped) return
		stopped = true
		clearInterval(poll)
		document.removeEventListener('visibilitychange', onVisible)
		window.removeEventListener('online', fire)
		window.removeEventListener('focus', fire)
	}
}

/** Tear down any live resync wiring (safe to call when none is active). */
function clearResyncWiring(): void {
	stopResyncWiring?.()
	stopResyncWiring = null
}

// The persisted window record backing the live channel (source of truth for the
// two clocks). Kept in memory so activity can roll the idle clock without a read.
let activeWindow: PersistedGoblinSession | null = null

/** Fires when the earlier of the two clocks elapses; ends signing (spec: window). */
let expiryTimer: ReturnType<typeof setTimeout> | null = null

/** Throttle idle-clock writes: at most one persisted bump per interval. */
const ACTIVITY_THROTTLE_MS = 30_000
let lastActivityWrite = 0
let activityTracking = false

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'visibilitychange'] as const

/** Resolve the relay(s) the channel runs on: the app main relay is the hint. */
function resolveChannelRelays(): { hint: string; relays: string[] } {
	const hint = getMainRelay() ?? 'ws://localhost:10547'
	return { hint, relays: [hint] }
}

/** Shared "confirm in your wallet" pending handler for begin and restore. */
function handlePendingChange(count: number): void {
	goblinSessionStore.setState((s) => ({
		...s,
		pendingConfirmCount: count,
		status: s.status === 'ended' || s.status === 'error' ? s.status : count > 0 ? 'confirm' : 'active',
	}))
}

/** Shared session-end handler: the wallet (or a fatal error) ended it. Wipe and mark ended. */
function handleSessionEnd(reason: string): void {
	clearResyncWiring()
	activeChannel = null
	activeSigner = null
	activeWindow = null
	stopActivityTracking()
	clearExpiryTimer()
	clearPersistedSession()
	goblinSessionStore.setState((s) => ({ ...s, status: 'ended', endedReason: reason, pendingConfirmCount: 0 }))
}

function clearExpiryTimer(): void {
	if (expiryTimer) {
		clearTimeout(expiryTimer)
		expiryTimer = null
	}
}

/**
 * Arm the expiry timer at the EARLIER of the idle deadline and the absolute cap.
 * On fire we re-check both clocks (guards a clock jump / a since-refreshed idle)
 * before ending: a live session just re-arms, an expired one degrades to view-only.
 */
function scheduleExpiry(): void {
	clearExpiryTimer()
	if (!activeWindow) return
	const now = Date.now()
	const { expiresAt } = sessionDeadlines(activeWindow)
	const delay = Math.max(0, expiresAt - now)
	expiryTimer = setTimeout(() => {
		expiryTimer = null
		if (activeWindow && isSessionLive(activeWindow, Date.now())) {
			scheduleExpiry() // idle rolled forward under us; re-arm for the new deadline
			return
		}
		goblinSessionActions.endActiveSession('expired')
	}, delay)
}

/** Roll the idle clock on meaningful activity (throttled), then re-arm expiry. */
function noteActivity(): void {
	if (!activeWindow) return
	const now = Date.now()
	// If the session already lapsed (e.g. tab slept past a clock), don't resurrect
	// it: let the expiry path degrade to view-only.
	if (!isSessionLive(activeWindow, now)) {
		goblinSessionActions.endActiveSession('expired')
		return
	}
	if (now - lastActivityWrite < ACTIVITY_THROTTLE_MS) return
	lastActivityWrite = now
	activeWindow = touchActivity(activeWindow, now)
	savePersistedSession(activeWindow)
	scheduleExpiry()
}

function startActivityTracking(): void {
	if (activityTracking || typeof window === 'undefined') return
	activityTracking = true
	for (const evt of ACTIVITY_EVENTS) {
		window.addEventListener(evt, noteActivity, { passive: true })
	}
}

function stopActivityTracking(): void {
	if (!activityTracking || typeof window === 'undefined') return
	activityTracking = false
	for (const evt of ACTIVITY_EVENTS) {
		window.removeEventListener(evt, noteActivity)
	}
}

export const goblinSessionActions = {
	/**
	 * Begin a trust grant: generate the site's ephemeral channel keypair, open the
	 * relay subscription, and return the `goblin:trust` URI to deep-link / QR plus
	 * a promise that resolves once the wallet sends `session-open`. The caller
	 * (GoblinLogin) shows the URI, and on `ready` attaches the authorize signer.
	 */
	beginTrust(params: { challenge: string; domain: string; callbackUrl: string }): {
		uri: string
		ready: Promise<{ identityPubkey: string }>
	} {
		goblinSessionActions.teardownLocal()

		const siteSessionKeys = generateChannelKeypair()
		const { hint, relays } = resolveChannelRelays()

		// P2-2 (channel hijack race): before the channel binds to a session-open,
		// cross-check its declared identity against the server login callback the
		// wallet fired at approval (spec 4.3 step 1 completes before the channel
		// opens). A forged session-open racing on the relay cannot make the server
		// report its identity for our challenge nonce, so it never binds.
		const verifyIdentity = async (identityPubkey: string): Promise<boolean> => {
			const res = await fetch(`/api/v1/login/status?c=${params.challenge}`)
			if (!res.ok) return false
			const data = (await res.json()) as { status: string; pubkey?: string }
			return data.status === 'ok' && data.pubkey === identityPubkey
		}

		const channel = new GoblinSessionChannel({
			siteSessionKeys,
			relays,
			verifyIdentity,
			onPendingChange: handlePendingChange,
			onSessionEnd: handleSessionEnd,
		})
		activeChannel = channel

		// Drive resync on foreground/reconnect while we wait for session-open (mobile
		// same-device fix). Torn down the moment the channel binds, times out, or is
		// replaced, so listeners never outlive the establishing window.
		stopResyncWiring = startResyncWiring(channel)

		goblinSessionStore.setState(() => ({
			...initialState,
			status: 'establishing',
			domain: params.domain,
		}))

		const uri = buildTrustUri({
			challenge: params.challenge,
			domain: params.domain,
			callbackUrl: params.callbackUrl,
			siteSessionPubkey: siteSessionKeys.publicKey,
			relayHint: hint,
			kinds: MAGICK_LOW_TIER_KINDS,
		})

		const ready = channel.open().then(({ walletSessionPubkey, identityPubkey }) => {
			clearResyncWiring() // bound: stop foreground resyncing
			const signer = new GoblinAuthorizeSigner(channel, identityPubkey)
			activeSigner = signer

			// Persist the resumable window: the ephemeral channel key (NOT the
			// identity key), the wallet session pubkey, the identity, and the relays,
			// with both clocks started now. This is what a refresh restores.
			const now = Date.now()
			activeWindow = {
				v: 1,
				siteSessionPrivateKey: bytesToHex(siteSessionKeys.privateKey),
				walletSessionPubkey,
				identityPubkey,
				relays,
				authorizedAt: now,
				lastActivityAt: now,
			}
			lastActivityWrite = now
			savePersistedSession(activeWindow)
			startActivityTracking()
			scheduleExpiry()

			goblinSessionStore.setState((s) => ({ ...s, status: 'active', identityPubkey }))
			return { identityPubkey }
		})

		// A failed / timed-out open surfaces as an error state, not an unhandled reject.
		ready.catch(() => {
			clearResyncWiring() // timed out / errored: stop foreground resyncing
			goblinSessionStore.setState((s) => (s.status === 'establishing' ? { ...s, status: 'error' } : s))
		})

		return { uri, ready }
	},

	/**
	 * Restore a signing session from persisted state after a refresh (spec: client
	 * session window). Returns the identity + a live signer ONLY if BOTH clocks
	 * still pass; otherwise the record is wiped and null is returned so the caller
	 * degrades to a view-only wallet session (canSign stays false). Rebinds the
	 * channel directly to the persisted wallet session key (no fresh handshake):
	 * the wallet's Authorize Sessions is still holding it open.
	 */
	restore(): { identityPubkey: string; signer: GoblinAuthorizeSigner } | null {
		const persisted = loadPersistedSession()
		if (!persisted) return null

		// Expired by EITHER clock: wipe completely and do not resume.
		if (!isSessionLive(persisted, Date.now())) {
			clearPersistedSession()
			return null
		}

		goblinSessionActions.teardownLocal()

		let siteSessionPrivateKey: Uint8Array
		let publicKey: string
		try {
			siteSessionPrivateKey = hexToBytes(persisted.siteSessionPrivateKey)
			publicKey = getPublicKey(siteSessionPrivateKey)
		} catch {
			clearPersistedSession()
			return null
		}

		const channel = new GoblinSessionChannel({
			siteSessionKeys: { privateKey: siteSessionPrivateKey, publicKey },
			relays: persisted.relays,
			onPendingChange: handlePendingChange,
			onSessionEnd: handleSessionEnd,
		})
		channel.resume({ walletSessionPubkey: persisted.walletSessionPubkey, identityPubkey: persisted.identityPubkey })
		activeChannel = channel

		const signer = new GoblinAuthorizeSigner(channel, persisted.identityPubkey)
		activeSigner = signer

		// Keep the persisted clocks as-is (the absolute cap never moves; the idle
		// clock resumes where it left off and only rolls on fresh activity).
		activeWindow = persisted
		lastActivityWrite = persisted.lastActivityAt
		startActivityTracking()
		scheduleExpiry()

		goblinSessionStore.setState(() => ({
			...initialState,
			status: 'active',
			domain: null,
			identityPubkey: persisted.identityPubkey,
		}))

		return { identityPubkey: persisted.identityPubkey, signer }
	},

	/** The live signer, once the session is active (for auth wiring). */
	getSigner(): GoblinAuthorizeSigner | null {
		return activeSigner
	},

	getChannel(): GoblinSessionChannel | null {
		return activeChannel
	},

	isActive(): boolean {
		return activeChannel !== null && !activeChannel.isClosed && activeSigner !== null
	},

	/** Send the logout signal and tear the channel down (spec section 6, item 1). */
	endActiveSession(reason: 'logout' | 'revoked' | 'expired' = 'logout'): void {
		clearResyncWiring()
		if (activeChannel && !activeChannel.isClosed) {
			activeChannel.end(reason)
		}
		activeChannel = null
		activeSigner = null
		activeWindow = null
		stopActivityTracking()
		clearExpiryTimer()
		clearPersistedSession()
		goblinSessionStore.setState(() => ({ ...initialState }))
	},

	/** Drop local channel/signer without a logout signal (e.g. before a fresh grant). */
	teardownLocal(): void {
		clearResyncWiring()
		if (activeChannel && !activeChannel.isClosed) {
			try {
				activeChannel.end('logout')
			} catch {
				// ignore
			}
		}
		activeChannel = null
		activeSigner = null
		activeWindow = null
		stopActivityTracking()
		clearExpiryTimer()
	},

	/** Wipe any persisted window (e.g. a real signer login supersedes the wallet session). */
	clearPersisted(): void {
		activeWindow = null
		stopActivityTracking()
		clearExpiryTimer()
		clearPersistedSession()
	},

	/** Reset to idle after the user acknowledges an ended session (re-login flow). */
	reset(): void {
		goblinSessionActions.teardownLocal()
		clearPersistedSession()
		goblinSessionStore.setState(() => ({ ...initialState }))
	},
}
