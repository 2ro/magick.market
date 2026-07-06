import { describe, test, expect } from 'bun:test'
import { ed25519 } from '@noble/curves/ed25519'
import { nip19 } from 'nostr-tools'
import { grinAddressFromPubkey } from '@/lib/grinProofs'
import {
	MAX_OFFER_TTL_SECONDS,
	buildClaimBody,
	buildTransferOfferEvent,
	buildTransferPayUri,
	buyerToPubkeyHex,
	claimErrorMessage,
	extractOffer,
	grinStringToNanogrinString,
	isRetryableClaimError,
	lodgeErrorMessage,
	nanogrinStringToGrinString,
	offerAuthorityBase,
	offerNip05,
	parsePaymentProofJson,
	validateExpiration,
	validateProofAddress,
} from '@/lib/nameTransfer'
import { TRANSFER_OFFER_KIND } from '@/lib/schemas/nameTransfer'

const BUYER_HEX = '1'.repeat(64)
const SELLER_HEX = '2'.repeat(64)

function freshProofAddress(): string {
	return grinAddressFromPubkey(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()))
}

// Parse a Goblin pay-URI the way the wallet's payuri.rs does.
function parsePayUri(uri: string) {
	const rest = uri.replace(/^nostr:/i, '')
	const q = rest.indexOf('?')
	const params = new URLSearchParams(rest.slice(q + 1))
	return {
		recipient: rest.slice(0, q),
		amount: params.get('amount'),
		proof: params.get('proof'),
		order: params.get('order'),
	}
}

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

describe('buildTransferOfferEvent (spec section 3)', () => {
	const proofAddress = freshProofAddress()
	const expiration = Math.floor(Date.now() / 1000) + 3600
	const event = buildTransferOfferEvent({
		name: 'alice',
		domain: 'goblin.st',
		buyerPubkeyHex: BUYER_HEX,
		priceNanogrin: '500000000381624',
		proofAddress,
		expiration,
	})

	test('kind is 3402 and content is empty', () => {
		expect(event.kind).toBe(TRANSFER_OFFER_KIND)
		expect(event.kind).toBe(3402)
		expect(event.content).toBe('')
	})

	test('tags are in the exact spec order with exact values', () => {
		expect(event.tags).toEqual([
			['name', 'alice'],
			['domain', 'goblin.st'],
			['p', BUYER_HEX],
			['price', '500000000381624'],
			['proof_address', proofAddress],
			['expiration', String(expiration)],
		])
	})

	test('price is preserved as an integer nanogrin string', () => {
		const priceTag = event.tags.find((t) => t[0] === 'price')!
		expect(priceTag[1]).toBe('500000000381624')
		expect(/^\d+$/.test(priceTag[1])).toBe(true)
	})

	test('rejects a non-integer price and a bad buyer key', () => {
		expect(() =>
			buildTransferOfferEvent({ name: 'a', domain: 'd', buyerPubkeyHex: BUYER_HEX, priceNanogrin: '1.5', proofAddress, expiration }),
		).toThrow()
		expect(() =>
			buildTransferOfferEvent({ name: 'a', domain: 'd', buyerPubkeyHex: 'nope', priceNanogrin: '1', proofAddress, expiration }),
		).toThrow()
	})
})

