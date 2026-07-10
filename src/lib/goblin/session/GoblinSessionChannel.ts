/**
 * Live encrypted relay channel for a Goblin trust session (spec section 5.1).
 *
 * The browser holds an ephemeral channel keypair; every request/response (sign,
 * encrypt, decrypt) is a NIP-44-encrypted, stored (NIP-40) event addressed
 * between the site and wallet session keys, carried on the hinted relay. This
 * class owns:
 *   - the SimplePool subscription draining wallet -> site envelopes,
 *   - the pending-request map correlating each result to its request id,
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
	type ChannelPayload,
	type ChannelResultPayload,
	type GoblinSessionErrorCode,
	type UnsignedComposedEvent,
} from './protocol'

/**
 * Human copy per refusal code (spec section 7's "what the site shows"). These
 * become Error.message, so surfaces that toast a caught error (e.g. the listing
 * publish mutation's onError) show honest copy instead of a raw code.
 */
const ERROR_COPY: Record<GoblinSessionErrorCode | 'channel_closed', string> = {
	user_declined: 'You declined this action in your wallet.',
	kind_not_in_session: 'This action is not covered by your session. Sign in again to extend it.',
	identity_mismatch: 'Signed-in identity changed. Please sign in again.',
	stale_request: 'Your device clock looks off, or the request took too long. Retry.',
	too_large: 'That request was too large to sign.',
	session_paused: 'Your wallet paused signing for this site. Resume it in the wallet or sign in again.',
	session_ended: 'Your session ended. Please sign in again.',
	timed_out: 'Your wallet did not respond in time. Retry.',
	channel_closed: 'The session channel is not open yet.',
}

