import { describe, expect, test } from 'bun:test'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { GoblinAuthorizeSigner, type SignChannel } from '@/lib/goblin/session/GoblinAuthorizeSigner'
import { GoblinSessionError } from '@/lib/goblin/session/GoblinSessionChannel'
import type { UnsignedComposedEvent } from '@/lib/goblin/session/protocol'

const identityPriv = new Uint8Array(32).fill(9)
const identityPub = getPublicKey(identityPriv)

/** A fake channel that signs with the identity key, for signer-only unit tests. */
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
		const closed: SignChannel = {
			identity: identityPub,
			isClosed: true,
			async sign() {
				throw new Error('nope')
			},
		}
		const signer = new GoblinAuthorizeSigner(closed, identityPub)
		await expect(signer.sign({ pubkey: identityPub, created_at: 100, kind: 1, tags: [], content: '' } as never)).rejects.toMatchObject({
			code: 'session_ended',
		})
	})

	test('encryption is not offered by a session (sign-only channel), so callers degrade honestly', async () => {
		const signer = new GoblinAuthorizeSigner(honestChannel(), identityPub)
		expect(await signer.encryptionEnabled()).toEqual([])
		await expect(signer.encrypt()).rejects.toBeInstanceOf(GoblinSessionError)
		await expect(signer.decrypt()).rejects.toBeInstanceOf(GoblinSessionError)
	})
})
