import { describe, test, expect } from 'bun:test'
import type { NDKEvent } from '@nostr-dev-kit/ndk'
import {
	hasBitcoinRail,
	isGrinPriced,
	filterGrinOnly,
	filterToAllowlist,
	resolveAllowlist,
	resolveOwnerStallPubkey,
	buildScopedFilter,
	filterPubkeysToAllowlist,
} from '@/lib/market-scope'

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

const owner = 'o'.repeat(64)
const m1 = '1'.repeat(64)
const m2 = '2'.repeat(64)

describe('resolveOwnerStallPubkey — closed-default scopes to the operator STALL key, not the app key', () => {
	const appKey = 'a'.repeat(64) // appPublicKey (automation key; never authors a product)
	// Regression: the market used to scope the closed-default catalog to appPublicKey,
	// which authors no products, so every browse surface came back empty. It must scope
	// to the operator's own stall key (appSettings.ownerPk) instead.
	test('prefers the operator ownerPk over the app automation key', () => {
		expect(resolveOwnerStallPubkey(owner, appKey)).toBe(owner)
	})
	test('the closed-default allowlist ends up scoped to the operator stall, so their own products pass', () => {
		const allowlist = resolveAllowlist([], resolveOwnerStallPubkey(owner, appKey))
		expect(allowlist).toEqual([owner])
		expect(filterPubkeysToAllowlist([owner, m1], allowlist)).toEqual([owner])
	})
	test('falls back to the app key only when no ownerPk is configured', () => {
		expect(resolveOwnerStallPubkey(undefined, appKey)).toBe(appKey)
	})
	test('undefined when neither key is configured (market cannot be scoped)', () => {
		expect(resolveOwnerStallPubkey(undefined, undefined)).toBeUndefined()
		expect(resolveOwnerStallPubkey('', '')).toBeUndefined()
	})
})

describe('resolveAllowlist — closed by default', () => {
	test('no published list scopes to the operator OWN pubkey (never the firehose)', () => {
		expect(resolveAllowlist([], owner)).toEqual([owner])
	})
	test('a published list scopes to exactly the listed merchants', () => {
		expect(resolveAllowlist([m1, m2], owner)).toEqual([m1, m2])
	})
	test('dedupes the listed merchants', () => {
		expect(resolveAllowlist([m1, m1, m2], owner)).toEqual([m1, m2])
	})
	test('no operator pubkey configured at all → [] (the sole unscoped fallback)', () => {
		expect(resolveAllowlist([], undefined)).toEqual([])
		expect(resolveAllowlist([m1], undefined)).toEqual([])
	})
})

describe('buildScopedFilter', () => {
	test('closed-default allowlist narrows the browse filter to the operator only', () => {
		const { filter, scoped } = buildScopedFilter({ kinds: [30402] }, resolveAllowlist([], owner))
		expect(scoped).toBe(true)
		expect(filter.authors).toEqual([owner])
	})
	test('configured allowlist narrows to exactly the listed merchants', () => {
		const { filter, scoped } = buildScopedFilter({ kinds: [30402] }, [m1, m2])
		expect(scoped).toBe(true)
		expect(filter.authors).toEqual([m1, m2])
	})
	test('empty allowlist (no operator configured) leaves the filter unscoped', () => {
		const base = { kinds: [30402] }
		const { filter, scoped } = buildScopedFilter(base, [])
		expect(scoped).toBe(false)
		expect(filter.authors).toBeUndefined()
	})
})

describe('filterPubkeysToAllowlist — community merchants / search-by-seller', () => {
	test('community merchants list respects the allowlist (drops non-listed authors)', () => {
		expect(filterPubkeysToAllowlist([owner, m1, m2], [owner, m1])).toEqual([owner, m1])
	})
	test('closed-default: only the operator survives when nothing is published', () => {
		expect(filterPubkeysToAllowlist([owner, m1, m2], resolveAllowlist([], owner))).toEqual([owner])
	})
	test('empty allowlist is a passthrough', () => {
		expect(filterPubkeysToAllowlist([owner, m1], [])).toEqual([owner, m1])
	})
})

describe('/imported is unaffected by the allowlist', () => {
	// The /imported surface gates ONLY on filterGrinOnly (see routes/imported.tsx and
	// fetchProductsByPubkey), never on the merchant allowlist — importing a source is
	// the deliberate way to view a non-allowlisted merchant. A foreign-authored GRIN
	// product still passes filterGrinOnly regardless of any allowlist.
	const foreign = ev(
		[
			['d', 'x'],
			['title', 'Foreign GRIN item'],
			['price', '2', 'GRIN'],
		],
		30402,
		'f'.repeat(64),
	)
	test('a non-allowlisted GRIN listing is kept by the imported-sources gate', () => {
		expect(filterGrinOnly([foreign], true)).toEqual([foreign])
	})
})