/** A per-action refusal (spec section 7). Non-fatal for `user_declined`. */
export class GoblinSessionError extends Error {
	constructor(
		public readonly code: GoblinSessionErrorCode | 'channel_closed',
		message?: string,
	) {
		super(message ?? ERROR_COPY[code] ?? code)
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

/** An ok answer from the wallet, narrowed by the caller (sign/encrypt/decrypt). */
type OkResultPayload = Extract<ChannelResultPayload, { ok: true }>

type PendingRequest = {
	resolve: (result: OkResultPayload) => void
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
	/**
	 * P2-2 (channel hijack race): a session-open only binds the channel if this
	 * verifier confirms its identity_pubkey against an out-of-band authority (the
	 * server login callback the wallet already fired). An attacker who races a
	 * forged session-open cannot pass this check, so it never becomes the channel
	 * peer; the channel keeps listening for the genuine open until the trust flow
	 * times out. Defaults to accept (tests); production always supplies one.
	 */
	verifyIdentity?: (identityPubkey: string) => Promise<boolean>
}

export class GoblinSessionChannel {
	private readonly siteSessionKeys: { privateKey: Uint8Array; publicKey: string }
	private readonly relays: string[]
	private readonly onPendingChange?: (count: number) => void
	private readonly onSessionEnd?: (reason: string) => void
	private readonly publishFn: (relays: string[], event: Event) => void
	private readonly confirmHintMs: number
	private readonly requestTimeoutMs: number
	private readonly verifyIdentity?: (identityPubkey: string) => Promise<boolean>

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
		this.verifyIdentity = options.verifyIdentity
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

	/**
	 * The channel's one filter: stored, addressed session envelopes tagged to our
	 * ephemeral site session pubkey. Built as an explicit, well-formed object every
	 * time. nostr-tools 2.x `subscribeMany`/`querySync` take a single `Filter`
	 * OBJECT (not an array); passing an array here makes SimplePool emit a REQ whose
	 * filter element is itself an array, which strfry rejects as "provided filter is
	 * not an object" (it never returns the stored session-open, so the login hangs).
	 */
	private channelFilter(): { kinds: number[]; '#p': string[] } {
		return { kinds: [GOBLIN_SESSION_CHANNEL_KIND], '#p': [this.siteSessionKeys.publicKey] }
	}

	/**
	 * Re-establish a channel that was already bound in an earlier page load, from
	 * persisted state (spec: client-side session window). Unlike open(), this does
	 * NOT wait for a fresh `session-open`: the wallet's "Authorize Sessions" is
	 * still holding the same session open, so we rebind directly to the known
	 * wallet session key, derive the conversation key, and start listening for
	 * results. Idempotent-safe: a no-op if already bound or closed.
	 */
	resume(bind: { walletSessionPubkey: string; identityPubkey: string }): void {
		if (this.closed || this.walletSessionPubkey) return
		this.walletSessionPubkey = bind.walletSessionPubkey
		this.identityPubkey = bind.identityPubkey
		this.convKey = conversationKey(this.siteSessionKeys.privateKey, bind.walletSessionPubkey)
		this.subscribe()
	}

	private subscribe(): void {
		if (this.sub || this.closed) return
		if (!this.pool) this.pool = new SimplePool()
		this.sub = this.pool.subscribeMany(this.relays, this.channelFilter() as never, {
			onevent: (event: Event) => this.handleEnvelope(event),
		}) as { close: () => void }
	}

	/**
	 * One-shot re-pull of the stored session-open, feeding each hit back through the
	 * idempotent handleEnvelope(). This is the same-device mobile fix: when the
	 * browser tab is suspended for the wallet deep-link, its live relay socket is
	 * torn down and SimplePool never re-issues the REQ on resume, so the wallet's
	 * already-stored session-open is never delivered and open() hangs on "Waiting
	 * for your wallet". querySync opens a fresh subscription (reconnecting the
	 * relay) and drains the stored event; handleEnvelope dedupes and runs
	 * tryBind -> verifyIdentity -> bind, so calling this repeatedly is safe. No-op
	 * once the channel is bound or closed.
	 */
	async resync(): Promise<void> {
		if (this.closed || this.walletSessionPubkey) return
		if (!this.pool) this.pool = new SimplePool()
		let events: Event[]
		try {
			events = await this.pool.querySync(this.relays, this.channelFilter() as never)
		} catch {
			return // a failed one-shot pull is best-effort; the next resync retries
		}
		for (const event of events) {
			if (this.closed || this.walletSessionPubkey) break
			this.handleEnvelope(event)
		}
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
			// P2-2: do NOT bind to the first openable session-open. Verify its
			// declared identity against the server-confirmed login pubkey first; a
			// forged open (attacker racing with the site channel pubkey) fails the
			// check and is dropped, and we keep listening for the genuine one.
			void this.tryBind(event.pubkey, senderConvKey!, payload.identity_pubkey)
			return
		}

		// Pre-bind, only session-open is meaningful: an unbound channel must not
		// let an arbitrary sender tear it down or answer requests (P2-2 hardening).
		if (!this.walletSessionPubkey) return

		if (payload.type === 'session-end') {
			// Tolerate a wallet that omits the reason field (cosmetic audit note):
			// UI copy must never render "undefined".
			this.teardown(payload.reason ?? 'ended')
			return
		}

		if (payload.type === 'sign_result' || payload.type === 'encrypt_result' || payload.type === 'decrypt_result') {
			const req = this.pending.get(payload.id)
			if (!req) return // unknown or already-settled id
			this.settle(payload.id)
			if (payload.ok) {
				req.resolve(payload)
			} else {
				const error = new GoblinSessionError(payload.error)
				req.reject(error)
				if (error.endsSession) this.teardown(payload.error)
			}
		}
	}

	/**
	 * Verify a candidate session-open's identity, then bind the channel to that
	 * wallet session key if (and only if) verification passed and nothing else
	 * bound first. A rejected or errored verification drops the candidate and
	 * leaves the channel listening; the open() timeout is the honest failure path
	 * if a genuine session-open never arrives (P2-2).
	 */
	private async tryBind(walletSessionPubkey: string, convKey: Uint8Array, identityPubkey: string): Promise<void> {
		let verified = true
		if (this.verifyIdentity) {
			try {
				verified = await this.verifyIdentity(identityPubkey)
			} catch {
				verified = false // fail closed: an unverifiable open never binds
			}
		}
		if (!verified) return
		if (this.closed || this.walletSessionPubkey) return // raced by a genuine bind or teardown

		this.walletSessionPubkey = walletSessionPubkey
		this.identityPubkey = identityPubkey
		this.convKey = convKey
		this.sessionOpenResolve?.({ walletSessionPubkey, identityPubkey })
		this.sessionOpenResolve = null
	}

	/**
	 * Publish one request envelope and await the wallet's correlated result. All
	 * three ops (sign, encrypt, decrypt) share this machinery, including the
	 * "confirm in your wallet" pending signal: the wallet may pause ANY of them on
	 * its money-tier prompt (an encrypt's plaintext can commit a payment).
	 */
	private async request(build: (id: string) => ChannelPayload): Promise<OkResultPayload> {
		if (this.closed) throw new GoblinSessionError('session_ended', 'The session has ended.')
		if (!this.walletSessionPubkey || !this.convKey) {
			throw new GoblinSessionError('channel_closed', 'The session channel is not open yet.')
		}

		const id = uuid()
		const envelope = sealEnvelope({
			payload: build(id),
			senderPrivateKey: this.siteSessionKeys.privateKey,
			recipientPublicKey: this.walletSessionPubkey,
			convKey: this.convKey,
		})

		return new Promise<OkResultPayload>((resolve, reject) => {
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

	/**
	 * Route a client-composed event through the channel and return the wallet's
	 * signed event. `created_at` is pinned by the caller (NDK), never re-stamped
	 * here (spec finding A). Rejects with a GoblinSessionError on refusal.
	 */
	async sign(unsigned: UnsignedComposedEvent): Promise<Event> {
		const result = await this.request((id) => ({ type: 'sign', id, ts: unixNow(), event: toUnsignedComposedEvent(unsigned) }))
		if (result.type !== 'sign_result') {
			throw new GoblinSessionError('stale_request', 'The wallet answered a sign with the wrong result type.')
		}
		return result.event
	}

	/**
	 * NIP-44 encrypt `plaintext` from the session identity to `peerPubkey`, via
	 * the wallet (seam extension: the identity key never leaves the wallet, so
	 * encryption must round-trip too). The wallet inspects the plaintext and may
	 * raise its money-tier prompt before answering (a pay-committing order DM),
	 * so this can surface the "confirm in your wallet" state exactly like sign().
	 */
	async encrypt(peerPubkey: string, plaintext: string): Promise<string> {
		const result = await this.request((id) => ({ type: 'encrypt', id, ts: unixNow(), peer_pubkey: peerPubkey, plaintext }))
		if (result.type !== 'encrypt_result') {
			throw new GoblinSessionError('stale_request', 'The wallet answered an encrypt with the wrong result type.')
		}
		return result.ciphertext
	}

	/** NIP-44 decrypt `ciphertext` sent from `peerPubkey` to the session identity, via the wallet. */
	async decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
		const result = await this.request((id) => ({ type: 'decrypt', id, ts: unixNow(), peer_pubkey: peerPubkey, ciphertext }))
		if (result.type !== 'decrypt_result') {
			throw new GoblinSessionError('stale_request', 'The wallet answered a decrypt with the wrong result type.')
		}
		return result.plaintext
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
