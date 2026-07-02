import { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'

/**
 * Anonymous guest buyer identity (M3).
 *
 * At checkout, a fresh one-off key is minted and used ONLY to sign the order
 * events for that checkout. It is never registered as a logged-in account and
 * never reused across orders, so there is no cross-order linkability and no
 * social graph. The key plus the invoice number form the "order code" the
 * buyer can stash to track the order later; a copy is auto-saved to
 * localStorage ("Your orders on this device").
 */

const GUEST_ORDERS_STORAGE_KEY = 'magick_guest_orders_v1'

export interface GuestOrderRecord {
	orderId: string
	/** Opaque invoice number bridging the Grin payment to the order. */
	invoiceNumber: string
	sellerPubkey: string
	/** Total amount in integer nanogrin. */
	amountNanogrin: number
	/** Hex secret key of the one-off guest order identity. */
	secretKeyHex: string
	/** Hex pubkey of the guest identity (status updates are addressed to it). */
	pubkey: string
	createdAt: number
}

/** Mint a fresh one-off guest key for a single checkout. */
export function mintGuestOrderSigner(): NDKPrivateKeySigner {
	return NDKPrivateKeySigner.generate()
}

function readGuestOrders(): GuestOrderRecord[] {
	if (typeof localStorage === 'undefined') return []
	try {
		const raw = localStorage.getItem(GUEST_ORDERS_STORAGE_KEY)
		if (!raw) return []
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

function writeGuestOrders(records: GuestOrderRecord[]) {
	if (typeof localStorage === 'undefined') return
	try {
		localStorage.setItem(GUEST_ORDERS_STORAGE_KEY, JSON.stringify(records))
	} catch (error) {
		console.error('Failed to persist guest orders:', error)
	}
}

export function saveGuestOrder(record: GuestOrderRecord) {
	const records = readGuestOrders()
	if (!records.some((r) => r.orderId === record.orderId)) {
		records.push(record)
		writeGuestOrders(records)
	}
}

export function getGuestOrders(): GuestOrderRecord[] {
	return readGuestOrders()
		.slice()
		.sort((a, b) => b.createdAt - a.createdAt)
}

export function removeGuestOrder(orderId: string) {
	writeGuestOrders(readGuestOrders().filter((r) => r.orderId !== orderId))
}

export interface OrderCode {
	v: 1
	/** Hex secret key of the guest order identity. */
	sk: string
	orderId: string
	invoiceNumber: string
	sellerPubkey: string
}

function base64UrlEncode(input: string): string {
	const b64 = btoa(unescape(encodeURIComponent(input)))
	return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(input: string): string {
	const b64 = input.replace(/-/g, '+').replace(/_/g, '/')
	const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
	return decodeURIComponent(escape(atob(padded)))
}

const ORDER_CODE_PREFIX = 'mmorder1'

/**
 * Encode the buyer's order code / claim link payload: the ephemeral key plus
 * the invoice number. Returning with the code re-derives the ephemeral key and
 * reads the seller's status updates addressed to the ephemeral npub.
 */
export function encodeOrderCode(code: Omit<OrderCode, 'v'>): string {
	const payload: OrderCode = { v: 1, ...code }
	return `${ORDER_CODE_PREFIX}${base64UrlEncode(JSON.stringify(payload))}`
}

export function decodeOrderCode(raw: string): OrderCode | null {
	try {
		const trimmed = raw.trim()
		if (!trimmed.startsWith(ORDER_CODE_PREFIX)) return null
		const json = base64UrlDecode(trimmed.slice(ORDER_CODE_PREFIX.length))
		const parsed = JSON.parse(json) as OrderCode
		if (parsed.v !== 1 || !parsed.sk || !parsed.orderId || !parsed.invoiceNumber) return null
		return parsed
	} catch {
		return null
	}
}
