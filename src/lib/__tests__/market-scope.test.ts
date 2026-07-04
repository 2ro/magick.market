import { describe, test, expect } from 'bun:test'
import type { NDKEvent } from '@nostr-dev-kit/ndk'
import { hasBitcoinRail, isGrinPriced, filterGrinOnly, filterToAllowlist } from '@/lib/market-scope'

// Minimal stand-in for an NDKEvent — the scope filters only read `kind`/`tags`/`pubkey`.
const ev = (tags: string[][], kind = 30402, pubkey = 'a'.repeat(64)): NDKEvent => ({ kind, tags, pubkey }) as unknown as NDKEvent

const grinProduct = ev([
	['d', 'widget'],
	['title', 'Grin Widget'],
	['price', '3', 'GRIN'],
])
const satsProduct = ev([
	['d', 'btc-wallet'],
	['title', 'Bitcoin Hardware Wallet'],
	['price', '50000', 'SATS'],
])
const zapTagged = ev([
	['d', 'zappy'],
	['title', 'Zappy'],
	['price', '1', 'GRIN'],
	['zap', 'b'.repeat(64), '5'],
])
const lightningTagged = ev([
	['d', 'ln'],
	['title', 'LN thing'],
	['price', '1', 'GRIN'],
	['lud16', 'sat@walletofsatoshi.com'],
])

describe('hasBitcoinRail', () => {
	test('detects zap / lightning / lnurl / eCash tags', () => {
		expect(hasBitcoinRail(zapTagged)).toBe(true)
		expect(hasBitcoinRail(lightningTagged)).toBe(true)
		expect(hasBitcoinRail(ev([['bolt11', 'lnbc1...']]))).toBe(true)
		expect(hasBitcoinRail(ev([['cashu', 'token']]))).toBe(true)
	})
	test('passes a plain GRIN listing', () => {
		expect(hasBitcoinRail(grinProduct)).toBe(false)
	})
})

describe('isGrinPriced', () => {
	test('GRIN price (any case) passes', () => {
		expect(isGrinPriced(grinProduct)).toBe(true)
		expect(isGrinPriced(ev([['price', '3', 'grin']]))).toBe(true)
	})
	test('non-GRIN currency fails', () => {
		expect(isGrinPriced(satsProduct)).toBe(false)
		expect(isGrinPriced(ev([['price', '10', 'USD']]))).toBe(false)
	})
	test('a product (30402) with no price tag fails — nothing to check out with', () => {
		expect(isGrinPriced(ev([['d', 'unpriced']], 30402))).toBe(false)
	})
	test('a non-product event (e.g. 30405 collection) with no price tag is currency-neutral', () => {
		expect(isGrinPriced(ev([['d', 'coll']], 30405))).toBe(true)
	})
})

describe('filterGrinOnly', () => {
	test('always drops Bitcoin-rail-tagged listings, with or without currency enforcement', () => {
		expect(filterGrinOnly([grinProduct, zapTagged, lightningTagged], false)).toEqual([grinProduct])
		expect(filterGrinOnly([grinProduct, zapTagged, lightningTagged], true)).toEqual([grinProduct])
	})
	test('seller-dashboard mode (enforceCurrency=false) keeps a mis-tagged non-GRIN listing visible to its owner', () => {
		expect(filterGrinOnly([grinProduct, satsProduct], false)).toEqual([grinProduct, satsProduct])
	})
	test('public surfaces (enforceCurrency=true) drop non-GRIN priced listings', () => {
		expect(filterGrinOnly([grinProduct, satsProduct], true)).toEqual([grinProduct])
	})
	test('unified invariant: one pass drops BOTH a non-GRIN-priced listing and a zap-tagged listing', () => {
		// Union of the two independent GRIN-only implementations that met in the
		// github/master merge: isGrinPricedProduct (price currency) and
		// filterGrinOnly (Bitcoin payment-rail tags). Neither semantic is lost.
		expect(filterGrinOnly([satsProduct, zapTagged, grinProduct], true)).toEqual([grinProduct])
	})
})

describe('filterToAllowlist', () => {
	const a = ev([['d', '1']], 30402, 'a'.repeat(64))
	const b = ev([['d', '2']], 30402, 'b'.repeat(64))
	test('empty allowlist is a passthrough', () => {
		expect(filterToAllowlist([a, b], [])).toEqual([a, b])
	})
	test('keeps only allowlisted authors', () => {
		expect(filterToAllowlist([a, b], ['a'.repeat(64)])).toEqual([a])
	})
})
