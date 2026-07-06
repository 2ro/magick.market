/**
 * Pure, unit-testable logic for the NIP-05 name-transfer marketplace
 * (name-transfer-spec sections 3, 4, 6, 9). No React, no network: builds the
 * seller's kind-3402 offer, converts prices exactly, validates buyer/proof
 * inputs, parses the pasted payment proof, builds the claim body and the buyer
 * pay URI, and maps authority error codes to plain human copy.
 *
 * magick never verifies a proof to decide "paid": the authority does that. This
 * module only validates SHAPE and constructs the wire artifacts.
 */
import { nip19 } from 'nostr-tools'
import { buildGoblinPayUri } from './grin'
import { decodeGrinAddress, normalizeGrinAddress } from './grinProofs'
import { PaymentProofSchema, TRANSFER_OFFER_KIND, type PaymentProof } from './schemas/nameTransfer'

/** Maximum offer time-to-live: 30 days, matching the authority's default `transfer_max_offer_ttl`. */
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

/** Validate a seller proof address (grin1/tgrin1) and return its normalized form. Throws on junk. */
export function validateProofAddress(address: string): string {
	const v = address.trim()
	if (!v) throw new Error('Paste a one-time grin1 proof address generated in your Goblin wallet')
	if (!decodeGrinAddress(v)) throw new Error('That is not a valid grin1 slatepack address')
	return normalizeGrinAddress(v)
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
// Offer construction (spec section 3)
// -----------------------------------------------------------------------------

export interface BuildOfferParams {
	name: string
	domain: string
	/** Buyer pubkey, 64 hex (the offer `p` tag). */
	buyerPubkeyHex: string
	/** Price as an integer-nanogrin string. */
	priceNanogrin: string
	/** Fresh one-time grin1 proof address for this sale. */
	proofAddress: string
	/** NIP-40 expiration, unix seconds. */
	expiration: number
}

export interface UnsignedOfferEvent {
	kind: typeof TRANSFER_OFFER_KIND
	content: string
	tags: string[][]
}

/**
 * Build the unsigned kind-3402 offer event template. Tags are emitted in the
 * spec's exact order: name, domain, p, price, proof_address, expiration; content
 * is empty. The caller signs it with the seller's key.
 */
export function buildTransferOfferEvent({
	name,
	domain,
	buyerPubkeyHex,
	priceNanogrin,
	proofAddress,
	expiration,
}: BuildOfferParams): UnsignedOfferEvent {
	if (!/^\d+$/.test(priceNanogrin)) throw new Error('Price must be an integer number of nanogrin')
	if (!HEX64.test(buyerPubkeyHex)) throw new Error('Buyer pubkey must be 64 hex')
	return {
		kind: TRANSFER_OFFER_KIND,
		content: '',
		tags: [
			['name', name],
			['domain', domain],
			['p', buyerPubkeyHex.toLowerCase()],
			['price', priceNanogrin],
			['proof_address', proofAddress],
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
	proofAddress: string
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
	const proofAddress = tag('proof_address')
	const expirationRaw = tag('expiration')
	if (!name || !domain || !p || !price || !proofAddress || !expirationRaw) return null
	if (!/^\d+$/.test(price) || !/^\d+$/.test(expirationRaw)) return null
	return {
		offerId: event.id ?? '',
		name,
		domain,
		buyerPubkeyHex: p,
		priceNanogrin: price,
		proofAddress,
		expiration: Number(expirationRaw),
		sellerPubkeyHex: event.pubkey ?? '',
	}
}

/** The full NIP-05 identifier the offer sells, e.g. "alice@goblin.st". */
export function offerNip05(offer: Pick<TransferOfferView, 'name' | 'domain'>): string {
	return `${offer.name}@${offer.domain}`
}

/** Derive the offer's authority base URL from its `domain` tag (federation rule). */
export function offerAuthorityBase(offer: Pick<TransferOfferView, 'domain'>): string {
	return `https://${offer.domain}`
}

// -----------------------------------------------------------------------------
// Payment proof parsing + claim body (spec section 6)
// -----------------------------------------------------------------------------

const PROOF_FIELDS = ['amount', 'excess', 'recipient_address', 'recipient_sig', 'sender_address', 'sender_sig'] as const

/**
 * Tolerantly parse the pasted six-field payment-proof JSON exported by the
 * Goblin wallet. Returns the validated proof or throws with a clear message.
 */
export function parsePaymentProofJson(text: string): PaymentProof {
	const s = text.trim()
	if (!s) throw new Error('Paste the payment proof your Goblin wallet exported after paying.')
	let obj: unknown
	try {
		obj = JSON.parse(s)
	} catch {
		throw new Error('That does not look like valid JSON. Paste the exact payment proof your wallet exported.')
	}
	const result = PaymentProofSchema.safeParse(obj)
	if (!result.success) {
		const record = (obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {}) as Record<string, unknown>
		const missing = PROOF_FIELDS.filter((f) => !record[f])
		if (missing.length > 0) {
			throw new Error(`The payment proof is missing required field(s): ${missing.join(', ')}. Re-export it from your wallet.`)
		}
		throw new Error('That is not a valid payment proof. It must be the six-field JSON your Goblin wallet exports.')
	}
	return result.data
}

/** Build the claim request body exactly as spec section 6: `{offer_id, proof}`. */
export function buildClaimBody(offerId: string, proof: PaymentProof): { offer_id: string; proof: PaymentProof } {
	return { offer_id: offerId, proof }
}

// -----------------------------------------------------------------------------
// Buyer pay URI (spec section 9)
// -----------------------------------------------------------------------------

/**
 * Build the Goblin pay URI the buyer uses to pay the seller (spec section 9):
 *  - recipient (`to`)   = the offer's proof_address (payment must land on the
 *    exact address the proof will name),
 *  - amount             = the offer price as an exact decimal-GRIN string,
 *  - proof param        = the offer's proof_address (turns proof mode on),
 *  - order param        = the offer id.
 *
 * There is NO GoblinPay instance in this path: the payment goes wallet-to-wallet
 * from the buyer straight to the seller's address.
 */
export function buildTransferPayUri(offer: Pick<TransferOfferView, 'proofAddress' | 'priceNanogrin' | 'offerId'>): string {
	// Guard the exactness contract: only pass through the numeric pay-URI builder
	// when the nanogrin amount is an exactly representable integer.
	const nanogrin = BigInt(offer.priceNanogrin)
	if (nanogrin > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Price is too large to build a pay URI')
	return buildGoblinPayUri({
		to: offer.proofAddress,
		amountNanogrin: Number(nanogrin),
		proofAddress: offer.proofAddress,
		order: offer.offerId,
	})
}

// -----------------------------------------------------------------------------
// Error-code -> human message maps (spec sections 5, 6; no em dashes)
// -----------------------------------------------------------------------------

/** Map a lodge (POST offer) failure to plain human copy. */
export function lodgeErrorMessage(status: number, errorCode?: string): string {
	// Route is only mounted when transfers are enabled; 404 means disabled here.
	if (status === 404) return 'This name authority has transfers disabled.'
	if (errorCode === 'offer_exists') return 'You already have a live offer for this name. Revoke it before creating a new one.'
	if (errorCode === 'offer_ambiguous')
		return 'That proof address is already used by another live offer. Generate a fresh one-time receive address in your Goblin wallet for this sale.'
	if (status === 403) return 'You are not the current owner of this name.'
	if (status === 401) return 'Authentication failed. Sign in with the key that owns this name and try again.'
	if (status === 400) return 'The offer was rejected as invalid. Check the name, price, buyer key, and proof address.'
	if (status === 429) return 'Too many requests. Wait a moment and try again.'
	return errorCode ? `Could not lodge the offer: ${errorCode}` : 'Could not lodge the offer. Try again shortly.'
}

const CLAIM_CODE_MESSAGES: Record<string, string> = {
	offer_consumed: 'This offer has already been claimed.',
	owner_changed: 'The name is no longer owned by the seller, so this offer can no longer be claimed.',
	proof_address_mismatch: 'The payment proof names a different address than this offer. Pay the exact proof address shown in the offer.',
	proof_amount_mismatch:
		'You must pay exactly the listed amount. If you paid a different amount, ask the seller to revoke and relist at the paid amount; your proof stays valid.',
	payment_unconfirmed: 'Payment not yet confirmed on chain, try again in a few minutes.',
	proof_reused: 'This payment proof has already been used for another claim.',
	'pubkey already has a name': 'This key already holds a name; release it first, the offer and proof remain valid, then resubmit.',
	offer_revoked: 'The seller revoked this offer.',
	offer_expired: 'This offer has expired.',
	'not the buyer': 'This offer is for a different buyer key. Claim it with the key named in the offer.',
}

/** Map a claim (POST claim) failure to plain human copy. */
export function claimErrorMessage(status: number, errorCode?: string): string {
	if (errorCode && CLAIM_CODE_MESSAGES[errorCode]) return CLAIM_CODE_MESSAGES[errorCode]
	if (status === 401) return 'Authentication failed. Sign in with the key the offer is for and try again.'
	if (status === 404) return 'Offer not found. It may have been removed.'
	if (status === 410) return 'This offer is no longer live.'
	if (status === 400) return 'The claim or proof was rejected as invalid. Re-export the payment proof from your wallet.'
	if (status === 429) return 'Too many requests. Wait a moment and try again.'
	if (status === 500) return 'The authority had an internal error. Try again shortly.'
	return errorCode ? `Could not complete the claim: ${errorCode}` : 'Could not complete the claim. Try again shortly.'
}

/** True when a failed claim is worth retrying unchanged (payment still settling). */
export function isRetryableClaimError(status: number, errorCode?: string): boolean {
	return errorCode === 'payment_unconfirmed'
}
