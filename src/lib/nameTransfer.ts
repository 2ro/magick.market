/**
 * Pure, unit-testable logic for the NIP-05 name-transfer marketplace. No React,
 * no network: builds the seller's kind-3402 offer, converts prices exactly,
 * validates buyer/expiration inputs, and reads an offer back off a Nostr event.
 *
 * The resale is paid the same way a first-time name purchase is: the buyer pays a
 * REAL GoblinPay invoice minted by the marketplace, and the name is reassigned
 * only after that invoice confirms on-chain. The seller no longer pastes a raw
 * grin1 address; the offer instead carries the GoblinPay `invoice` id (and its
 * hosted `pay_url`) the buyer settles.
 */
import { nip19 } from 'nostr-tools'
import { TRANSFER_OFFER_KIND } from './schemas/nameTransfer'

/** Maximum offer time-to-live: 30 days. */
export const MAX_OFFER_TTL_SECONDS = 2_592_000

const NANOGRIN_PER_GRIN = BigInt(1_000_000_000)
const HEX64 = /^[0-9a-f]{64}$/i

// -----------------------------------------------------------------------------
// Exact GRIN <-> nanogrin string conversion (no float drift, up to 9 dp)
// -----------------------------------------------------------------------------

/**
 * Convert a decimal-GRIN string (e.g. "1.5", "0.000000001", "500000.000381624")
 * to an integer-nanogrin string, exactly, via BigInt. Throws on a malformed
 * amount or more than 9 decimal places.
 */
export function grinStringToNanogrinString(decimal: string): string {
	const s = decimal.trim()
	if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Enter a price as a plain decimal GRIN amount, for example 12.5')
	const [whole, frac = ''] = s.split('.')
	if (frac.length > 9) throw new Error('GRIN has at most 9 decimal places')
	const nanograms = BigInt(whole) * NANOGRIN_PER_GRIN + BigInt(frac.padEnd(9, '0') || '0')
	return nanograms.toString()
}

/**
 * Convert an integer-nanogrin string to a trimmed decimal-GRIN string, exactly,
 * via BigInt (e.g. "500000000381624" -> "500000.000381624"). Throws on a
 * non-integer input.
 */
export function nanogrinStringToGrinString(nanogrin: string): string {
	const s = nanogrin.trim()
	if (!/^\d+$/.test(s)) throw new Error('Price must be an integer number of nanogrin')
	const value = BigInt(s)
	const whole = value / NANOGRIN_PER_GRIN
	const frac = (value % NANOGRIN_PER_GRIN).toString().padStart(9, '0').replace(/0+$/, '')
	return frac ? `${whole.toString()}.${frac}` : whole.toString()
}

// -----------------------------------------------------------------------------
// Input validation helpers
// -----------------------------------------------------------------------------

/** Normalize a buyer identity input (npub or 64-hex) to a 64-hex pubkey. Throws on junk. */
export function buyerToPubkeyHex(input: string): string {
	const v = input.trim()
	if (!v) throw new Error('Enter the buyer npub')
	if (HEX64.test(v)) return v.toLowerCase()
	if (v.startsWith('npub1')) {
		try {
			const decoded = nip19.decode(v)
			if (decoded.type === 'npub' && typeof decoded.data === 'string') return decoded.data
		} catch {
			// fall through to the generic error
		}
	}
	throw new Error('Enter a valid buyer npub (or a 64-character hex pubkey)')
}

/**
 * Validate an offer expiration (unix seconds) is in the future and within
 * MAX_OFFER_TTL_SECONDS of now. `now` defaults to the current unix second.
 */
export function validateExpiration(expiration: number, now: number = Math.floor(Date.now() / 1000)): number {
	if (!Number.isInteger(expiration)) throw new Error('Expiration must be a whole number of unix seconds')
	if (expiration <= now) throw new Error('Expiration must be in the future')
	if (expiration > now + MAX_OFFER_TTL_SECONDS) throw new Error('Expiration can be at most 30 days from now')
	return expiration
}

// -----------------------------------------------------------------------------
// Offer construction
// -----------------------------------------------------------------------------

export interface BuildOfferParams {
	name: string
	domain: string
	/** Buyer pubkey, 64 hex (the offer `p` tag). */
	buyerPubkeyHex: string
	/** Price as an integer-nanogrin string. */
	priceNanogrin: string
	/** GoblinPay invoice id minted for this sale (binds name + buyer + price). */
	invoiceId: string
	/** Hosted GoblinPay pay URL the buyer settles. */
	payUrl: string
	/** NIP-40 expiration, unix seconds. */
	expiration: number
}

export interface UnsignedOfferEvent {
	kind: typeof TRANSFER_OFFER_KIND
	content: string
	tags: string[][]
}

/**
 * Build the unsigned kind-3402 offer event template. Tags: name, domain, p,
 * price, invoice, pay_url, expiration; content is empty. The caller signs it with
 * the seller's key; that signature is the seller's consent to the transfer.
 */
export function buildTransferOfferEvent({
	name,
	domain,
	buyerPubkeyHex,
	priceNanogrin,
	invoiceId,
	payUrl,
	expiration,
}: BuildOfferParams): UnsignedOfferEvent {
	if (!/^\d+$/.test(priceNanogrin)) throw new Error('Price must be an integer number of nanogrin')
	if (!HEX64.test(buyerPubkeyHex)) throw new Error('Buyer pubkey must be 64 hex')
	if (!invoiceId) throw new Error('An offer must carry its GoblinPay invoice id')
	return {
		kind: TRANSFER_OFFER_KIND,
		content: '',
		tags: [
			['name', name],
			['domain', domain],
			['p', buyerPubkeyHex.toLowerCase()],
			['price', priceNanogrin],
			['invoice', invoiceId],
			['pay_url', payUrl],
			['expiration', String(expiration)],
		],
	}
}

// -----------------------------------------------------------------------------
// Offer view / extraction from a kind-3402 event
// -----------------------------------------------------------------------------

export interface TransferOfferView {
	offerId: string
	name: string
	domain: string
	buyerPubkeyHex: string
	priceNanogrin: string
	invoiceId: string
	payUrl: string
	expiration: number
	sellerPubkeyHex: string
}

interface EventLike {
	id?: string
	pubkey?: string
	kind?: number
	tags?: string[][]
}

/** Extract the offer view from a kind-3402 event, or null if it is not a well-formed offer. */
export function extractOffer(event: EventLike): TransferOfferView | null {
	if (!event || event.kind !== TRANSFER_OFFER_KIND || !Array.isArray(event.tags)) return null
	const tag = (k: string) => event.tags!.find((t) => t[0] === k)?.[1]
	const name = tag('name')
	const domain = tag('domain')
	const p = tag('p')
	const price = tag('price')
	const invoiceId = tag('invoice')
	const expirationRaw = tag('expiration')
	if (!name || !domain || !p || !price || !invoiceId || !expirationRaw) return null
	if (!/^\d+$/.test(price) || !/^\d+$/.test(expirationRaw)) return null
	return {
		offerId: event.id ?? '',
		name,
		domain,
		buyerPubkeyHex: p,
		priceNanogrin: price,
		invoiceId,
		payUrl: tag('pay_url') ?? '',
		expiration: Number(expirationRaw),
		sellerPubkeyHex: event.pubkey ?? '',
	}
}

/** The full NIP-05 identifier the offer sells, e.g. "alice@goblin.st". */
export function offerNip05(offer: Pick<TransferOfferView, 'name' | 'domain'>): string {
	return `${offer.name}@${offer.domain}`
}
