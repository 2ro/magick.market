/**
 * Market scoping — the single source of truth for WHAT content the shared
 * magick.market catalog is allowed to show.
 *
 * The upstream marketplace discovered products/collections by event KIND alone
 * (`{ kinds: [30402] }`), so every NIP-99/Gamma listing on a connected relay
 * leaked into the catalog — including Bitcoin/Lightning marketplaces. This
 * module scopes the default market two ways:
 *
 *  1. ADMIN allowlist — the market operator publishes a NIP-51 people list
 *     (kind 30000, d-tag `market_merchants`) naming the merchants whose stalls
 *     make up the market. When present, the default catalog shows ONLY those
 *     merchants. It is NOT the relay firehose and NOT the viewer's follow list.
 *     CLOSED BY DEFAULT: when the operator has published no such list, the market
 *     scopes to the operator's OWN pubkey (from app settings/config) — a fresh
 *     instance shows only the operator's own stall, never the relay firehose.
 *     Adding merchants via the dashboard opens it up.
 *
 *  2. GRIN-only — Bitcoin never meshes in. Any listing carrying a
 *     Lightning/zap/eCash payment-rail tag is always dropped; in the
 *     admin-scoped market, non-GRIN priced listings are dropped too.
 *
 * A viewer's own IMPORTED sources are a separate, device-local, non-federating
 * scope (see `stores/imported-sources.ts`) and never mesh into this catalog.
 */
import type { NDKEvent, NDKFilter } from '@nostr-dev-kit/ndk'
import { fetchLatestAppEvent } from '@/lib/stores/ndk'
import { configStore } from '@/lib/stores/config'
import { GRIN_CURRENCY } from '@/lib/grin'

/** NIP-51 people list the operator publishes to name the market's merchants. */
export const MERCHANT_ALLOWLIST_KIND = 30000
export const MERCHANT_ALLOWLIST_DTAG = 'market_merchants'

/**
 * Tag names that mark a listing as Bitcoin / Lightning / eCash. GRIN-only:
 * anything carrying one of these never meshes into the market (NIP-57 zap
 * splits, Lightning `lnurl`/`bolt11`, LNURL-pay `lud06`/`lud16`, Cashu/nutzap).
 */
const BITCOIN_RAIL_TAGS = new Set(['zap', 'lightning', 'lnurl', 'bolt11', 'lud06', 'lud16', 'cashu', 'nutzap'])

/** True if the event carries any Bitcoin/Lightning/eCash payment-rail tag. */
export const hasBitcoinRail = (event: NDKEvent): boolean => event.tags.some((t) => BITCOIN_RAIL_TAGS.has(t[0]))

/**
 * True if the event satisfies the GRIN price rule.
 *
 * Product listings (kind 30402) must be explicitly priced in GRIN — a listing
 * with no price tag or a non-GRIN currency is rejected, because this app has no
 * way to check out with it (same semantics as `isGrinPricedProduct` in
 * queries/products.tsx). Non-product events (e.g. kind 30405 collections) carry
 * no price of their own and are currency-neutral.
 */
export const isGrinPriced = (event: NDKEvent): boolean => {
	const currency = event.tags.find((t) => t[0] === 'price')?.[2]
	if (currency) return currency.toUpperCase() === GRIN_CURRENCY
	return event.kind !== 30402
}

/**
 * Filter a batch of market events for the GRIN-only invariant.
 *  - Always drops anything carrying a Bitcoin/Lightning/eCash payment-rail tag.
 *  - When `enforceCurrency`, also drops products not priced in GRIN. All public
 *    browse/search/detail surfaces enforce this; the one exception is the
 *    seller's own dashboard (fetchProductsByPubkey), so a seller can still see
 *    and fix a mis-tagged listing of their own.
 */
export const filterGrinOnly = <T extends NDKEvent>(events: T[], enforceCurrency: boolean): T[] =>
	events.filter((e) => !hasBitcoinRail(e) && (!enforceCurrency || isGrinPriced(e)))

// --- ADMIN MERCHANT ALLOWLIST -------------------------------------------------

