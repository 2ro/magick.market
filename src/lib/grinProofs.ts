/**
 * Grin payment-proof verification primitives (proof-on-request, spec section 7).
 *
 * WHO USES THIS: the instance WATCHER (spec implementer 3). Per the frozen
 * contract (4.5) the magick UI itself NEVER verifies a proof to decide "paid" —
 * it trusts the watcher's signed kind-17. This module is the reference,
 * dependency-free implementation of the watcher's cryptographic checks (steps
 * 2-4 of section 7), reusable by a TypeScript watcher process and unit-tested
 * against real ed25519 fixtures. The canonical daemon may instead reuse Grin's
 * own Rust `verify_payment_proof`; this mirrors it byte-for-byte.
 *
 * Payload contract (contract 4.3.2, exactly the wallet owner-API proof JSON):
 *   { amount, excess, recipient_address, recipient_sig, sender_address, sender_sig }
 *
 * The receiver (merchant) signs, and this verifies, the message:
 *   BE_u64(amount) || kernel_excess(33 bytes) || sender_pubkey(32 bytes)
 * with the ed25519 key behind `recipient_address`. This mirrors Grin's
 * `payment_proof_message` (libwallet internal/tx.rs) and `verify_payment_proof`.
 */
import { bech32 } from 'bech32'
import { ed25519 } from '@noble/curves/ed25519'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

/** Grin slatepack address human-readable prefixes (mainnet / floonet). */
const GRIN_HRPS = new Set(['grin', 'tgrin'])

/** Normalize a slatepack address for equality comparison. */
export function normalizeGrinAddress(address: string): string {
	return address.trim().toLowerCase()
}

/**
 * Decode a grin1/tgrin1 slatepack address to its raw 32-byte ed25519 public key,
 * or null if it is not a valid Grin slatepack address. Classic bech32 (not
 * bech32m), matching Grin's `SlatepackAddress` (libwallet slatepack/address.rs).
 */
export function decodeGrinAddress(address: string): Uint8Array | null {
	try {
		const decoded = bech32.decode(normalizeGrinAddress(address), 1023)
		if (!GRIN_HRPS.has(decoded.prefix)) return null
		const bytes = Uint8Array.from(bech32.fromWords(decoded.words))
		return bytes.length === 32 ? bytes : null
	} catch {
		return null
	}
}

/** Encode a 32-byte ed25519 public key as a grin1/tgrin1 slatepack address (test helper). */
export function grinAddressFromPubkey(pubkey: Uint8Array, hrp: 'grin' | 'tgrin' = 'grin'): string {
	return bech32.encode(hrp, bech32.toWords(pubkey), 1023)
}

/** Big-endian u64 encoding of a nanogrin amount, matching Grin's payment_proof_message. */
export function amountToBeU64(amount: bigint): Uint8Array {
	const out = new Uint8Array(8)
	let v = amount
	for (let i = 7; i >= 0; i--) {
		out[i] = Number(v & 0xffn)
		v >>= 8n
	}
	return out
}

/**
 * The exact bytes the receiver signs over: BE_u64(amount) || excess(33) || sender(32).
 * Mirrors libwallet `payment_proof_message(amount, kernel_commitment, sender_address)`.
 */
export function paymentProofMessage(amount: bigint, excessHex: string, senderPubkey: Uint8Array): Uint8Array | null {
	let excess: Uint8Array
	try {
		excess = hexToBytes(excessHex)
	} catch {
		return null
	}
	if (excess.length !== 33 || senderPubkey.length !== 32) return null
	const msg = new Uint8Array(8 + 33 + 32)
	msg.set(amountToBeU64(amount), 0)
	msg.set(excess, 8)
	msg.set(senderPubkey, 41)
	return msg
}

export interface ParsedPaymentProof {
	/** Amount in integer nanogrin. */
	amount: bigint
	/** Kernel excess (commitment), 33-byte hex. */
	excessHex: string
	recipientAddress: string
	recipientSigHex: string
	senderAddress: string
	senderSigHex: string
}

/**
 * Parse a Grin payment proof from the wallet owner-API JSON shape (contract 4.3.2).
 * Accepts a JSON string or an already-parsed object; returns null on any shape
 * mismatch. Field aliases tolerate minor naming drift while the wallet lands.
 */
