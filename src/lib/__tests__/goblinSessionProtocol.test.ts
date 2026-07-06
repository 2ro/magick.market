import { describe, expect, test } from 'bun:test'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import {
	buildTrustUri,
	conversationKey,
	generateChannelKeypair,
	GOBLIN_SESSION_CHANNEL_KIND,
	GOBLIN_LOGIN_EVENT_KIND,
	isHex64,
	MAGICK_LOW_TIER_KINDS,
	openEnvelope,
	REQUEST_EXPIRATION_SECONDS,
	sealEnvelope,
	toUnsignedComposedEvent,
	unixNow,
	withinSkew,
	type ChannelPayload,
} from '@/lib/goblin/session/protocol'

describe('goblin session protocol', () => {
	test('buildTrustUri lays out the spec 5.9 params, cb and r percent-encoded, k deduped csv', () => {
		const uri = buildTrustUri({
			challenge: 'a'.repeat(64),
			domain: 'magick.market',
			callbackUrl: 'https://magick.market/api/v1/login/callback',
			siteSessionPubkey: 'b'.repeat(64),
			relayHint: 'wss://relay.magick.market/',
			kinds: [7, 1, 7, 30405],
		})
		expect(uri.startsWith('goblin:trust?')).toBe(true)
		const query = new URLSearchParams(uri.slice('goblin:trust?'.length))
		expect(query.get('c')).toBe('a'.repeat(64))
		expect(query.get('d')).toBe('magick.market')
		expect(query.get('cb')).toBe('https://magick.market/api/v1/login/callback')
		expect(query.get('sk')).toBe('b'.repeat(64))
		expect(query.get('r')).toBe('wss://relay.magick.market/')
		// dedup preserves first-seen order
		expect(query.get('k')).toBe('7,1,30405')
	})

	test('the requested low-tier set excludes money tier (17, 30402) and login (22242)', () => {
		expect(MAGICK_LOW_TIER_KINDS).not.toContain(17)
		// 30402 listing: money tier by owner ruling (a listing commits a price).
		expect(MAGICK_LOW_TIER_KINDS).not.toContain(30402)
		expect(MAGICK_LOW_TIER_KINDS).not.toContain(GOBLIN_LOGIN_EVENT_KIND)
		// but does carry the HTTP-auth kinds so uploads/name registration work
		expect(MAGICK_LOW_TIER_KINDS).toContain(24242)
		expect(MAGICK_LOW_TIER_KINDS).toContain(27235)
		// and the everyday low-risk kinds
		for (const k of [0, 1, 5, 7, 13, 14, 16, 1059, 30405, 30406]) expect(MAGICK_LOW_TIER_KINDS).toContain(k)
		// the silent set is exactly 18 kinds after the 30402 ruling
		expect(MAGICK_LOW_TIER_KINDS.length).toBe(18)
	})

	test('toUnsignedComposedEvent strips id and sig, keeps client-pinned created_at', () => {
		const pinned = 1751800000
		const full = {
			id: 'deadbeef',
			sig: 'cafebabe',
			pubkey: 'c'.repeat(64),
			created_at: pinned,
			kind: 7,
			tags: [['e', 'x']],
			content: '+',
		}
		const unsigned = toUnsignedComposedEvent(full)
		expect(unsigned).toEqual({ pubkey: 'c'.repeat(64), created_at: pinned, kind: 7, tags: [['e', 'x']], content: '+' })
		expect('id' in unsigned).toBe(false)
		expect('sig' in unsigned).toBe(false)
		expect(unsigned.created_at).toBe(pinned)
	})

	test('sealEnvelope round-trips through openEnvelope between two channel keys', () => {
		const site = generateChannelKeypair()
		const wallet = generateChannelKeypair()
		const siteToWallet = conversationKey(site.privateKey, wallet.publicKey)
		const walletFromSite = conversationKey(wallet.privateKey, site.publicKey)

		const payload: ChannelPayload = {
			type: 'sign',
			id: 'req-1',
			ts: unixNow(),
			event: { pubkey: 'd'.repeat(64), created_at: unixNow(), kind: 1, tags: [], content: 'hi' },
		}
		const envelope = sealEnvelope({
			payload,
			senderPrivateKey: site.privateKey,
			recipientPublicKey: wallet.publicKey,
			convKey: siteToWallet,
		})

		expect(envelope.kind).toBe(GOBLIN_SESSION_CHANNEL_KIND)
		expect(envelope.pubkey).toBe(site.publicKey)
		expect(envelope.tags.find((t) => t[0] === 'p')?.[1]).toBe(wallet.publicKey)
		const expiration = Number(envelope.tags.find((t) => t[0] === 'expiration')?.[1])
		expect(expiration).toBeGreaterThanOrEqual(envelope.created_at + REQUEST_EXPIRATION_SECONDS - 1)

		const opened = openEnvelope(envelope, walletFromSite)
		expect(opened).toEqual(payload)
	})

	test('openEnvelope fails closed on the wrong conversation key and on garbage', () => {
		const site = generateChannelKeypair()
		const wallet = generateChannelKeypair()
		const stranger = generateChannelKeypair()
		const envelope = sealEnvelope({
			payload: { type: 'session-end', id: 'x', reason: 'logout' },
			senderPrivateKey: site.privateKey,
			recipientPublicKey: wallet.publicKey,
			convKey: conversationKey(site.privateKey, wallet.publicKey),
		})
		// A third party's key cannot open it.
		expect(openEnvelope(envelope, conversationKey(stranger.privateKey, site.publicKey))).toBeNull()
		expect(openEnvelope({ content: 'not-nip44' }, conversationKey(wallet.privateKey, site.publicKey))).toBeNull()
	})

	test('withinSkew bounds +/- 300s and isHex64 validates channel keys', () => {
		const now = 1_000_000
		expect(withinSkew(now, now)).toBe(true)
		expect(withinSkew(now + 300, now)).toBe(true)
		expect(withinSkew(now + 301, now)).toBe(false)
		expect(withinSkew(now - 301, now)).toBe(false)
		expect(isHex64(getPublicKey(generateChannelKeypair().privateKey))).toBe(true)
		expect(isHex64('xyz')).toBe(false)
	})

	test('a channel keypair is not the identity key (fresh random each call)', () => {
		const a = generateChannelKeypair()
		const b = generateChannelKeypair()
		expect(a.publicKey).not.toBe(b.publicKey)
		// sanity: finalizeEvent with the channel key produces an event by that key
		const ev = finalizeEvent({ kind: 1, created_at: unixNow(), tags: [], content: '' }, a.privateKey)
		expect(ev.pubkey).toBe(a.publicKey)
	})
})
