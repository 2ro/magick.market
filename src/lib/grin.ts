/**
 * GRIN money primitives for magick.market.
 *
 * All internal integer amounts in the app are NANOGRIN (the Grin base unit).
 * 1 GRIN = 1,000,000,000 nanogrin (10^9).
 *
 * Listings (NIP-99 / Gamma kind 30402) are priced in decimal GRIN; the cart,
 * orders, payment requests and receipts carry integer nanogrin.
 */

export const GRIN_CURRENCY = 'GRIN'
export const NANOGRIN_PER_GRIN = 1_000_000_000

/** Convert a decimal GRIN amount to integer nanogrin. */
export function grinToNanogrin(amountGrin: number): number {
	if (!Number.isFinite(amountGrin)) return 0
	return Math.round(amountGrin * NANOGRIN_PER_GRIN)
}

/** Convert integer nanogrin to decimal GRIN. */
export function nanogrinToGrin(nanogrin: number): number {
	if (!Number.isFinite(nanogrin)) return 0
	return nanogrin / NANOGRIN_PER_GRIN
}

/**
 * Format a nanogrin amount as a human readable GRIN string, e.g. "1.25".
 * Shows up to 9 decimals, trimming trailing zeros.
 */
export function formatGrin(nanogrin: number): string {
	const grin = nanogrinToGrin(Math.round(nanogrin))
	const fixed = grin.toFixed(9).replace(/\.?0+$/, '')
	return fixed === '' || fixed === '-' ? '0' : fixed
}

/** Format a nanogrin amount with the currency suffix, e.g. "1.25 GRIN". */
export function formatGrinAmount(nanogrin: number): string {
	return `${formatGrin(nanogrin)} ${GRIN_CURRENCY}`
}

/**
 * Mint a high-entropy opaque invoice number.
 *
 * This is the load-bearing bridge between the anonymous order (signed by the
 * buyer's ephemeral key) and the Grin payment (sent from the buyer's Goblin
 * wallet): it rides in the Goblin pay-URI `memo` and on the kind 16 order.
 * 96 bits of entropy, hex, prefixed for recognisability: MM-<24 hex chars>.
 */
export function mintInvoiceNumber(): string {
	const bytes = new Uint8Array(12)
	crypto.getRandomValues(bytes)
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
	return `MM-${hex.toUpperCase()}`
}

export interface GoblinPayUriParams {
	/** Recipient: a Goblin nprofile (nprofile1...), npub, or Grin slatepack address (grin1.../tgrin1...). */
	to: string
	/** Amount in integer nanogrin. */
	amountNanogrin: number
	/** Opaque invoice number carried to the seller with the payment. */
	memo?: string
}

/**
 * Build the Goblin pay deeplink / QR payload in the Goblin wallet's CANONICAL
 * pay-URI format — the exact shape its scanner/deeplink parser (payuri.rs)
 * accepts:
 *
 *   nostr:<recipient>?amount=<decimal GRIN>&memo=<percent-encoded>
 *
 * - `<recipient>`: the nprofile/npub (Grin-over-Nostr) or Grin slatepack
 *   address, carried verbatim in the URI path. The wallet strips the `nostr:`
 *   scheme and feeds the remainder straight to its recipient resolver.
 * - `amount`: DECIMAL GRIN (e.g. "1.5", "0.25", "0.000000001"), converted here
 *   from the app's internal integer nanogrin. The wallet validates it with
 *   Grin's own `amount_from_hr_string`, so it MUST be a plain decimal-GRIN
 *   string, never nanogrin.
 * - `memo`: the opaque invoice number, RFC-3986 percent-encoded (space -> %20,
 *   never `+`) to match the wallet's percent-decoder.
 *
 * The wallet carries `memo` into the payment message so the seller can
 * correlate the payment with the order.
 */
export function buildGoblinPayUri({ to, amountNanogrin, memo }: GoblinPayUriParams): string {
	// The wallet parses amounts as decimal GRIN (via Grin's amount_from_hr_string),
	// so convert from our internal nanogrin and clamp away negatives / non-finite.
	const amountGrin = formatGrin(Math.max(0, Math.round(amountNanogrin)))
	let query = `amount=${amountGrin}`
	// encodeURIComponent gives RFC-3986 percent-encoding (space -> %20, not `+`)
	// so the memo round-trips through the wallet's percent-decoder exactly.
	if (memo) query += `&memo=${encodeURIComponent(memo)}`
	return `nostr:${to}?${query}`
}

/**
 * Loose shape check for a Goblin payment address a seller can advertise:
 * an nprofile/npub (preferred, Grin-over-Nostr) or a Grin slatepack address.
 * Full validation is the wallet's job; this only guards obvious mistakes.
 */
export function isValidGoblinPayAddress(value: string): boolean {
	const v = value.trim()
	if (!v) return false
	if (/^nprofile1[02-9ac-hj-np-z]+$/i.test(v)) return true
	if (/^npub1[02-9ac-hj-np-z]+$/i.test(v)) return true
	if (/^t?grin1[02-9ac-hj-np-z]{20,}$/i.test(v)) return true
	return false
}

/**
 * Best-effort client-side shape check of a Grin payment proof pasted from
 * Goblin. Real verification (receiver signature + kernel on-chain) is the
 * seller's Goblin wallet's job; the market only carries the proof.
 */
export function looksLikeGrinPaymentProof(value: string): boolean {
	const v = value.trim()
	if (v.length < 16) return false
	// Accept JSON payment proofs, armored proofs, or hex/base64-ish blobs.
	if (v.startsWith('{') && v.endsWith('}')) return true
	if (/^[A-Za-z0-9+/=._\-\s]+$/.test(v)) return true
	return false
}
