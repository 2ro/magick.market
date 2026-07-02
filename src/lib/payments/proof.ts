/**
 * GRIN payment proof carried in kind 17 receipts.
 *
 * Grin has no Lightning preimage: the proof is the receiver-signed payment
 * proof Goblin produces after finalize (plus, optionally, the on-chain kernel
 * commitment). Full verification (receiver-sig + kernel on-chain + dedupe by
 * kernel commitment) is the seller's Goblin wallet's job; the market only
 * carries and displays the proof.
 */
export type PaymentProof = {
	type: 'grin_proof'
	/** The opaque invoice number that bridges the payment to the order. */
	invoiceId: string
	/** Receiver-signed Grin payment proof (as exported by Goblin). */
	proof: string
	/** Optional on-chain kernel commitment. */
	kernel?: string
}

/**
 * Encode a PaymentProof into the single string field stored on the invoice
 * and published in the `payment` tag of the kind 17 receipt.
 */
export function paymentProofToReceiptPreimage(proof: PaymentProof): string {
	return proof.proof
}
