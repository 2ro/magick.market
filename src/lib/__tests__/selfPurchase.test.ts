import { describe, test, expect } from 'bun:test'
import { isSelfPurchase, SELF_PURCHASE_MESSAGE } from '@/lib/checkout/selfPurchase'

const BUYER = 'buyerpubkey0000000000000000000000000000000000000000000000000000000000'
const SELLER = 'sellerpubkey000000000000000000000000000000000000000000000000000000000'

describe('isSelfPurchase', () => {
	test('true when the buyer is one of the sellers', () => {
		expect(isSelfPurchase(BUYER, [BUYER])).toBe(true)
		expect(isSelfPurchase(BUYER, [SELLER, BUYER])).toBe(true)
	})

	test('false for a normal buyer purchasing from other sellers', () => {
		expect(isSelfPurchase(BUYER, [SELLER])).toBe(false)
		expect(isSelfPurchase(BUYER, [SELLER, 'another'])).toBe(false)
	})

	test('false for an anonymous guest (no buyer pubkey) or empty seller set', () => {
		expect(isSelfPurchase(undefined, [SELLER])).toBe(false)
		expect(isSelfPurchase(null, [BUYER])).toBe(false)
		expect(isSelfPurchase(BUYER, [])).toBe(false)
		expect(isSelfPurchase(BUYER, [undefined, null, ''])).toBe(false)
	})

	test('exposes a clear refusal message', () => {
		expect(SELF_PURCHASE_MESSAGE).toContain("can't buy your own")
	})
})
