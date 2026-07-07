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
 * SEAM EXTENSION (coordinator ruling, 2026-07-06): the channel also carries
 * NIP-44 encrypt and decrypt operations, so this signer reports nip44 support
 * and routes encrypt()/decrypt() through the wallet, un-blocking the NIP-59
 * gift-wrap DM path (the identity key never leaves the wallet). The wallet
 * inspects encrypt plaintext for pay-committing order messages and may answer
 * only after its money-tier password prompt, so an encrypt can also sit in the
 * "confirm in your wallet" state.
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
	encrypt(peerPubkey: string, plaintext: string): Promise<string>
	decrypt(peerPubkey: string, ciphertext: string): Promise<string>
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
	 * The channel carries NIP-44 encrypt/decrypt (seam extension), and only
	 * NIP-44: nip04 is legacy and deliberately unsupported, so nip59/order-DM
	 * helpers (signerSupportsNip44) light up while nip04 callers degrade honestly.
	 */
	async encryptionEnabled(scheme?: NDKEncryptionScheme): Promise<NDKEncryptionScheme[]> {
		if (scheme === 'nip04') return []
		return ['nip44']
	}

	/**
	 * NIP-44 encrypt via the wallet. Like sign(), this may come back pending the
	 * wallet's money-tier prompt (the wallet inspects the plaintext), and a
	 * user_declined is a non-fatal per-action refusal.
	 */
	async encrypt(recipient: NDKUser, value: string, scheme?: NDKEncryptionScheme): Promise<string> {
		this.assertNip44(scheme, 'encryption')
		if (this.channel.isClosed) {
			throw new GoblinSessionError('session_ended', 'The Goblin session has ended. Please sign in again.')
		}
		return this.channel.encrypt(recipient.pubkey, value)
	}

	/** NIP-44 decrypt via the wallet. */
	async decrypt(sender: NDKUser, value: string, scheme?: NDKEncryptionScheme): Promise<string> {
		this.assertNip44(scheme, 'decryption')
		if (this.channel.isClosed) {
			throw new GoblinSessionError('session_ended', 'The Goblin session has ended. Please sign in again.')
		}
		return this.channel.decrypt(sender.pubkey, value)
	}

	private assertNip44(scheme: NDKEncryptionScheme | undefined, op: string): void {
		// NDK passes undefined for the default scheme; only explicit nip04 is refused.
		if (scheme && scheme !== 'nip44') {
			throw new Error(`A Goblin session supports only NIP-44 ${op}`)
		}
	}

	toPayload(): string {
		// Not serializable: the session lives in memory and dies on restart (spec 6).
		return JSON.stringify({ type: 'goblin-authorize-session', payload: this.identityPubkey })
	}
}
