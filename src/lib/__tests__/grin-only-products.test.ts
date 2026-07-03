import { describe, test, expect } from 'bun:test'
import { isGrinPricedProduct } from '@/queries/products'
import { NDKEvent } from '@nostr-dev-kit/ndk'

function productEvent(priceTag: string[] | undefined): NDKEvent {
	return { tags: priceTag ? [priceTag] : [] } as unknown as NDKEvent
}

describe('isGrinPricedProduct (GRIN-only marketplace guard)', () => {
	test('accepts a GRIN-priced listing', () => {
		expect(isGrinPricedProduct(productEvent(['price', '10', 'GRIN']))).toBe(true)
	})

	test('accepts lowercase "grin" (case-insensitive)', () => {
		expect(isGrinPricedProduct(productEvent(['price', '10', 'grin']))).toBe(true)
	})

	test('rejects a Lightning/Bitcoin-priced listing (SATS)', () => {
		expect(isGrinPricedProduct(productEvent(['price', '1000', 'SATS']))).toBe(false)
	})

	test('rejects a BTC-priced listing', () => {
		expect(isGrinPricedProduct(productEvent(['price', '0.001', 'BTC']))).toBe(false)
	})

	test('rejects a fiat-priced listing (USD)', () => {
		expect(isGrinPricedProduct(productEvent(['price', '10', 'USD']))).toBe(false)
	})

	test('rejects a listing with no price tag at all', () => {
		expect(isGrinPricedProduct(productEvent(undefined))).toBe(false)
	})
})
