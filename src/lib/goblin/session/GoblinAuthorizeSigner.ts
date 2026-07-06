/**
 * GoblinAuthorizeSigner - an NDKSigner whose sign() routes the client-composed
 * event through a live Goblin trust session channel (spec section 11, step 2).
 *
 * NDK composes the event (pinning created_at and computing id) BEFORE calling
 * signer.sign(), and adopts only the returned hex signature (finding A). So this
 * signer must sign EXACTLY the event NDK composed, created_at and all: it strips
 * id/sig, sends the remaining fields over the channel, and returns the wallet's
 * signature. It never re-stamps the time and never invents an id.
 *
 * Any sign may come back pending the wallet's money-tier password prompt (the
 * wallet, not the site, decides the tier). sign() simply awaits the channel; the
 * channel surfaces the "confirm in your wallet" state while a request is
 * outstanding. A `user_declined` refusal throws a non-fatal GoblinSessionError
 * the caller can catch per action; a session-ending refusal ends the session.
 *
 * IMPORTANT SEAM NOTE: the spec's session channel is SIGN-ONLY (sections 5.4,
 * 5.7). It defines no encrypt/decrypt op. NIP-44 encryption for DM seals
 * (kind 13) is therefore NOT available through a session; encrypt()/decrypt()
 * throw and encryptionEnabled() reports none, so callers degrade honestly rather
 * than hang. See the report's flagged deviations.
 */

import { NDKUser, type NDKEncryptionScheme, type NDKSigner, type NostrEvent } from '@nostr-dev-kit/ndk'
import { getEventHash, verifyEvent } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { GoblinSessionError } from './GoblinSessionChannel'
import { isHex64, type UnsignedComposedEvent } from './protocol'

/** The minimal channel surface the signer needs (a GoblinSessionChannel, or a fake in tests). */
export interface SignChannel {
	readonly identity: string | null
	readonly isClosed: boolean
	sign(unsigned: UnsignedComposedEvent): Promise<Event>
}

export class GoblinAuthorizeSigner implements NDKSigner {
	private readonly channel: SignChannel
	private readonly identityPubkey: string
	private readonly _user: NDKUser

	constructor(channel: SignChannel, identityPubkey: string) {
		if (!isHex64(identityPubkey)) throw new Error('GoblinAuthorizeSigner needs a 64-hex identity pubkey')
		this.channel = channel
		this.identityPubkey = identityPubkey
		this._user = new NDKUser({ pubkey: identityPubkey })
	}

	get pubkey(): string {
		return this.identityPubkey
	}

	get userSync(): NDKUser {
		return this._user
	}

	async blockUntilReady(): Promise<NDKUser> {
		return this._user
	}

	async user(): Promise<NDKUser> {
		return this._user
	}

	/**
	 * Route the NDK-composed event through the session channel and return the
	 * wallet's signature. created_at is whatever NDK pinned; we send it unchanged.
	 */
	async sign(event: NostrEvent): Promise<string> {
		if (this.channel.isClosed) {
			throw new GoblinSessionError('session_ended', 'The Goblin session has ended. Please sign in again.')
		}

		const pubkey = event.pubkey && event.pubkey.length > 0 ? event.pubkey : this.identityPubkey
		if (pubkey !== this.identityPubkey) {
			throw new GoblinSessionError('identity_mismatch', 'This session signs for a different identity.')
		}
		const createdAt = event.created_at
		if (typeof createdAt !== 'number') {
			throw new Error('GoblinAuthorizeSigner requires a client-pinned created_at')
		}
		const kind = event.kind
		if (typeof kind !== 'number') {
			throw new Error('GoblinAuthorizeSigner requires an event kind')
		}

		const unsigned: UnsignedComposedEvent = {
			pubkey,
			created_at: createdAt,
			kind,
			tags: event.tags,
			content: event.content ?? '',
		}

		const signed = await this.channel.sign(unsigned)

		// The wallet owns id and sig, but NDK keeps its OWN composed id and only
		// adopts this sig. So the wallet must have signed EXACTLY the fields we sent
		// (same id NDK computed); otherwise the sig NDK adopts will not verify at the
		// relay. Pin the seam: the returned id must equal the hash of what we sent,
		// the identity must match, and the signature must verify. (spec finding A)
		const expectedId = getEventHash(unsigned)
		if (signed.pubkey !== this.identityPubkey) {
			throw new GoblinSessionError('identity_mismatch', 'The wallet signed with a different identity.')
		}
		if (signed.id !== expectedId || signed.created_at !== createdAt || signed.kind !== kind) {
			throw new Error('The wallet altered the event before signing; refusing the signature')
		}
		if (typeof signed.sig !== 'string' || !verifyEvent(signed)) {
			throw new Error('The wallet returned an invalid signature')
		}
		return signed.sig
	}

	/**
	 * The session channel carries no encryption op (spec is sign-only). Report no
	 * NIP support so nip59/order-DM helpers degrade to a clear error instead of a
	 * hang. FLAGGED as a seam gap for the wallet worker + security pass.
	 */
	async encryptionEnabled(): Promise<NDKEncryptionScheme[]> {
		return []
	}

	async encrypt(): Promise<string> {
		throw new GoblinSessionError('kind_not_in_session', 'Encryption is not available in a Goblin session; open your wallet to send this.')
	}

	async decrypt(): Promise<string> {
		throw new GoblinSessionError('kind_not_in_session', 'Decryption is not available in a Goblin session; open your wallet to read this.')
	}

	toPayload(): string {
		// Not serializable: the session lives in memory and dies on restart (spec 6).
		return JSON.stringify({ type: 'goblin-authorize-session', payload: this.identityPubkey })
	}
}
