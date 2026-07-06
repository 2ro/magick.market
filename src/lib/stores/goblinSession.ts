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

		const channel = new GoblinSessionChannel({
			siteSessionKeys,
			relays,
			onPendingChange: (count) => {
				goblinSessionStore.setState((s) => ({
					...s,
					pendingConfirmCount: count,
					status: s.status === 'ended' || s.status === 'error' ? s.status : count > 0 ? 'confirm' : 'active',
				}))
			},
			onSessionEnd: (reason) => {
				activeChannel = null
				activeSigner = null
				goblinSessionStore.setState((s) => ({ ...s, status: 'ended', endedReason: reason, pendingConfirmCount: 0 }))
			},
		})
		activeChannel = channel

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
			const signer = new GoblinAuthorizeSigner(channel, identityPubkey)
			activeSigner = signer
			goblinSessionStore.setState((s) => ({ ...s, status: 'active', identityPubkey }))
			return { identityPubkey }
		})

		// A failed / timed-out open surfaces as an error state, not an unhandled reject.
		ready.catch(() => {
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
		if (activeChannel && !activeChannel.isClosed) {
			activeChannel.end(reason)
		}
		activeChannel = null
		activeSigner = null
		goblinSessionStore.setState(() => ({ ...initialState }))
	},

	/** Drop local channel/signer without a logout signal (e.g. before a fresh grant). */
	teardownLocal(): void {
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
