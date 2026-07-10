import { describe, test, expect } from 'bun:test'
import { ProductListingSchema } from '@/lib/schemas/productListing'
import { ShippingOptionSchema } from '@/lib/schemas/shippingOption'

// Write-boundary guard (Option B): the schemas may only validate GRIN-priced
// events, so the app can never author a non-GRIN listing. This complements the
// read-time market-scope filter, which drops foreign-priced listings on read.

function productEvent(priceTag: string[]) {
	return {
		kind: 30402,
		created_at: 1_700_000_000,
		content: '',
		tags: [['d', 'prod-1'], ['title', 'Test product'], priceTag],
	}
}

function shippingEvent(priceTag: string[]) {
	return {
		kind: 30406,
		created_at: 1_700_000_000,
		content: '',
		tags: [['d', 'ship-1'], ['title', 'Standard'], priceTag, ['country', 'US'], ['service', 'standard']],
	}
}

describe('ProductListingSchema currency guard', () => {
	test('accepts a GRIN-priced listing', () => {
		expect(ProductListingSchema.safeParse(productEvent(['price', '1.25', 'GRIN'])).success).toBe(true)
	})

	test('rejects a SATS-priced listing', () => {
		expect(ProductListingSchema.safeParse(productEvent(['price', '1000', 'SATS'])).success).toBe(false)
	})

	test('rejects a BTC-priced listing', () => {
		expect(ProductListingSchema.safeParse(productEvent(['price', '0.001', 'BTC'])).success).toBe(false)
	})

	test('rejects a USD-priced listing', () => {
		expect(ProductListingSchema.safeParse(productEvent(['price', '10', 'USD'])).success).toBe(false)
	})

	test('rejects lowercase "grin" (write side is canonical uppercase GRIN)', () => {
		expect(ProductListingSchema.safeParse(productEvent(['price', '1', 'grin'])).success).toBe(false)
	})
})

describe('ShippingOptionSchema currency guard', () => {
	test('accepts a GRIN-priced shipping option', () => {
		expect(ShippingOptionSchema.safeParse(shippingEvent(['price', '0.5', 'GRIN'])).success).toBe(true)
	})

	test('rejects a SATS-priced shipping option', () => {
		expect(ShippingOptionSchema.safeParse(shippingEvent(['price', '500', 'SATS'])).success).toBe(false)
	})
})
