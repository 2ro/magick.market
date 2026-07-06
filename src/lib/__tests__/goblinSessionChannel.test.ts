import { describe, expect, test } from 'bun:test'
import { finalizeEvent, getEventHash, getPublicKey } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { GoblinSessionChannel, GoblinSessionError } from '@/lib/goblin/session/GoblinSessionChannel'
import {
	conversationKey,
	generateChannelKeypair,
	openEnvelope,
	sealEnvelope,
	unixNow,
	type SignRequestPayload,
	type GoblinSessionErrorCode,
} from '@/lib/goblin/session/protocol'

/** A minimal wallet counterpart: opens the session and answers sign requests. */
function makeWallet(sitePubkey: string) {
	const walletKeys = generateChannelKeypair()
	const identityPriv = new Uint8Array(32).fill(7)
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
		endSession(): Event {
			return sealEnvelope({
				payload: { type: 'session-end', id: 'end-1', reason: 'revoked' },
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
})
