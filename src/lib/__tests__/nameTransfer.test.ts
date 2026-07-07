import { describe, test, expect } from 'bun:test'
import { nip19 } from 'nostr-tools'
import {
	MAX_OFFER_TTL_SECONDS,
	buildTransferOfferEvent,
	buyerToPubkeyHex,
	extractOffer,
	grinStringToNanogrinString,
	nanogrinStringToGrinString,
	offerNip05,
	validateExpiration,
} from '@/lib/nameTransfer'
import { TRANSFER_OFFER_KIND } from '@/lib/schemas/nameTransfer'

const BUYER_HEX = '1'.repeat(64)
const SELLER_HEX = '2'.repeat(64)

describe('grinStringToNanogrinString (exact, no float drift)', () => {
	test('whole and simple decimals', () => {
		expect(grinStringToNanogrinString('1')).toBe('1000000000')
		expect(grinStringToNanogrinString('1.5')).toBe('1500000000')
		expect(grinStringToNanogrinString('0.25')).toBe('250000000')
		expect(grinStringToNanogrinString('0')).toBe('0')
	})

	test('full 9-decimal precision is exact', () => {
		expect(grinStringToNanogrinString('0.000000001')).toBe('1')
		expect(grinStringToNanogrinString('500000.000381624')).toBe('500000000381624')
		expect(grinStringToNanogrinString('123456.789123456')).toBe('123456789123456')
	})

	test('rejects more than 9 decimals and junk', () => {
		expect(() => grinStringToNanogrinString('1.0000000001')).toThrow()
		expect(() => grinStringToNanogrinString('abc')).toThrow()
		expect(() => grinStringToNanogrinString('1.2.3')).toThrow()
		expect(() => grinStringToNanogrinString('-1')).toThrow()
	})

	test('round-trips through nanogrinStringToGrinString', () => {
		for (const g of ['1', '1.5', '0.000000001', '500000.000381624', '0']) {
			expect(nanogrinStringToGrinString(grinStringToNanogrinString(g))).toBe(g === '0' ? '0' : g)
		}
	})
})

describe('buildTransferOfferEvent (invoice-bound offer)', () => {
	const expiration = Math.floor(Date.now() / 1000) + 3600
	const event = buildTransferOfferEvent({
		name: 'alice',
		domain: 'magick.market',
		buyerPubkeyHex: BUYER_HEX,
		priceNanogrin: '500000000381624',
		invoiceId: 'inv-abc',
		payUrl: 'https://pay.example/inv-abc',
		expiration,
	})

	test('kind is 3402 and content is empty', () => {
		expect(event.kind).toBe(TRANSFER_OFFER_KIND)
		expect(event.kind).toBe(3402)
		expect(event.content).toBe('')
	})

	test('tags carry the invoice + pay_url in order, with exact values', () => {
		expect(event.tags).toEqual([
			['name', 'alice'],
			['domain', 'magick.market'],
			['p', BUYER_HEX],
			['price', '500000000381624'],
			['invoice', 'inv-abc'],
			['pay_url', 'https://pay.example/inv-abc'],
			['expiration', String(expiration)],
		])
	})

	test('price is preserved as an integer nanogrin string', () => {
		const priceTag = event.tags.find((t) => t[0] === 'price')!
		expect(priceTag[1]).toBe('500000000381624')
		expect(/^\d+$/.test(priceTag[1])).toBe(true)
	})

	test('rejects a non-integer price, a bad buyer key, and a missing invoice', () => {
		expect(() =>
			buildTransferOfferEvent({
				name: 'a',
				domain: 'd',
				buyerPubkeyHex: BUYER_HEX,
				priceNanogrin: '1.5',
				invoiceId: 'inv',
				payUrl: 'u',
				expiration,
			}),
		).toThrow()
		expect(() =>
			buildTransferOfferEvent({
				name: 'a',
				domain: 'd',
				buyerPubkeyHex: 'nope',
				priceNanogrin: '1',
				invoiceId: 'inv',
				payUrl: 'u',
				expiration,
			}),
		).toThrow()
		expect(() =>
			buildTransferOfferEvent({
				name: 'a',
				domain: 'd',
				buyerPubkeyHex: BUYER_HEX,
				priceNanogrin: '1',
				invoiceId: '',
				payUrl: 'u',
				expiration,
			}),
		).toThrow()
	})
})

describe('extractOffer / offerNip05', () => {
	test('extracts a well-formed offer view from a kind-3402 event', () => {
		const expiration = Math.floor(Date.now() / 1000) + 3600
		const view = extractOffer({
			id: 'a'.repeat(64),
			pubkey: SELLER_HEX,
			kind: 3402,
			tags: [
				['name', 'alice'],
				['domain', 'magick.market'],
				['p', BUYER_HEX],
				['price', '1500000000'],
				['invoice', 'inv-xyz'],
				['pay_url', 'https://pay.example/inv-xyz'],
				['expiration', String(expiration)],
			],
		})
		expect(view).not.toBeNull()
		expect(view!.name).toBe('alice')
		expect(view!.buyerPubkeyHex).toBe(BUYER_HEX)
		expect(view!.priceNanogrin).toBe('1500000000')
		expect(view!.invoiceId).toBe('inv-xyz')
		expect(view!.payUrl).toBe('https://pay.example/inv-xyz')
		expect(view!.sellerPubkeyHex).toBe(SELLER_HEX)
		expect(offerNip05(view!)).toBe('alice@magick.market')
	})

	test('returns null for the wrong kind, a missing tag, or a missing invoice', () => {
		expect(extractOffer({ kind: 1, tags: [] })).toBeNull()
		expect(extractOffer({ kind: 3402, tags: [['name', 'alice']] })).toBeNull()
		expect(
			extractOffer({
				kind: 3402,
				tags: [
					['name', 'alice'],
					['domain', 'magick.market'],
					['p', BUYER_HEX],
					['price', '1'],
					['expiration', String(Math.floor(Date.now() / 1000) + 3600)],
				],
			}),
		).toBeNull()
	})
})

describe('buyerToPubkeyHex', () => {
	test('accepts an npub and 64-hex', () => {
		const npub = nip19.npubEncode(BUYER_HEX)
		expect(buyerToPubkeyHex(npub)).toBe(BUYER_HEX)
		expect(buyerToPubkeyHex(BUYER_HEX)).toBe(BUYER_HEX)
	})

	test('rejects junk and empty', () => {
		expect(() => buyerToPubkeyHex('')).toThrow()
		expect(() => buyerToPubkeyHex('not-an-npub')).toThrow()
	})
})

describe('validateExpiration bounds', () => {
	const now = 1_000_000
	test('accepts a future time within 30 days', () => {
		expect(validateExpiration(now + 3600, now)).toBe(now + 3600)
		expect(validateExpiration(now + MAX_OFFER_TTL_SECONDS, now)).toBe(now + MAX_OFFER_TTL_SECONDS)
	})
	test('rejects past/now and beyond 30 days', () => {
		expect(() => validateExpiration(now, now)).toThrow()
		expect(() => validateExpiration(now - 1, now)).toThrow()
		expect(() => validateExpiration(now + MAX_OFFER_TTL_SECONDS + 1, now)).toThrow()
	})
})
