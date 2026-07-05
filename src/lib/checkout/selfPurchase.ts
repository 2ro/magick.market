/**
 * Self-purchase detection.
 *
 * A Grin payment where sender == receiver can never complete on the interactive
 * rail (the buyer's wallet cannot co-sign with itself), so a buyer who is also
 * the merchant would wait forever with a stuck send. magick refuses UP FRONT,
 * before any order or payment is initiated: the flow never starts, so there is
 * no envelope and no eternal wait.
 */

/** Clear, user-facing refusal copy. Single source so every entry point matches. */
export const SELF_PURCHASE_MESSAGE = "You can't buy your own product."

/**
 * True when the buyer's pubkey matches any of the seller pubkeys in the purchase.
 * Empty/absent buyer (e.g. anonymous guest, who always gets a fresh key) is never
 * a self-purchase.
 */
export function isSelfPurchase(buyerPubkey: string | undefined | null, sellerPubkeys: Array<string | undefined | null>): boolean {
	if (!buyerPubkey) return false
	return sellerPubkeys.some((seller) => !!seller && seller === buyerPubkey)
}
