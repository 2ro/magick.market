import { z } from 'zod'

// =============================================================================
// NIP-05 Name Transfer (name-transfer-spec sections 3, 6)
// =============================================================================

/** Kind of a sale offer event (name-transfer-spec section 3). */
export const TRANSFER_OFFER_KIND = 3402

// -----------------------------------------------------------------------------
// Payment proof (spec section 6 claim body / section 2 wallet export)
// -----------------------------------------------------------------------------

/**
 * The Grin payment proof exactly as `retrieve_payment_proof` exports it: six
 * string fields, passed through to the authority unmodified (spec section 6).
 * `.strict()` keeps the object to exactly these keys so malformed pastes fail.
 */
export const PaymentProofSchema = z
	.object({
		amount: z.string().min(1),
		excess: z.string().min(1),
		recipient_address: z.string().min(1),
		recipient_sig: z.string().min(1),
		sender_address: z.string().min(1),
		sender_sig: z.string().min(1),
	})
	.strict()

export type PaymentProof = z.infer<typeof PaymentProofSchema>

// -----------------------------------------------------------------------------
// Offer event shape (kind 3402, spec section 3)
// -----------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/i
const NANOGRIN_INT = /^\d+$/

/** A single Nostr tag: a non-empty array of strings. */
const RawTagSchema = z.array(z.string()).min(1)

/**
 * Validate the required tags of a kind-3402 offer, in order: name, domain, p,
 * price, invoice, expiration. This checks presence and value shape; the
 * marketplace server verifies ownership, signature, freshness, and the confirmed
 * GoblinPay invoice.
 */
export const TransferOfferTagsSchema = z.array(RawTagSchema).superRefine((tags, ctx) => {
	const find = (k: string) => tags.find((t) => t[0] === k)

	const name = find('name')
	if (!name || !name[1]) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'missing name tag' })

	const domain = find('domain')
	if (!domain || !domain[1]) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'missing domain tag' })

	const p = find('p')
	if (!p || !HEX64.test(p[1] ?? '')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'p tag must be a 64-hex buyer pubkey' })

	const price = find('price')
	if (!price || !NANOGRIN_INT.test(price[1] ?? ''))
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'price tag must be integer nanogrin as a string' })

	const invoice = find('invoice')
	if (!invoice || !invoice[1]) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'missing invoice tag' })

	const expiration = find('expiration')
	if (!expiration || !NANOGRIN_INT.test(expiration[1] ?? ''))
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expiration tag must be unix seconds as a string' })
})

/**
 * Full kind-3402 offer event as it appears on Nostr / in the authority read.
 * Signature/id are validated by the authority, not here; magick validates shape.
 */
export const TransferOfferEventSchema = z.object({
	id: z.string().optional(),
	pubkey: z.string().regex(HEX64, 'seller pubkey must be 64 hex'),
	created_at: z.number().int().nonnegative(),
	kind: z.literal(TRANSFER_OFFER_KIND),
	tags: TransferOfferTagsSchema,
	content: z.string(),
	sig: z.string().optional(),
})

export type TransferOfferEvent = z.infer<typeof TransferOfferEventSchema>

// -----------------------------------------------------------------------------
// Authority responses (spec section 6)
// -----------------------------------------------------------------------------

/** Error body shape: `{"error": "<string>"}`. */
export const AuthorityErrorSchema = z.object({ error: z.string() })

/** POST /api/v1/transfer/offer -> 201. */
export const LodgeOfferResponseSchema = z.object({
	offer_id: z.string().regex(HEX64),
	name: z.string(),
	expires_at: z.number().int(),
})
export type LodgeOfferResponse = z.infer<typeof LodgeOfferResponseSchema>

/** Offer lifecycle status, per the authority state machine (spec section 5). */
export const OfferStatusSchema = z.enum(['live', 'consumed', 'revoked', 'expired'])
export type OfferStatus = z.infer<typeof OfferStatusSchema>

/** GET /api/v1/transfer/offer/{offer_id} -> 200. */
export const OfferReadResponseSchema = z.object({
	offer: TransferOfferEventSchema,
	status: OfferStatusSchema,
})
export type OfferReadResponse = z.infer<typeof OfferReadResponseSchema>

/** DELETE /api/v1/transfer/offer/{offer_id} -> 200. */
export const RevokeOfferResponseSchema = z.object({
	offer_id: z.string().regex(HEX64),
	status: z.literal('revoked'),
})
export type RevokeOfferResponse = z.infer<typeof RevokeOfferResponseSchema>

/** POST /api/v1/transfer/claim -> 201 (or 200 idempotent retry). */
export const ClaimResponseSchema = z.object({
	name: z.string(),
	nip05: z.string(),
	pubkey: z.string(),
})
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>

/** GET /api/v1/by-pubkey/{pubkey} -> 200 (404 handled as null by the client). */
export const ByPubkeyResponseSchema = z.object({
	name: z.string(),
	pubkey: z.string(),
})
export type ByPubkeyResponse = z.infer<typeof ByPubkeyResponseSchema>
