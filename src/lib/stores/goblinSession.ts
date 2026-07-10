/**
 * Goblin trust session store (magick side of Authorize Sessions).
 *
 * Holds the browser-visible session state the UI renders: whether a session is
 * being established, live, waiting on a wallet money-tier confirm, or ended (so
 * the UI can offer a clear re-login affordance rather than a silent hang). The
 * live channel and signer instances are module singletons (not serializable, and
 * in-memory only: restart equals end, spec section 6).
 */

import { Store } from '@tanstack/store'
import { getMainRelay } from './ndk'
import { GoblinSessionChannel } from '@/lib/goblin/session/GoblinSessionChannel'
import { GoblinAuthorizeSigner } from '@/lib/goblin/session/GoblinAuthorizeSigner'
import { buildTrustUri, generateChannelKeypair, MAGICK_LOW_TIER_KINDS } from '@/lib/goblin/session/protocol'

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

/** Resolve the relay(s) the channel runs on: the app main relay is the hint. */
function resolveChannelRelays(): { hint: string; relays: string[] } {
	const hint = getMainRelay() ?? 'ws://localhost:10547'
	return { hint, relays: [hint] }
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
			onPendingChange: (count) => {
				goblinSessionStore.setState((s) => ({
					...s,
					pendingConfirmCount: count,
					status: s.status === 'ended' || s.status === 'error' ? s.status : count > 0 ? 'confirm' : 'active',
				}))
			},
			onSessionEnd: (reason) => {
				clearResyncWiring()
				activeChannel = null
				activeSigner = null
				goblinSessionStore.setState((s) => ({ ...s, status: 'ended', endedReason: reason, pendingConfirmCount: 0 }))
			},
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

		const ready = channel.open().then(({ identityPubkey }) => {
			clearResyncWiring() // bound: stop foreground resyncing
			const signer = new GoblinAuthorizeSigner(channel, identityPubkey)
			activeSigner = signer
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
	},

	/** Reset to idle after the user acknowledges an ended session (re-login flow). */
	reset(): void {
		goblinSessionActions.teardownLocal()
		goblinSessionStore.setState(() => ({ ...initialState }))
	},
}
