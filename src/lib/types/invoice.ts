export type PaymentInvoiceStatus = 'pending' | 'paid' | 'expired' | 'skipped' | 'failed'

export type PaymentInvoiceType = 'merchant'

/**
 * A GRIN payment request shown at checkout.
 * `id` is the opaque invoice number (also the Goblin pay-URI memo) bridging
 * the anonymous order to the Grin payment.
 */
export interface PaymentInvoiceData {
	id: string
	orderId: string
	/** Amount in integer nanogrin (1 GRIN = 10^9 nanogrin). */
	amount: number
	description: string
	recipientName: string
	status: PaymentInvoiceStatus
	createdAt: number
	/** The seller's Goblin payment address (nprofile or slatepack address). */
	grinAddress?: string | null
	/** The Goblin pay deeplink / QR payload: nostr:<recipient>?amount=<decimal GRIN>&memo=<invoice#> */
	payUri?: string | null
	recipientPubkey: string
	type: PaymentInvoiceType
	/** Receiver-signed Grin payment proof once the order is paid. */
	proof?: string
	expiresAt?: number
	persistedAt?: number
	updatedAt?: number
}
