import { describe, expect, test } from 'bun:test'
import { NDKUser } from '@nostr-dev-kit/ndk'
import { finalizeEvent, getPublicKey, nip44 } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { GoblinAuthorizeSigner, type SignChannel } from '@/lib/goblin/session/GoblinAuthorizeSigner'
import { GoblinSessionError } from '@/lib/goblin/session/GoblinSessionChannel'
import type { UnsignedComposedEvent } from '@/lib/goblin/session/protocol'

const identityPriv = new Uint8Array(32).fill(9)
const identityPub = getPublicKey(identityPriv)

/** Channel stub whose ops all throw; spread and override per test. */
const unusedOps = {
	async sign(): Promise<Event> {
		throw new Error('sign not expected in this test')
	},
	async encrypt(): Promise<string> {
		throw new Error('encrypt not expected in this test')
	},
	async decrypt(): Promise<string> {
		throw new Error('decrypt not expected in this test')
	},
}

/** A fake channel acting as the wallet: signs and NIP-44s with the identity key. */
function honestChannel(): SignChannel & { seen: UnsignedComposedEvent[] } {
	const seen: UnsignedComposedEvent[] = []
	return {
		seen,
		identity: identityPub,
		isClosed: false,
		async sign(unsigned) {
			seen.push(unsigned)
			return finalizeEvent(
				{ kind: unsigned.kind, created_at: unsigned.created_at, tags: unsigned.tags, content: unsigned.content },
				identityPriv,
			)
		},
		async encrypt(peerPubkey, plaintext) {
			return nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(identityPriv, peerPubkey))
		},
		async decrypt(peerPubkey, ciphertext) {
			return nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(identityPriv, peerPubkey))
		},
	}
}

