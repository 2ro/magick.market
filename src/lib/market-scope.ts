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

/** True if the listing has no price or is priced in GRIN. */
export const isGrinPriced = (event: NDKEvent): boolean => {
	const currency = event.tags.find((t) => t[0] === 'price')?.[2]
	return !currency || currency.toUpperCase() === GRIN_CURRENCY
}

/**
 * Filter a batch of market events for the GRIN-only invariant.
 *  - Always drops anything carrying a Bitcoin/Lightning/eCash payment-rail tag.
 *  - When `enforceCurrency` (the admin-scoped market), also drops non-GRIN prices.
 */
export const filterGrinOnly = <T extends NDKEvent>(events: T[], enforceCurrency: boolean): T[] =>
	events.filter((e) => !hasBitcoinRail(e) && (!enforceCurrency || isGrinPriced(e)))

// --- ADMIN MERCHANT ALLOWLIST -------------------------------------------------

let cachedAllowlist: { pubkeys: string[]; fetchedAt: number } | null = null
const ALLOWLIST_TTL_MS = 60_000

/** Drop the cached allowlist (call after the operator edits the merchant list). */
export const clearMerchantAllowlistCache = (): void => {
	cachedAllowlist = null
}

/**
 * The operator-curated set of merchant pubkeys, or [] when the operator has not
 * configured one (fresh / self-hosted / dev instance). Cached briefly so the
 * browse queries don't refetch the list on every page.
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
	const pubkeys = event ? Array.from(new Set(event.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]))) : []
	cachedAllowlist = { pubkeys, fetchedAt: Date.now() }
	return pubkeys
}

/**
 * Scope a browse filter to the admin merchant allowlist.
 *
 * Returns the filter narrowed to allowlisted merchants (`authors`) when the
 * operator has configured one, plus `scoped` telling the caller to also enforce
 * GRIN currency on the results. When no allowlist is configured the filter is
 * returned unchanged and `scoped` is false, so a fresh/self-hosted instance
 * still shows the connected relay's content rather than an empty market.
 */
export const applyMerchantScope = async (filter: NDKFilter): Promise<{ filter: NDKFilter; scoped: boolean }> => {
	const allowlist = await getMerchantAllowlist()
	if (allowlist.length === 0) return { filter, scoped: false }
	return { filter: { ...filter, authors: allowlist }, scoped: true }
}

/** Keep only events authored by an allowlisted merchant (used to post-filter search). */
export const filterToAllowlist = <T extends NDKEvent>(events: T[], allowlist: string[]): T[] => {
	if (allowlist.length === 0) return events
	const allowed = new Set(allowlist)
	return events.filter((e) => allowed.has(e.pubkey))
}
