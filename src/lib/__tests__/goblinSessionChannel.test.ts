import { describe, expect, test } from 'bun:test'
import { finalizeEvent, getEventHash, getPublicKey, nip44, SimplePool } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { GoblinSessionChannel, GoblinSessionError } from '@/lib/goblin/session/GoblinSessionChannel'
import {
	conversationKey,
	generateChannelKeypair,
	openEnvelope,
	sealEnvelope,
	unixNow,
	type DecryptRequestPayload,
	type EncryptRequestPayload,
	type SignRequestPayload,
	type GoblinSessionErrorCode,
} from '@/lib/goblin/session/protocol'

/** A minimal wallet counterpart: opens the session and answers sign requests. */
function makeWallet(sitePubkey: string, identityPrivOverride?: Uint8Array) {
	const walletKeys = generateChannelKeypair()
	const identityPriv = identityPrivOverride ?? new Uint8Array(32).fill(7)
	const identityPub = getPublicKey(identityPriv)
	const convKey = conversationKey(walletKeys.privateKey, sitePubkey)

	return {
		walletKeys,
		identityPub,
		sessionOpen(): Event {
			return sealEnvelope({
				payload: { type: 'session-open', id: 'open-1', identity_pubkey: identityPub },
				senderPrivateKey: walletKeys.privateKey,
				recipientPublicKey: sitePubkey,
				convKey,
			})
		},
		/** Read a site->wallet request envelope. */
		readRequest(envelope: Event): SignRequestPayload {
			const payload = openEnvelope(envelope, convKey)
			if (!payload || payload.type !== 'sign') throw new Error('not a sign request')
			return payload
		},
		/** Sign the request's event with the identity key and seal the ok result. */
		signResult(req: SignRequestPayload): Event {
			const signed = finalizeEvent(
				{ kind: req.event.kind, created_at: req.event.created_at, tags: req.event.tags, content: req.event.content },
				identityPriv,
			)
			return sealEnvelope({
				payload: { type: 'sign_result', id: req.id, ok: true, event: signed },
				senderPrivateKey: walletKeys.privateKey,
				recipientPublicKey: sitePubkey,
				convKey,
			})
		},
		refuse(id: string, error: GoblinSessionErrorCode): Event {
			return sealEnvelope({
				payload: { type: 'sign_result', id, ok: false, error },
				senderPrivateKey: walletKeys.privateKey,
				recipientPublicKey: sitePubkey,
				convKey,
			})
		},
		/** Read a site->wallet encrypt request envelope. */
		readEncryptRequest(envelope: Event): EncryptRequestPayload {
			const payload = openEnvelope(envelope, convKey)
			if (!payload || payload.type !== 'encrypt') throw new Error('not an encrypt request')
			return payload
		},
		/** NIP-44 encrypt the plaintext from the identity to the peer, seal the ok result. */
		encryptResult(req: EncryptRequestPayload): Event {
			const peerConv = nip44.v2.utils.getConversationKey(identityPriv, req.peer_pubkey)
			return sealEnvelope({
				payload: { type: 'encrypt_result', id: req.id, ok: true, ciphertext: nip44.v2.encrypt(req.plaintext, peerConv) },
				senderPrivateKey: walletKeys.privateKey,
				recipientPublicKey: sitePubkey,
				convKey,
			})
		},
		refuseEncrypt(id: string, error: GoblinSessionErrorCode): Event {
			return sealEnvelope({
				payload: { type: 'encrypt_result', id, ok: false, error },
				senderPrivateKey: walletKeys.privateKey,
				recipientPublicKey: sitePubkey,
				convKey,
			})
		},
		/** Read a site->wallet decrypt request envelope. */
		readDecryptRequest(envelope: Event): DecryptRequestPayload {
			const payload = openEnvelope(envelope, convKey)
			if (!payload || payload.type !== 'decrypt') throw new Error('not a decrypt request')
			return payload
		},
		decryptResult(req: DecryptRequestPayload): Event {
			const peerConv = nip44.v2.utils.getConversationKey(identityPriv, req.peer_pubkey)
			return sealEnvelope({
				payload: { type: 'decrypt_result', id: req.id, ok: true, plaintext: nip44.v2.decrypt(req.ciphertext, peerConv) },
				senderPrivateKey: walletKeys.privateKey,
				recipientPublicKey: sitePubkey,
				convKey,
			})
		},
		endSession(): Event {
			return sealEnvelope({
				payload: { type: 'session-end', id: 'end-1', reason: 'revoked' },
				senderPrivateKey: walletKeys.privateKey,
				recipientPublicKey: sitePubkey,
				convKey,
			})
		},
		/** A wallet that omits the reason field (audit cosmetic: tolerate both). */
		endSessionWithoutReason(): Event {
			return sealEnvelope({
				payload: { type: 'session-end', id: 'end-2' },
				senderPrivateKey: walletKeys.privateKey,
				recipientPublicKey: sitePubkey,
				convKey,
			})
		},
	}
}