export function parsePaymentProof(raw: unknown): ParsedPaymentProof | null {
	let obj: Record<string, unknown>
	if (typeof raw === 'string') {
		const s = raw.trim()
		if (!s.startsWith('{')) return null
		try {
			obj = JSON.parse(s)
		} catch {
			return null
		}
	} else if (raw && typeof raw === 'object') {
		obj = raw as Record<string, unknown>
	} else {
		return null
	}

	const amountRaw = obj.amount
	const excess = obj.excess ?? obj.kernel_excess ?? obj.kernel
	const recipientAddress = obj.recipient_address ?? obj.recipient
	const recipientSig = obj.recipient_sig ?? obj.recipient_signature
	const senderAddress = obj.sender_address ?? obj.sender
	const senderSig = obj.sender_sig ?? obj.sender_signature

	if (amountRaw == null || !excess || !recipientAddress || !recipientSig || !senderAddress) return null

	let amount: bigint
	try {
		amount = BigInt(typeof amountRaw === 'number' ? Math.round(amountRaw) : String(amountRaw))
	} catch {
		return null
	}
	if (amount < 0n) return null

	return {
		amount,
		excessHex: String(excess).toLowerCase(),
		recipientAddress: String(recipientAddress),
		recipientSigHex: String(recipientSig).toLowerCase(),
		senderAddress: String(senderAddress),
		senderSigHex: senderSig ? String(senderSig).toLowerCase() : '',
	}
}

export interface ProofBindingResult {
	/** recipient_address equals the invoice's merchant proof-address. */
	addressOk: boolean
	/** proof amount equals the invoice's expected nanogrin amount. */
	amountOk: boolean
	/** receiver ed25519 signature over (amount, excess, sender) verifies. */
	signatureOk: boolean
	/** All three bindings hold; only then may the watcher proceed to chain depth. */
	valid: boolean
	/** Kernel excess (hex) for the on-chain get_kernel lookup. */
	excessHex: string
	/** First failing reason, for logging (never published). */
	reason?: string
}

/**
 * Watcher verification steps 3-4 (section 7): bind the proof to the invoice's
 * merchant address and amount, then verify the receiver signature. The kernel
 * (step 5) is verified separately against the chain.
 */
export function verifyProofBindings(params: {
	proof: ParsedPaymentProof
	merchantAddress: string
	amountNanogrin: number
}): ProofBindingResult {
	const { proof, merchantAddress, amountNanogrin } = params

	const addressOk = normalizeGrinAddress(proof.recipientAddress) === normalizeGrinAddress(merchantAddress)
	const amountOk = proof.amount === BigInt(Math.round(amountNanogrin))

	let signatureOk = false
	let reason: string | undefined

	const recipientPub = decodeGrinAddress(proof.recipientAddress)
	const senderPub = decodeGrinAddress(proof.senderAddress)

	let sig: Uint8Array | null = null
	try {
		sig = hexToBytes(proof.recipientSigHex)
	} catch {
		sig = null
	}

	if (!recipientPub) {
		reason = 'recipient address is not a valid grin slatepack address'
	} else if (!senderPub) {
		reason = 'sender address is not a valid grin slatepack address'
	} else if (!sig || sig.length !== 64) {
		reason = 'recipient signature is not 64 bytes'
	} else {
		const msg = paymentProofMessage(proof.amount, proof.excessHex, senderPub)
		if (!msg) {
			reason = 'kernel excess is not 33 bytes'
		} else {
			try {
				signatureOk = ed25519.verify(sig, msg, recipientPub)
			} catch {
				signatureOk = false
				reason = 'recipient signature verification threw'
			}
		}
	}

	const valid = addressOk && amountOk && signatureOk
	if (!valid && !reason) {
		if (!addressOk) reason = 'recipient address does not match merchant proof-address'
		else if (!amountOk) reason = 'proof amount does not match invoice amount'
		else reason = 'recipient signature invalid'
	}

	return { addressOk, amountOk, signatureOk, valid, excessHex: proof.excessHex, reason: valid ? undefined : reason }
}

/** Convenience: hex of a public key (test/debug). */
export function pubkeyHex(pubkey: Uint8Array): string {
	return bytesToHex(pubkey)
}
