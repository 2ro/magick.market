/**
 * Pure decision logic for granting a paid name (NIP-05 username or vanity URL)
 * against a REAL GoblinPay invoice.
 *
 * magick.market's name purchases are real wallet-to-wallet Grin payments: the
 * buyer pays a GoblinPay invoice whose funds land in the marketplace till
 * wallet, and the name is granted ONLY after the payment confirms on-chain
 * (GoblinPay reports `status === "confirmed"`, its 10-confirmation standard).
 *
 * This module holds the trust decision in one pure, side-effect-free place so
 * it is exhaustively testable without any network or Nostr state. It is shared
 * by Nip05Manager and VanityManager.
 */

/**
 * The subset of a GoblinPay invoice (`GET /invoice/{id}`) the grant decision
 * needs, already normalized by the server-side client. `null` invoices are
 * never represented here — an unreachable/absent invoice is passed as `null`
 * to `decideNameGrant`, which fails closed.
 */
export interface GoblinPayInvoiceView {
	/** Invoice id (echoes the id we fetched by). */
	invoiceId: string
	/** `open` | `paid` | `confirmed` (+ others). Only `confirmed` grants. */
	status: string
	/** Current on-chain confirmations of the paying tx (for display). */
	confirmations: number
	/** Confirmations required before `confirmed` (the house standard, 10). */
	confirmationsRequired: number
	/** The `order_ref` the invoice was created with (binds name + buyer). */
	orderRef: string
	/** Invoice amount in integer nanogrin. */
	amountNanogrin: number
}

export type NameGrantPrefix = 'nip05' | 'vanity'

/**
 * The canonical `order_ref` binding a name purchase to its buyer:
 *   `<prefix>:<name>:<buyerPubkeyHex>`
 * The name is lowercased; the pubkey is the buyer's x-only hex Nostr key (the
 * signer of the claim event). This is what the invoice route sets and the
 * claim route re-derives and compares, so a confirmed invoice can only grant
 * the exact name+buyer it was minted for.
 */
export function buildNameOrderRef(prefix: NameGrantPrefix, name: string, buyerPubkey: string): string {
	return `${prefix}:${name.toLowerCase()}:${buyerPubkey}`
}

export interface NameGrantInput {
	/** Normalized invoice from GoblinPay, or `null` if unreachable/not found. */
	invoice: GoblinPayInvoiceView | null
	/** The invoice id claimed on the kind-17 event (`['invoice', id]` tag). */
	invoiceId: string
	/** The name being claimed (from the receipt's name tag). */
	claimedName: string
	/** The buyer pubkey = the verified signer of the claim event. */
	buyerPubkey: string
	/** `nip05` or `vanity`. */
	orderRefPrefix: NameGrantPrefix
	/** Amount -> validity-seconds tier matcher (returns null below the floor). */
	matchTier: (amountNanogrin: number) => number | null
	/** Has this invoice id already been consumed by a prior grant? */
	isConsumed: (invoiceId: string) => boolean
}

export type NameGrantDecision = { ok: true; validitySeconds: number; amountNanogrin: number } | { ok: false; error: string; status: number }

/**
 * Decide whether a confirmed GoblinPay invoice grants the claimed name.
 *
 * Grant requires ALL of:
 *  - a non-empty invoice id on the claim,
 *  - the invoice id has not already been consumed (no reuse),
 *  - the invoice is reachable (fail closed if GoblinPay is down),
 *  - `status === "confirmed"` (the ONLY grant gate — 10 confirmations),
 *  - `order_ref` exactly equals `<prefix>:<name>:<buyerPubkey>`,
 *  - the paid amount clears a pricing tier (amount >= tier price).
 */
export function decideNameGrant(input: NameGrantInput): NameGrantDecision {
	const { invoice, invoiceId, claimedName, buyerPubkey, orderRefPrefix, matchTier, isConsumed } = input

	if (!invoiceId) {
		return { ok: false, error: 'Claim is missing its GoblinPay invoice id', status: 400 }
	}

	// Reject reuse before anything else: a consumed invoice can never grant again.
	if (isConsumed(invoiceId)) {
		return { ok: false, error: 'This invoice has already been used', status: 409 }
	}

	// Fail closed: if GoblinPay is unreachable or the invoice is missing, do not grant.
	if (!invoice) {
		return { ok: false, error: 'Payment service is unavailable, please try again', status: 503 }
	}

	// The ONLY grant gate: the payment must be confirmed on-chain.
	if (invoice.status !== 'confirmed') {
		return { ok: false, error: 'Payment is not yet confirmed', status: 402 }
	}

	const expectedOrderRef = buildNameOrderRef(orderRefPrefix, claimedName, buyerPubkey)
	if (invoice.orderRef !== expectedOrderRef) {
		return { ok: false, error: 'Invoice does not match this name and buyer', status: 400 }
	}

	const validitySeconds = matchTier(invoice.amountNanogrin)
	if (validitySeconds === null) {
		return { ok: false, error: 'Payment does not cover any pricing tier', status: 400 }
	}

	return { ok: true, validitySeconds, amountNanogrin: invoice.amountNanogrin }
}