describe('extractOffer / offerNip05 / offerAuthorityBase', () => {
	test('extracts a well-formed offer view from a kind-3402 event', () => {
		const proofAddress = freshProofAddress()
		const expiration = Math.floor(Date.now() / 1000) + 3600
		const view = extractOffer({
			id: 'a'.repeat(64),
			pubkey: SELLER_HEX,
			kind: 3402,
			tags: [
				['name', 'alice'],
				['domain', 'goblin.st'],
				['p', BUYER_HEX],
				['price', '1500000000'],
				['proof_address', proofAddress],
				['expiration', String(expiration)],
			],
		})
		expect(view).not.toBeNull()
		expect(view!.name).toBe('alice')
		expect(view!.buyerPubkeyHex).toBe(BUYER_HEX)
		expect(view!.priceNanogrin).toBe('1500000000')
		expect(offerNip05(view!)).toBe('alice@goblin.st')
		expect(offerAuthorityBase(view!)).toBe('https://goblin.st')
	})

	test('returns null for the wrong kind or a missing tag', () => {
		expect(extractOffer({ kind: 1, tags: [] })).toBeNull()
		expect(extractOffer({ kind: 3402, tags: [['name', 'alice']] })).toBeNull()
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

describe('validateProofAddress', () => {
	test('accepts a valid grin1 address, rejects junk', () => {
		const addr = freshProofAddress()
		expect(validateProofAddress(addr)).toBe(addr.toLowerCase())
		expect(() => validateProofAddress('npub1abc')).toThrow()
		expect(() => validateProofAddress('')).toThrow()
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

describe('parsePaymentProofJson', () => {
	const goodProof = {
		amount: '500000000381624',
		excess: '08b1',
		recipient_address: 'grin1recipient',
		recipient_sig: 'aa',
		sender_address: 'grin1sender',
		sender_sig: 'bb',
	}

	test('parses the six-field proof', () => {
		const parsed = parsePaymentProofJson(JSON.stringify(goodProof))
		expect(parsed).toEqual(goodProof)
	})

	test('reports a missing field clearly', () => {
		const { sender_sig, ...missing } = goodProof
		expect(() => parsePaymentProofJson(JSON.stringify(missing))).toThrow(/sender_sig/)
	})

	test('rejects junk and empty', () => {
		expect(() => parsePaymentProofJson('not json')).toThrow()
		expect(() => parsePaymentProofJson('')).toThrow()
		expect(() => parsePaymentProofJson('{"foo":1}')).toThrow()
	})
})

describe('buildClaimBody', () => {
	test('builds {offer_id, proof} exactly', () => {
		const proof = {
			amount: '1',
			excess: 'a',
			recipient_address: 'grin1r',
			recipient_sig: 'b',
			sender_address: 'grin1s',
			sender_sig: 'c',
		}
		expect(buildClaimBody('offer123', proof)).toEqual({ offer_id: 'offer123', proof })
	})
})

describe('buildTransferPayUri (spec section 9)', () => {
	test('recipient is the proof address, amount is exact decimal GRIN, proof + order set', () => {
		const proofAddress = freshProofAddress()
		const uri = buildTransferPayUri({ proofAddress, priceNanogrin: '500000000381624', offerId: 'offer-abc' })
		const parsed = parsePayUri(uri)
		expect(parsed.recipient).toBe(proofAddress)
		expect(parsed.amount).toBe(nanogrinStringToGrinString('500000000381624'))
		expect(parsed.amount).toBe('500000.000381624')
		expect(parsed.proof).toBe(proofAddress)
		expect(parsed.order).toBe('offer-abc')
	})

	test('a simple 1.5 GRIN price emits the exact decimal', () => {
		const proofAddress = freshProofAddress()
		const parsed = parsePayUri(buildTransferPayUri({ proofAddress, priceNanogrin: '1500000000', offerId: 'o' }))
		expect(parsed.amount).toBe('1.5')
	})
})

describe('error message maps (no em dashes, human copy)', () => {
	test('lodge maps the documented cases', () => {
		expect(lodgeErrorMessage(404)).toMatch(/transfers disabled/i)
		expect(lodgeErrorMessage(403)).toMatch(/not the current owner/i)
		expect(lodgeErrorMessage(409, 'offer_exists')).toMatch(/live offer for this name/i)
		expect(lodgeErrorMessage(409, 'offer_ambiguous')).toMatch(/fresh one-time/i)
		expect(lodgeErrorMessage(400)).toMatch(/invalid/i)
		expect(lodgeErrorMessage(429)).toMatch(/too many requests/i)
	})

	test('claim maps every documented code', () => {
		expect(claimErrorMessage(401, 'not the buyer')).toMatch(/different buyer key/i)
		expect(claimErrorMessage(409, 'offer_consumed')).toMatch(/already been claimed/i)
		expect(claimErrorMessage(409, 'owner_changed')).toMatch(/no longer owned/i)
		expect(claimErrorMessage(409, 'proof_address_mismatch')).toMatch(/exact proof address/i)
		expect(claimErrorMessage(409, 'proof_amount_mismatch')).toMatch(/exactly the listed amount/i)
		expect(claimErrorMessage(409, 'payment_unconfirmed')).toMatch(/not yet confirmed/i)
		expect(claimErrorMessage(409, 'proof_reused')).toMatch(/already been used/i)
		expect(claimErrorMessage(409, 'pubkey already has a name')).toMatch(/release it first/i)
		expect(claimErrorMessage(410, 'offer_revoked')).toMatch(/revoked/i)
		expect(claimErrorMessage(410, 'offer_expired')).toMatch(/expired/i)
	})

	test('payment_unconfirmed is retryable, others are not', () => {
		expect(isRetryableClaimError(409, 'payment_unconfirmed')).toBe(true)
		expect(isRetryableClaimError(409, 'proof_reused')).toBe(false)
		expect(isRetryableClaimError(410, 'offer_expired')).toBe(false)
	})

	test('no message contains an em dash', () => {
		const messages = [
			lodgeErrorMessage(404),
			lodgeErrorMessage(403),
			lodgeErrorMessage(409, 'offer_exists'),
			lodgeErrorMessage(409, 'offer_ambiguous'),
			claimErrorMessage(409, 'proof_amount_mismatch'),
			claimErrorMessage(409, 'pubkey already has a name'),
		]
		for (const m of messages) expect(m).not.toContain('—')
	})
})
