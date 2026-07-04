import { describe, test, expect } from 'bun:test'
import type { NDKEvent } from '@nostr-dev-kit/ndk'
import { hasBitcoinRail, isGrinPriced, filterGrinOnly, filterToAllowlist } from '@/lib/market-scope'

// Minimal stand-in for an NDKEvent — the scope filters only read `tags`/`pubkey`.
const ev = (tags: string[][], pubkey = 'a'.repeat(64)): NDKEvent => ({ tags, pubkey }) as unknown as NDKEvent

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
	test('no price tag (e.g. a collection) is currency-neutral', () => {
		expect(isGrinPriced(ev([['d', 'coll']]))).toBe(true)
	})
})

describe('filterGrinOnly', () => {
	test('always drops Bitcoin-rail-tagged listings, in both scopes', () => {
		expect(filterGrinOnly([grinProduct, zapTagged, lightningTagged], false)).toEqual([grinProduct])
		expect(filterGrinOnly([grinProduct, zapTagged, lightningTagged], true)).toEqual([grinProduct])
	})
	test('unscoped keeps non-GRIN priced listings (display-as-GRIN legacy)', () => {
		expect(filterGrinOnly([grinProduct, satsProduct], false)).toEqual([grinProduct, satsProduct])
	})
	test('admin-scoped market drops non-GRIN priced listings', () => {
		expect(filterGrinOnly([grinProduct, satsProduct], true)).toEqual([grinProduct])
	})
})

describe('filterToAllowlist', () => {
	const a = ev([['d', '1']], 'a'.repeat(64))
	const b = ev([['d', '2']], 'b'.repeat(64))
	test('empty allowlist is a passthrough', () => {
		expect(filterToAllowlist([a, b], [])).toEqual([a, b])
	})
	test('keeps only allowlisted authors', () => {
		expect(filterToAllowlist([a, b], ['a'.repeat(64)])).toEqual([a])
	})
})