describe('GoblinAuthorizeSigner', () => {
	test('user()/pubkey report the session identity synchronously', async () => {
		const signer = new GoblinAuthorizeSigner(honestChannel(), identityPub)
		expect(signer.pubkey).toBe(identityPub)
		expect(signer.userSync.pubkey).toBe(identityPub)
		expect((await signer.user()).pubkey).toBe(identityPub)
		expect((await signer.blockUntilReady()).pubkey).toBe(identityPub)
	})

	test('sign() forwards the NDK-composed created_at unchanged and returns the sig', async () => {
		const channel = honestChannel()
		const signer = new GoblinAuthorizeSigner(channel, identityPub)
		const pinned = 1_751_800_000
		const composed = { pubkey: identityPub, created_at: pinned, kind: 7, tags: [['e', 'x']], content: '+' }
		const sig = await signer.sign(composed as never)
		expect(typeof sig).toBe('string')
		expect(sig.length).toBe(128) // 64-byte schnorr sig hex
		// The channel saw exactly the pinned created_at, never re-stamped.
		expect(channel.seen[0].created_at).toBe(pinned)
		expect(channel.seen[0].kind).toBe(7)
	})

	test('sign() rejects when the event pubkey is a different identity', async () => {
		const signer = new GoblinAuthorizeSigner(honestChannel(), identityPub)
		const other = getPublicKey(new Uint8Array(32).fill(3))
		await expect(signer.sign({ pubkey: other, created_at: 1, kind: 1, tags: [], content: '' } as never)).rejects.toMatchObject({
			code: 'identity_mismatch',
		})
	})

	test('sign() rejects a wallet response that altered created_at (id would not verify)', async () => {
		const cheating: SignChannel = {
			...unusedOps,
			identity: identityPub,
			isClosed: false,
			async sign(unsigned) {
				// Sign a DIFFERENT created_at than NDK pinned.
				return finalizeEvent(
					{ kind: unsigned.kind, created_at: unsigned.created_at + 1, tags: unsigned.tags, content: unsigned.content },
					identityPriv,
				)
			},
		}
		const signer = new GoblinAuthorizeSigner(cheating, identityPub)
		await expect(signer.sign({ pubkey: identityPub, created_at: 100, kind: 1, tags: [], content: '' } as never)).rejects.toThrow(
			/altered the event/,
		)
	})

	test('sign() rejects an invalid signature from the wallet', async () => {
		const bad: SignChannel = {
			...unusedOps,
			identity: identityPub,
			isClosed: false,
			async sign(unsigned) {
				const ev = finalizeEvent(
					{ kind: unsigned.kind, created_at: unsigned.created_at, tags: unsigned.tags, content: unsigned.content },
					identityPriv,
				)
				const other = finalizeEvent(
					{ kind: unsigned.kind, created_at: unsigned.created_at + 9, tags: unsigned.tags, content: unsigned.content },
					identityPriv,
				)
				// A plain literal (as a JSON-decoded channel reply would be, with no
				// nostr-tools verified-symbol): correct id, but a valid signature over a
				// DIFFERENT event, so verifyEvent must reject it.
				return {
					id: ev.id,
					pubkey: ev.pubkey,
					created_at: ev.created_at,
					kind: ev.kind,
					tags: ev.tags,
					content: ev.content,
					sig: other.sig,
				} as Event
			},
		}
		const signer = new GoblinAuthorizeSigner(bad, identityPub)
		await expect(signer.sign({ pubkey: identityPub, created_at: 100, kind: 1, tags: [], content: '' } as never)).rejects.toThrow(
			/invalid signature/,
		)
	})

	test('sign() propagates a non-fatal user_declined from the channel', async () => {
		const declining: SignChannel = {
			...unusedOps,
			identity: identityPub,
			isClosed: false,
			async sign() {
				throw new GoblinSessionError('user_declined')
			},
		}
		const signer = new GoblinAuthorizeSigner(declining, identityPub)
		await expect(signer.sign({ pubkey: identityPub, created_at: 100, kind: 17, tags: [], content: '' } as never)).rejects.toMatchObject({
			code: 'user_declined',
		})
	})

	test('sign() fails fast once the channel is closed', async () => {
		const closed: SignChannel = { ...unusedOps, identity: identityPub, isClosed: true }
		const signer = new GoblinAuthorizeSigner(closed, identityPub)
		await expect(signer.sign({ pubkey: identityPub, created_at: 100, kind: 1, tags: [], content: '' } as never)).rejects.toMatchObject({
			code: 'session_ended',
		})
	})

	test('encryptionEnabled reports nip44 (and only nip44), lighting up the DM path', async () => {
		const signer = new GoblinAuthorizeSigner(honestChannel(), identityPub)
		expect(await signer.encryptionEnabled()).toEqual(['nip44'])
		expect(await signer.encryptionEnabled('nip44')).toEqual(['nip44'])
		expect(await signer.encryptionEnabled('nip04')).toEqual([])
	})

	test('encrypt()/decrypt() round-trip through the channel (wallet-held NIP-44)', async () => {
		const signer = new GoblinAuthorizeSigner(honestChannel(), identityPub)
		const peerPriv = new Uint8Array(32).fill(4)
		const peer = new NDKUser({ pubkey: getPublicKey(peerPriv) })

		const ciphertext = await signer.encrypt(peer, 'order: 3 candles', 'nip44')
		// The peer can decrypt it with their own key (true NIP-44 from the identity).
		const peerConv = nip44.v2.utils.getConversationKey(peerPriv, identityPub)
		expect(nip44.v2.decrypt(ciphertext, peerConv)).toBe('order: 3 candles')

		// And the signer can decrypt what the peer sends back.
		const reply = nip44.v2.encrypt('shipped!', peerConv)
		expect(await signer.decrypt(peer, reply, 'nip44')).toBe('shipped!')
	})

	test('encrypt() propagates a non-fatal user_declined (money-tier pause on a pay-committing message)', async () => {
		const declining: SignChannel = {
			...unusedOps,
			identity: identityPub,
			isClosed: false,
			async encrypt() {
				throw new GoblinSessionError('user_declined')
			},
		}
		const signer = new GoblinAuthorizeSigner(declining, identityPub)
		const peer = new NDKUser({ pubkey: getPublicKey(new Uint8Array(32).fill(4)) })
		await expect(signer.encrypt(peer, 'I agree to pay 5 grin', 'nip44')).rejects.toMatchObject({ code: 'user_declined' })
	})

	test('encrypt()/decrypt() refuse nip04 and fail fast on a closed channel', async () => {
		const signer = new GoblinAuthorizeSigner(honestChannel(), identityPub)
		const peer = new NDKUser({ pubkey: getPublicKey(new Uint8Array(32).fill(4)) })
		await expect(signer.encrypt(peer, 'x', 'nip04')).rejects.toThrow(/only NIP-44/)
		await expect(signer.decrypt(peer, 'x', 'nip04')).rejects.toThrow(/only NIP-44/)

		const closed: SignChannel = { ...unusedOps, identity: identityPub, isClosed: true }
		const closedSigner = new GoblinAuthorizeSigner(closed, identityPub)
		await expect(closedSigner.encrypt(peer, 'x', 'nip44')).rejects.toMatchObject({ code: 'session_ended' })
		await expect(closedSigner.decrypt(peer, 'x', 'nip44')).rejects.toMatchObject({ code: 'session_ended' })
	})
})