function makeChannel(overrides: Partial<ConstructorParameters<typeof GoblinSessionChannel>[0]> = {}) {
	const siteSessionKeys = generateChannelKeypair()
	const published: Event[] = []
	const events: { pending: number[]; ended: string[] } = { pending: [], ended: [] }
	const channel = new GoblinSessionChannel({
		siteSessionKeys,
		relays: ['ws://localhost:0'],
		publish: (_relays, event) => published.push(event),
		onPendingChange: (n) => events.pending.push(n),
		onSessionEnd: (r) => events.ended.push(r),
		confirmHintMs: 5,
		requestTimeoutMs: 500,
		...overrides,
	})
	return { channel, siteSessionKeys, published, events }
}

describe('GoblinSessionChannel', () => {
	test('open() resolves on the wallet session-open and binds the identity', async () => {
		const { channel, siteSessionKeys } = makeChannel()
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		const info = await opened
		expect(info.identityPubkey).toBe(wallet.identityPub)
		expect(channel.walletPubkey).toBe(wallet.walletKeys.publicKey)
		expect(channel.identity).toBe(wallet.identityPub)
	})

	test('sign() sends the client-pinned created_at and resolves with the signed event', async () => {
		const { channel, siteSessionKeys, published } = makeChannel()
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened

		const pinned = unixNow() - 42 // NOT re-stamped by the channel
		const signPromise = channel.sign({ pubkey: wallet.identityPub, created_at: pinned, kind: 7, tags: [['e', 'evt']], content: '+' })

		// The site published exactly one request envelope; read it as the wallet.
		expect(published.length).toBe(1)
		const req = wallet.readRequest(published[0])
		expect(req.type).toBe('sign')
		expect(req.event.created_at).toBe(pinned) // pinning preserved on the wire
		expect('id' in req.event).toBe(false)
		expect('sig' in req.event).toBe(false)

		channel.handleEnvelope(wallet.signResult(req))
		const signed = await signPromise
		expect(signed.pubkey).toBe(wallet.identityPub)
		expect(signed.created_at).toBe(pinned)
		expect(signed.id).toBe(getEventHash(signed))
	})

	test('user_declined rejects that one action but keeps the session live (non-fatal)', async () => {
		const { channel, siteSessionKeys, published } = makeChannel()
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened

		const signPromise = channel.sign({ pubkey: wallet.identityPub, created_at: unixNow(), kind: 1, tags: [], content: 'hi' })
		const req = wallet.readRequest(published[0])
		channel.handleEnvelope(wallet.refuse(req.id, 'user_declined'))

		await expect(signPromise).rejects.toMatchObject({ code: 'user_declined' })
		expect(channel.isClosed).toBe(false) // session stays open
	})

	test('a session-ending refusal tears the channel down and reports the reason', async () => {
		const { channel, siteSessionKeys, published, events } = makeChannel()
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened

		const signPromise = channel.sign({ pubkey: wallet.identityPub, created_at: unixNow(), kind: 1, tags: [], content: 'hi' })
		const req = wallet.readRequest(published[0])
		channel.handleEnvelope(wallet.refuse(req.id, 'session_ended'))

		await expect(signPromise).rejects.toBeInstanceOf(GoblinSessionError)
		expect(channel.isClosed).toBe(true)
		expect(events.ended).toContain('session_ended')
	})

	test('an outstanding request past the hint delay raises the confirm-in-wallet count', async () => {
		const { channel, siteSessionKeys, events } = makeChannel({ confirmHintMs: 5 })
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened

		void channel.sign({ pubkey: wallet.identityPub, created_at: unixNow(), kind: 17, tags: [], content: 'pay' }).catch(() => {})
		await new Promise((r) => setTimeout(r, 20))
		expect(events.pending.at(-1)).toBe(1) // "confirm in your wallet" is showing
	})

	test('P2-2: a forged session-open with an unverified identity never binds the channel', async () => {
		// The verifier stands in for the server login-status check: only the
		// genuine wallet's identity passes.
		const genuineIdentity = getPublicKey(new Uint8Array(32).fill(7))
		const { channel, siteSessionKeys } = makeChannel({
			verifyIdentity: async (identityPubkey: string) => identityPubkey === genuineIdentity,
		})
		const attacker = makeWallet(siteSessionKeys.publicKey, new Uint8Array(32).fill(66))
		const openPromise = channel.open(100).catch((e) => e)

		channel.handleEnvelope(attacker.sessionOpen())
		await new Promise((r) => setTimeout(r, 10))

		// The forged open was rejected: nothing bound, no identity adopted.
		expect(channel.walletPubkey).toBeNull()
		expect(channel.identity).toBeNull()

		// And the trust flow surfaces an honest timeout, not a hijacked session.
		const outcome = await openPromise
		expect(outcome).toBeInstanceOf(GoblinSessionError)
		expect((outcome as GoblinSessionError).code).toBe('timed_out')
	})

	test('P2-2: the genuine session-open still binds after a forged attempt', async () => {
		const genuineIdentity = getPublicKey(new Uint8Array(32).fill(7))
		const { channel, siteSessionKeys, published } = makeChannel({
			verifyIdentity: async (identityPubkey: string) => identityPubkey === genuineIdentity,
		})
		const attacker = makeWallet(siteSessionKeys.publicKey, new Uint8Array(32).fill(66))
		const wallet = makeWallet(siteSessionKeys.publicKey) // identity = fill(7), verifiable

		const opened = channel.open(1000)
		channel.handleEnvelope(attacker.sessionOpen()) // forged, rejected by verify
		channel.handleEnvelope(wallet.sessionOpen()) // genuine, binds
		const info = await opened
		expect(info.identityPubkey).toBe(genuineIdentity)
		expect(channel.walletPubkey).toBe(wallet.walletKeys.publicKey)

		// The bound channel works end to end: a sign round-trips with the wallet.
		const signPromise = channel.sign({ pubkey: wallet.identityPub, created_at: unixNow(), kind: 1, tags: [], content: 'hi' })
		channel.handleEnvelope(wallet.signResult(wallet.readRequest(published[0])))
		expect((await signPromise).pubkey).toBe(genuineIdentity)

		// And the attacker's key still cannot drive the bound channel.
		channel.handleEnvelope(attacker.endSession())
		expect(channel.isClosed).toBe(false)
	})

	test('P2-2 hardening: pre-bind, a session-end from an arbitrary sender is ignored', async () => {
		const { channel, siteSessionKeys, events } = makeChannel()
		const stranger = makeWallet(siteSessionKeys.publicKey)
		channel.handleEnvelope(stranger.endSession())
		expect(channel.isClosed).toBe(false)
		expect(events.ended.length).toBe(0)
	})

	test('a session-end without a reason field defaults to "ended", never undefined', async () => {
		const { channel, siteSessionKeys, events } = makeChannel()
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened

		channel.handleEnvelope(wallet.endSessionWithoutReason())
		expect(channel.isClosed).toBe(true)
		expect(events.ended).toEqual(['ended'])
	})

	test('the wallet session-end envelope ends the session (spec section 6 item 1)', async () => {
		const { channel, siteSessionKeys, events } = makeChannel()
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened
		channel.handleEnvelope(wallet.endSession())
		expect(channel.isClosed).toBe(true)
		expect(events.ended).toContain('revoked')
	})

	test('an envelope from a stranger key is ignored once the session is bound', async () => {
		const { channel, siteSessionKeys, published } = makeChannel()
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const stranger = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened

		const signPromise = channel.sign({ pubkey: wallet.identityPub, created_at: unixNow(), kind: 1, tags: [], content: 'hi' })
		const req = wallet.readRequest(published[0])
		// Stranger tries to answer with the same request id: rejected (wrong sender key).
		channel.handleEnvelope(stranger.refuse(req.id, 'user_declined'))
		// The real wallet then answers ok.
		channel.handleEnvelope(wallet.signResult(req))
		const signed = await signPromise
		expect(signed.pubkey).toBe(wallet.identityPub)
	})

	test('encrypt() round-trips: the wallet NIP-44s the plaintext to the peer, verifiable by the peer', async () => {
		const { channel, siteSessionKeys, published } = makeChannel()
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened

		const peerPriv = new Uint8Array(32).fill(11)
		const peerPub = getPublicKey(peerPriv)
		const encryptPromise = channel.encrypt(peerPub, 'order: two wands')

		expect(published.length).toBe(1)
		const req = wallet.readEncryptRequest(published[0])
		expect(req.peer_pubkey).toBe(peerPub)
		expect(req.plaintext).toBe('order: two wands')

		channel.handleEnvelope(wallet.encryptResult(req))
		const ciphertext = await encryptPromise
		// The peer decrypts with their own key: real identity-to-peer NIP-44.
		const peerConv = nip44.v2.utils.getConversationKey(peerPriv, wallet.identityPub)
		expect(nip44.v2.decrypt(ciphertext, peerConv)).toBe('order: two wands')
	})

	test('decrypt() round-trips: the wallet opens a peer ciphertext for the site', async () => {
		const { channel, siteSessionKeys, published } = makeChannel()
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened

		const peerPriv = new Uint8Array(32).fill(11)
		const peerPub = getPublicKey(peerPriv)
		const peerConv = nip44.v2.utils.getConversationKey(peerPriv, wallet.identityPub)
		const ciphertext = nip44.v2.encrypt('shipped!', peerConv)

		const decryptPromise = channel.decrypt(peerPub, ciphertext)
		const req = wallet.readDecryptRequest(published[0])
		channel.handleEnvelope(wallet.decryptResult(req))
		expect(await decryptPromise).toBe('shipped!')
	})

	test('a 30402 listing publish (money tier by ruling) shows pending, and a decline is non-fatal with honest copy', async () => {
		const { channel, siteSessionKeys, published, events } = makeChannel({ confirmHintMs: 5 })
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened

		// The listing publish flow signs a kind 30402; the wallet classifies it
		// money tier and prompts, so the request stalls past the hint delay.
		const signPromise = channel.sign({
			pubkey: wallet.identityPub,
			created_at: unixNow(),
			kind: 30402,
			tags: [['d', 'product_1']],
			content: 'a fine wand',
		})
		await new Promise((r) => setTimeout(r, 20))
		expect(events.pending.at(-1)).toBe(1) // "Confirm in your wallet" is showing

		// The user declines the wallet prompt: per-action refusal with human copy
		// (this message is what the publish mutation's toast surfaces).
		const req = wallet.readRequest(published[0])
		channel.handleEnvelope(wallet.refuse(req.id, 'user_declined'))
		await expect(signPromise).rejects.toThrow(/declined this action in your wallet/)
		expect(channel.isClosed).toBe(false) // session stays live
		expect(events.pending.at(-1)).toBe(0) // indicator cleared
	})

	test('a declined encrypt (money-tier pause on a pay-committing message) is non-fatal', async () => {
		const { channel, siteSessionKeys, published, events } = makeChannel({ confirmHintMs: 5 })
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened

		const peerPub = getPublicKey(new Uint8Array(32).fill(11))
		const encryptPromise = channel.encrypt(peerPub, 'I agree to pay 5 grin')

		// The wallet is prompting: the request sits outstanding past the hint delay,
		// so the "confirm in your wallet" state shows for the encrypt too.
		await new Promise((r) => setTimeout(r, 20))
		expect(events.pending.at(-1)).toBe(1)

		const req = wallet.readEncryptRequest(published[0])
		channel.handleEnvelope(wallet.refuseEncrypt(req.id, 'user_declined'))
		await expect(encryptPromise).rejects.toMatchObject({ code: 'user_declined' })
		expect(channel.isClosed).toBe(false) // session stays live
		expect(events.pending.at(-1)).toBe(0) // pending indicator cleared
	})

	// resync() is the same-device mobile fix: after the browser tab is suspended for
	// the wallet deep-link, its live relay socket dies and SimplePool never re-issues
	// the REQ, so the already-stored session-open is never delivered. resync() does a
	// one-shot querySync re-pull and feeds each hit back into the idempotent
	// handleEnvelope, binding the channel.
	test('resync() re-pulls the stored session-open and binds the channel', async () => {
		const { channel, siteSessionKeys } = makeChannel()
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const stored = wallet.sessionOpen()

		// Stand in for the relay: the one-shot pull returns the stored session-open.
		const original = SimplePool.prototype.querySync
		const calls: unknown[][] = []
		SimplePool.prototype.querySync = async (relays: string[], filter: unknown) => {
			calls.push([relays, filter])
			return [stored]
		}
		try {
			const opened = channel.open(1000)
			await channel.resync()
			const info = await opened
			expect(info.identityPubkey).toBe(wallet.identityPub)
			expect(channel.walletPubkey).toBe(wallet.walletKeys.publicKey)
			// The pulled filter is a well-formed object (never an array/undefined) so a
			// strict relay like strfry does not reject it as "not an object".
			const filter = calls[0]?.[1] as { kinds?: unknown; '#p'?: unknown }
			expect(Array.isArray(filter)).toBe(false)
			expect(filter.kinds).toEqual([24140])
			expect(filter['#p']).toEqual([siteSessionKeys.publicKey])

			// Idempotent: a second resync re-feeds the same event, nothing breaks or rebinds.
			await channel.resync()
			expect(channel.walletPubkey).toBe(wallet.walletKeys.publicKey)
		} finally {
			SimplePool.prototype.querySync = original
		}
	})

	test('resync() is a no-op once the channel is bound (no relay pull)', async () => {
		const { channel, siteSessionKeys } = makeChannel()
		const wallet = makeWallet(siteSessionKeys.publicKey)
		const opened = channel.open(1000)
		channel.handleEnvelope(wallet.sessionOpen())
		await opened

		const original = SimplePool.prototype.querySync
		let pulled = false
		SimplePool.prototype.querySync = async () => {
			pulled = true
			return []
		}
		try {
			await channel.resync()
			expect(pulled).toBe(false) // bound: guard returns before touching the relay
		} finally {
			SimplePool.prototype.querySync = original
		}
	})

	test('resync() is a no-op after the channel is closed', async () => {
		const { channel } = makeChannel()
		channel.end('logout')
		const original = SimplePool.prototype.querySync
		let pulled = false
		SimplePool.prototype.querySync = async () => {
			pulled = true
			return []
		}
		try {
			await channel.resync()
			expect(pulled).toBe(false)
		} finally {
			SimplePool.prototype.querySync = original
		}
	})
})
