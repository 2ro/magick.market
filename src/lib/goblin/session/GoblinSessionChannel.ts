/**
 * Live encrypted relay channel for a Goblin trust session (spec section 5.1).
 *
 * The browser holds an ephemeral channel keypair; every sign request/response
 * is a NIP-44-encrypted, stored (NIP-40) event addressed between the site and
 * wallet session keys, carried on the hinted relay. This class owns:
 *   - the SimplePool subscription draining wallet -> site envelopes,
 *   - the pending-request map correlating a sign_result to its request id,
 *   - the "confirm in your wallet" pending signal (money tier or a backgrounded
 *     wallet keeps a request outstanding; the site must not assume silence),
 *   - the session-open handshake and the session-end teardown.
 *
 * Publishing is injectable so the request/response correlation is unit-testable
 * in-memory without a real relay (see the tests feeding wallet-sealed replies to
 * `handleEnvelope`).
 */

import { SimplePool } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import {
	conversationKey,
	GOBLIN_SESSION_CHANNEL_KIND,
	openEnvelope,
	sealEnvelope,
	toUnsignedComposedEvent,
	unixNow,
	uuid,
	withinSkew,
	type GoblinSessionErrorCode,
	type UnsignedComposedEvent,
} from './protocol'

/** A per-action refusal (spec section 7). Non-fatal for `user_declined`. */
export class GoblinSessionError extends Error {
	constructor(
		public readonly code: GoblinSessionErrorCode | 'channel_closed',
		message?: string,
	) {
		super(message ?? code)
		this.name = 'GoblinSessionError'
	}

	/** Errors that end the session: the site must fall back to a full re-login. */
	get endsSession(): boolean {
		return this.code === 'session_ended' || this.code === 'session_paused' || this.code === 'identity_mismatch'
	}
}

/** How long a request may wait for a wallet response before we give up (spec 7 timed_out). */
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000

/** Beyond this, a still-outstanding request means the wallet is prompting or asleep. */
const DEFAULT_CONFIRM_HINT_MS = 1_200

type PendingRequest = {
	resolve: (event: Event) => void
	reject: (error: GoblinSessionError) => void
	timeoutTimer: ReturnType<typeof setTimeout>
	confirmTimer: ReturnType<typeof setTimeout>
	countedAsPending: boolean
}

export interface GoblinSessionChannelOptions {
	/** The site's ephemeral channel keypair (never the identity key). */
	siteSessionKeys: { privateKey: Uint8Array; publicKey: string }
	/** The relays the channel runs on (site hint plus any wallet fallbacks). */
	relays: string[]
	/** Fired whenever the outstanding "confirm in your wallet" count changes. */
	onPendingChange?: (pendingConfirmCount: number) => void
	/** Fired when the wallet (or a fatal error) ends the session. */
	onSessionEnd?: (reason: string) => void
	/** Injectable publish for tests; defaults to the SimplePool. */
	publish?: (relays: string[], event: Event) => void
	/** Override the "confirm in your wallet" hint delay (ms). Testability. */
	confirmHintMs?: number
	/** Override the per-request timeout (ms). Testability. */
	requestTimeoutMs?: number
}

export class GoblinSessionChannel {
	private readonly siteSessionKeys: { privateKey: Uint8Array; publicKey: string }
	private readonly relays: string[]
	private readonly onPendingChange?: (count: number) => void
	private readonly onSessionEnd?: (reason: string) => void
	private readonly publishFn: (relays: string[], event: Event) => void
	private readonly confirmHintMs: number
	private readonly requestTimeoutMs: number

	private pool: SimplePool | null = null
	private sub: { close: () => void } | null = null

	private walletSessionPubkey: string | null = null
	private identityPubkey: string | null = null
	private convKey: Uint8Array | null = null

	private readonly pending = new Map<string, PendingRequest>()
	private pendingConfirmCount = 0
	private closed = false

	private sessionOpenResolve: ((info: { walletSessionPubkey: string; identityPubkey: string }) => void) | null = null

	constructor(options: GoblinSessionChannelOptions) {
		this.siteSessionKeys = options.siteSessionKeys
		this.relays = options.relays
		this.onPendingChange = options.onPendingChange
		this.onSessionEnd = options.onSessionEnd
		this.confirmHintMs = options.confirmHintMs ?? DEFAULT_CONFIRM_HINT_MS
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
		this.publishFn =
			options.publish ??
			((relays, event) => {
				if (!this.pool) this.pool = new SimplePool()
				for (const relay of relays) {
					try {
						void Promise.resolve(this.pool.publish([relay], event)).catch(() => {})
					} catch {
						// Best effort: a relay that rejects publish must not throw here.
					}
				}
			})
	}

	get siteSessionPubkey(): string {
		return this.siteSessionKeys.publicKey
	}

	get walletPubkey(): string | null {
		return this.walletSessionPubkey
	}

	get identity(): string | null {
		return this.identityPubkey
	}

