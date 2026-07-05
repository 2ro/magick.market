import { describe, test, expect } from 'bun:test'
import { ed25519 } from '@noble/curves/ed25519'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
	amountToBeU64,
	decodeGrinAddress,
	grinAddressFromPubkey,
	parsePaymentProof,
	paymentProofMessage,
	verifyProofBindings,
} from '@/lib/grinProofs'

// Build a real, valid Grin payment proof exactly as the wallet owner API would:
// the receiver signs BE_u64(amount) || excess(33) || sender_pubkey(32).
function makeProof(overrides: { amount?: bigint; tamperSig?: boolean; wrongRecipient?: boolean } = {}) {
	const amount = overrides.amount ?? 1_500_000_000n

	const recipientPriv = ed25519.utils.randomPrivateKey()
	const recipientPub = ed25519.getPublicKey(recipientPriv)
	const senderPriv = ed25519.utils.randomPrivateKey()
	const senderPub = ed25519.getPublicKey(senderPriv)

	// 33-byte kernel excess (Pedersen commitment).
	const excess = new Uint8Array(33)
	excess.set(recipientPub.slice(0, 32), 0)
	excess[32] = 0x08
	const excessHex = bytesToHex(excess)

	const msg = paymentProofMessage(amount, excessHex, senderPub)!
	const recipientSig = ed25519.sign(msg, recipientPriv)
	const senderSig = ed25519.sign(msg, senderPriv)

	const recipientAddress = overrides.wrongRecipient
		? grinAddressFromPubkey(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()))
		: grinAddressFromPubkey(recipientPub)

	return {
		merchantAddress: grinAddressFromPubkey(recipientPub),
		amountNanogrin: Number(amount),
		proofJson: JSON.stringify({
			amount: amount.toString(),
			excess: excessHex,
			recipient_address: recipientAddress,
			recipient_sig: overrides.tamperSig ? bytesToHex(recipientSig).replace(/^../, 'ff') : bytesToHex(recipientSig),
			sender_address: grinAddressFromPubkey(senderPub),
			sender_sig: bytesToHex(senderSig),
		}),
	}
}

describe('grin slatepack address <-> pubkey (bech32)', () => {
	test('round-trips a 32-byte ed25519 key through grin1/tgrin1', () => {
		const pub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey())
		const grin = grinAddressFromPubkey(pub, 'grin')
		const tgrin = grinAddressFromPubkey(pub, 'tgrin')
		expect(grin.startsWith('grin1')).toBe(true)
		expect(tgrin.startsWith('tgrin1')).toBe(true)
		expect(decodeGrinAddress(grin)).toEqual(pub)
		expect(decodeGrinAddress(tgrin)).toEqual(pub)
	})

	test('rejects non-grin bech32 and junk', () => {
		expect(decodeGrinAddress('npub1qpzry9x8gf2tvdw0s3jn')).toBeNull()
		expect(decodeGrinAddress('not-an-address')).toBeNull()
	})
})

describe('amountToBeU64 / paymentProofMessage', () => {
	test('amount is big-endian u64', () => {
		expect(Array.from(amountToBeU64(1n))).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
		expect(Array.from(amountToBeU64(256n))).toEqual([0, 0, 0, 0, 0, 0, 1, 0])
	})

	test('message is 8 + 33 + 32 = 73 bytes and lays out amount||excess||sender', () => {
		const sender = ed25519.getPublicKey(ed25519.utils.randomPrivateKey())
		const excessHex = bytesToHex(new Uint8Array(33).fill(7))
		const msg = paymentProofMessage(5n, excessHex, sender)!
		expect(msg.length).toBe(73)
		expect(Array.from(msg.slice(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 5])
		expect(Array.from(msg.slice(41))).toEqual(Array.from(sender))
	})

	test('returns null for a wrong-length excess', () => {
		const sender = ed25519.getPublicKey(ed25519.utils.randomPrivateKey())
		expect(paymentProofMessage(5n, bytesToHex(new Uint8Array(10)), sender)).toBeNull()
	})
})

describe('parsePaymentProof', () => {
	test('parses the owner-API JSON shape', () => {
		const { proofJson } = makeProof()
		const parsed = parsePaymentProof(proofJson)
		expect(parsed).not.toBeNull()
		expect(parsed!.amount).toBe(1_500_000_000n)
		expect(parsed!.recipientAddress.startsWith('grin1')).toBe(true)
	})

	test('rejects non-JSON, missing fields, and negative amounts', () => {
		expect(parsePaymentProof('not json')).toBeNull()
		expect(parsePaymentProof('{"amount":"1"}')).toBeNull()
		expect(parsePaymentProof(42)).toBeNull()
	})
})

describe('verifyProofBindings (watcher steps 3-4)', () => {
	test('a genuine proof binds address + amount + a valid receiver signature', () => {
		const { proofJson, merchantAddress, amountNanogrin } = makeProof()
		const proof = parsePaymentProof(proofJson)!
		const result = verifyProofBindings({ proof, merchantAddress, amountNanogrin })
		expect(result.addressOk).toBe(true)
		expect(result.amountOk).toBe(true)
		expect(result.signatureOk).toBe(true)
		expect(result.valid).toBe(true)
		expect(result.excessHex.length).toBe(66)
	})

	test('fails when the amount does not match the invoice', () => {
		const { proofJson, merchantAddress } = makeProof({ amount: 1_500_000_000n })
		const proof = parsePaymentProof(proofJson)!
		const result = verifyProofBindings({ proof, merchantAddress, amountNanogrin: 999 })
		expect(result.amountOk).toBe(false)
		expect(result.valid).toBe(false)
	})

	test('fails when recipient_address does not match the merchant proof-address', () => {
		const { proofJson, merchantAddress, amountNanogrin } = makeProof({ wrongRecipient: true })
		const proof = parsePaymentProof(proofJson)!
		const result = verifyProofBindings({ proof, merchantAddress, amountNanogrin })
		expect(result.addressOk).toBe(false)
		expect(result.valid).toBe(false)
	})

	test('fails when the receiver signature is tampered', () => {
		const { proofJson, merchantAddress, amountNanogrin } = makeProof({ tamperSig: true })
		const proof = parsePaymentProof(proofJson)!
		const result = verifyProofBindings({ proof, merchantAddress, amountNanogrin })
		expect(result.signatureOk).toBe(false)
		expect(result.valid).toBe(false)
	})
})