/**
 * Resolve the effective merchant allowlist from the operator's published p-tag
 * list and the operator's own pubkey. CLOSED BY DEFAULT: an empty/absent list
 * falls back to `[ownerPubkey]`, so a fresh instance scopes to the operator's own
 * stall rather than the relay firehose. Returns [] only when no operator pubkey is
 * configured at all (the sole unscoped fallback). Pure — safe to unit-test.
 */
export const resolveAllowlist = (listed: string[], ownerPubkey: string | undefined): string[] => {
	if (!ownerPubkey) return []
	const unique = Array.from(new Set(listed))
	return unique.length > 0 ? unique : [ownerPubkey]
}

/**
 * Narrow a browse filter to the allowlist's authors, or leave it unscoped when the
 * allowlist is empty (no operator pubkey configured). Pure — safe to unit-test.
 */
export const buildScopedFilter = (filter: NDKFilter, allowlist: string[]): { filter: NDKFilter; scoped: boolean } => {
	if (allowlist.length === 0) return { filter, scoped: false }
	return { filter: { ...filter, authors: allowlist }, scoped: true }
}

/**
 * Keep only pubkeys on the allowlist; an empty allowlist is a passthrough (unscoped).
 * Used to scope pubkey lists (community merchants, search-by-seller). Pure.
 */
export const filterPubkeysToAllowlist = (pubkeys: string[], allowlist: string[]): string[] =>
	allowlist.length === 0 ? pubkeys : pubkeys.filter((pk) => allowlist.includes(pk))

let cachedAllowlist: { pubkeys: string[]; fetchedAt: number } | null = null
const ALLOWLIST_TTL_MS = 60_000

/** Drop the cached allowlist (call after the operator edits the merchant list). */
export const clearMerchantAllowlistCache = (): void => {
	cachedAllowlist = null
}

/**
 * The operator-curated set of merchant pubkeys.
 *
 * CLOSED BY DEFAULT: when the operator has published no `market_merchants` list
 * (or published an empty one), this returns `[appPubkey]` — the operator's own
 * pubkey — so a fresh / self-hosted instance scopes the market to the operator's
 * own stall instead of leaking the connected relay's firehose. Publishing a list
 * via the dashboard replaces this with the named merchants.
 *
 * Returns [] only when no operator pubkey is configured at all (no app settings),
 * in which case the market cannot be scoped to anyone and falls back to unscoped.
 * Cached briefly so the browse queries don't refetch the list on every page.
 */
export const getMerchantAllowlist = async (): Promise<string[]> => {
	const appPubkey = configStore.state.config.appPublicKey
	if (!appPubkey) return []
	if (cachedAllowlist && Date.now() - cachedAllowlist.fetchedAt < ALLOWLIST_TTL_MS) {
		return cachedAllowlist.pubkeys
	}
	const event = await fetchLatestAppEvent({
		kinds: [MERCHANT_ALLOWLIST_KIND],
		authors: [appPubkey],
		'#d': [MERCHANT_ALLOWLIST_DTAG],
	})
	const listed = event ? event.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]) : []
	// Closed by default: with no configured allowlist, scope to the operator's own pubkey.
	const pubkeys = resolveAllowlist(listed, appPubkey)
	cachedAllowlist = { pubkeys, fetchedAt: Date.now() }
	return pubkeys
}

/**
 * Scope a browse filter to the admin merchant allowlist.
 *
 * Returns the filter narrowed to allowlisted merchants (`authors`), plus `scoped`
 * telling the caller to also enforce GRIN currency on the results. Because the
 * allowlist is CLOSED BY DEFAULT (see `getMerchantAllowlist`), this scopes to the
 * operator's own pubkey on a fresh instance rather than leaking the relay
 * firehose. The filter is only ever returned unchanged (and `scoped` false) when
 * no operator pubkey is configured at all — the sole unscoped fallback.
 */
export const applyMerchantScope = async (filter: NDKFilter): Promise<{ filter: NDKFilter; scoped: boolean }> => {
	return buildScopedFilter(filter, await getMerchantAllowlist())
}

/** Keep only events authored by an allowlisted merchant (used to post-filter search). */
export const filterToAllowlist = <T extends NDKEvent>(events: T[], allowlist: string[]): T[] => {
	if (allowlist.length === 0) return events
	const allowed = new Set(allowlist)
	return events.filter((e) => allowed.has(e.pubkey))
}