	/**
	 * Subscribe on the channel relays and wait for the wallet's `session-open`
	 * envelope (spec 5.2 step 3). Resolves with the wallet session pubkey and the
	 * confirmed signing identity, at which point sign() is usable.
	 */
	async open(timeoutMs = this.requestTimeoutMs): Promise<{ walletSessionPubkey: string; identityPubkey: string }> {
		this.subscribe()
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.sessionOpenResolve = null
				reject(new GoblinSessionError('timed_out', 'The wallet did not open the session in time.'))
			}, timeoutMs)
			this.sessionOpenResolve = (info) => {
				clearTimeout(timer)
				resolve(info)
			}
		})
	}

	private subscribe(): void {
		if (this.sub || this.closed) return
		if (!this.pool) this.pool = new SimplePool()
		this.sub = this.pool.subscribeMany(
			this.relays,
			[{ kinds: [GOBLIN_SESSION_CHANNEL_KIND], '#p': [this.siteSessionKeys.publicKey] }] as never,
			{
				onevent: (event: Event) => this.handleEnvelope(event),
			},
		) as { close: () => void }
	}

	/**
	 * Decrypt and dispatch one wallet -> site envelope. Exposed for in-memory
	 * tests. Fails closed: an envelope that does not decrypt, is out of skew, or
	 * carries an unexpected sender is ignored (spec 5.8 origin binding).
	 */
	handleEnvelope(event: Event): void {
		if (this.closed) return
		if (event.kind !== GOBLIN_SESSION_CHANNEL_KIND) return
		if (!withinSkew(event.created_at, unixNow())) return

		// The first message is session-open, sealed by the wallet session key we do
		// not yet know. Derive the conversation key against the envelope pubkey and
		// try to open it. Once bound, only that pubkey may drive the channel.
		const senderConvKey = this.walletSessionPubkey ? this.convKey! : conversationKey(this.siteSessionKeys.privateKey, event.pubkey)
		if (this.walletSessionPubkey && event.pubkey !== this.walletSessionPubkey) return

		const payload = openEnvelope(event, senderConvKey!)
		if (!payload) return

		if (payload.type === 'session-open') {
			if (this.walletSessionPubkey) return // already open; ignore duplicates
			this.walletSessionPubkey = event.pubkey
			this.identityPubkey = payload.identity_pubkey
			this.convKey = senderConvKey!
			this.sessionOpenResolve?.({ walletSessionPubkey: event.pubkey, identityPubkey: payload.identity_pubkey })
			this.sessionOpenResolve = null
			return
		}

		if (payload.type === 'session-end') {
			this.teardown(payload.reason)
			return
		}

		if (payload.type === 'sign_result') {
			const req = this.pending.get(payload.id)
			if (!req) return // unknown or already-settled id
			this.settle(payload.id)
			if (payload.ok) {
				req.resolve(payload.event)
			} else {
				const error = new GoblinSessionError(payload.error)
				req.reject(error)
				if (error.endsSession) this.teardown(payload.error)
			}
		}
	}

	/**
	 * Route a client-composed event through the channel and return the wallet's
	 * signed event. `created_at` is pinned by the caller (NDK), never re-stamped
	 * here (spec finding A). Rejects with a GoblinSessionError on refusal.
	 */
	async sign(unsigned: UnsignedComposedEvent): Promise<Event> {
		if (this.closed) throw new GoblinSessionError('session_ended', 'The session has ended.')
		if (!this.walletSessionPubkey || !this.convKey) {
			throw new GoblinSessionError('channel_closed', 'The session channel is not open yet.')
		}

		const id = uuid()
		const envelope = sealEnvelope({
			payload: { type: 'sign', id, ts: unixNow(), event: toUnsignedComposedEvent(unsigned) },
			senderPrivateKey: this.siteSessionKeys.privateKey,
			recipientPublicKey: this.walletSessionPubkey,
			convKey: this.convKey,
		})

		return new Promise<Event>((resolve, reject) => {
			const timeoutTimer = setTimeout(() => {
				this.settle(id)
				reject(new GoblinSessionError('timed_out', 'Your wallet did not respond in time.'))
			}, this.requestTimeoutMs)

			// A request still outstanding past the hint delay means the wallet is
			// prompting (money tier) or backgrounded: surface "confirm in your wallet".
			const confirmTimer = setTimeout(() => {
				const req = this.pending.get(id)
				if (req && !req.countedAsPending) {
					req.countedAsPending = true
					this.pendingConfirmCount += 1
					this.onPendingChange?.(this.pendingConfirmCount)
				}
			}, this.confirmHintMs)

			this.pending.set(id, { resolve, reject, timeoutTimer, confirmTimer, countedAsPending: false })
			this.publishFn(this.relays, envelope)
		})
	}

	private settle(id: string): void {
		const req = this.pending.get(id)
		if (!req) return
		clearTimeout(req.timeoutTimer)
		clearTimeout(req.confirmTimer)
		this.pending.delete(id)
		if (req.countedAsPending) {
			this.pendingConfirmCount = Math.max(0, this.pendingConfirmCount - 1)
			this.onPendingChange?.(this.pendingConfirmCount)
		}
	}

	/** Send the site's logout signal (spec section 6, item 1), then close. */
	end(reason: 'logout' | 'revoked' | 'expired' = 'logout'): void {
		if (!this.closed && this.walletSessionPubkey && this.convKey) {
			try {
				const envelope = sealEnvelope({
					payload: { type: 'session-end', id: uuid(), reason },
					senderPrivateKey: this.siteSessionKeys.privateKey,
					recipientPublicKey: this.walletSessionPubkey,
					convKey: this.convKey,
				})
				this.publishFn(this.relays, envelope)
			} catch {
				// A best-effort logout signal; local teardown still happens below.
			}
		}
		this.teardown(reason)
	}

	private teardown(reason: string): void {
		if (this.closed) return
		this.closed = true
		this.pending.forEach((req) => {
			clearTimeout(req.timeoutTimer)
			clearTimeout(req.confirmTimer)
			req.reject(new GoblinSessionError('session_ended', 'The session ended.'))
		})
		this.pending.clear()
		this.pendingConfirmCount = 0
		try {
			this.sub?.close()
		} catch {
			// ignore
		}
		this.sub = null
		try {
			this.pool?.close(this.relays)
		} catch {
			// ignore
		}
		this.pool = null
		this.onSessionEnd?.(reason)
	}

	get isClosed(): boolean {
		return this.closed
	}
}
