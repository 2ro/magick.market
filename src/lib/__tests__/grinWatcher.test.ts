import { describe, test, expect } from 'bun:test'
import { ed25519 } from '@noble/curves/ed25519'
import { bytesToHex } from '@noble/hashes/utils.js'
import { grinAddressFromPubkey, paymentProofMessage } from '@/lib/grinProofs'
import {
	buildConfirmedReceiptTags,
	classifyOrderReceipts,
	CONFIRMATIONS_REQUIRED,
	hasExistingConfirmed,
	queryKernelConfirmations,
	receiptMatchesInvoice,
	verifyProofDelivery,
	type ReceiptEventLike,
} from '@/lib/grinWatcher'

const WATCHER = 'watcherpubkeyhex0000000000000000000000000000000000000000000000000000'
const BUYER = 'buyerpubkeyhex000000000000000000000000000000000000000000000000000000'
const INVOICE = 'MM-DEADBEEFDEADBEEFDEADBEEF'

function ev(pubkey: string, tags: string[][]): ReceiptEventLike {
	return { pubkey, tags }
}

describe('receiptMatchesInvoice (contract 4.5 matching)', () => {
	test('matches on payment-request OR order tag carrying the invoice number', () => {
		expect(receiptMatchesInvoice(ev(BUYER, [['payment-request', INVOICE]]), INVOICE)).toBe(true)
		expect(receiptMatchesInvoice(ev(BUYER, [['order', INVOICE]]), INVOICE)).toBe(true)
		expect(receiptMatchesInvoice(ev(BUYER, [['payment-request', 'MM-OTHER']]), INVOICE)).toBe(false)
		expect(receiptMatchesInvoice(ev(BUYER, [['order', INVOICE]]), '')).toBe(false)
	})
})

describe('wallet interop: the EXACT committed receipt shapes', () => {
	// The wallet's plain receipt (4.3.1), byte-for-byte as the wallet build emits
	// it: payment-request tag ONLY (no order tag), empty proof field, goblin=1.
	// If this test breaks, the wallet<->market seam broke.
	const walletPlainReceipt: ReceiptEventLike = {
		pubkey: BUYER,
		content: 'Payment sent',
		tags: [
			['payment-request', INVOICE],
			['payment', 'grin', INVOICE, ''],
			['amount', '1500000000'],
			['status', 'sent'],
			['goblin', '1'],
		],
	}

	test('matches by payment-request ALONE (the wallet sends NO order tag)', () => {
		expect(walletPlainReceipt.tags.some((t) => t[0] === 'order')).toBe(false)
		expect(receiptMatchesInvoice(walletPlainReceipt, INVOICE)).toBe(true)
	})

	test('flips DETECTED only, never paid, and carries no proof', () => {
		const result = classifyOrderReceipts([walletPlainReceipt], WATCHER)
		expect(result.state).toBe('detected')
		expect(result.proof).toBeNull() // proof field is EMPTY on the plain receipt
	})

	test('the encrypted proof-delivery RUMOR shape (4.3.2) also matches by payment-request alone', () => {
		// What the watcher sees after the wrapv3 unwrap (the unwrap itself is the
		// daemon's job; see the grinWatcher module header). Rumor kind 17:
		const rumor: ReceiptEventLike = {
			pubkey: BUYER,
			content:
				'{"amount":"1500000000","excess":"09..","recipient_address":"grin1..","recipient_sig":"..","sender_address":"grin1..","sender_sig":".."}',
			tags: [
				['payment-request', INVOICE],
				['amount', '1500000000'],
				['kernel', '09aabb'],
				['status', 'proof'],
				['goblin', '1'],
			],
		}
		expect(receiptMatchesInvoice(rumor, INVOICE)).toBe(true)
		// A proof delivery is watcher input, not a UI state escalation: the
		// classifier must not treat status=proof as detected/confirming/paid.
		expect(classifyOrderReceipts([rumor], WATCHER).state).toBe('waiting')
	})
})

describe('classifyOrderReceipts (marketplace trust rules, contract 4.5)', () => {
	test('no events => waiting', () => {
		expect(classifyOrderReceipts([], WATCHER).state).toBe('waiting')
	})

	test("buyer's plain status=sent receipt => detected, never paid", () => {
		const sent = ev(BUYER, [
			['payment-request', INVOICE],
			['status', 'sent'],
		])
		expect(classifyOrderReceipts([sent], WATCHER).state).toBe('detected')
	})

	test('a status=confirmed event NOT signed by the watcher can never reach paid', () => {
		const forged = ev(BUYER, [
			['payment-request', INVOICE],
			['status', 'confirmed'],
			['confirmations', '10'],
		])
		// Buyer-forged confirmed is ignored entirely (not watcher-signed).
		expect(classifyOrderReceipts([forged], WATCHER).state).toBe('waiting')
	})

	test('only a watcher-signed status=confirmed flips to paid', () => {
		const confirmed = ev(WATCHER, [
			['payment-request', INVOICE],
			['status', 'confirmed'],
			['confirmations', '10'],
		])
		const result = classifyOrderReceipts([confirmed], WATCHER)
		expect(result.state).toBe('paid')
		expect(result.confirmations).toBe(10)
	})

	test('watcher status=confirming surfaces the live depth', () => {
		const confirming = ev(WATCHER, [
			['payment-request', INVOICE],
			['status', 'confirming'],
			['confirmations', '3'],
		])
		const result = classifyOrderReceipts([confirming], WATCHER)
		expect(result.state).toBe('confirming')
		expect(result.confirmations).toBe(3)
	})

	test('escalates and dedupes: many events collapse to the highest-trust state', () => {
		const events = [
			ev(BUYER, [
				['payment-request', INVOICE],
				['status', 'sent'],
			]),
			ev(WATCHER, [
				['payment-request', INVOICE],
				['status', 'confirming'],
				['confirmations', '2'],
			]),
			ev(WATCHER, [
				['payment-request', INVOICE],
				['status', 'confirming'],
				['confirmations', '7'],
			]),
			// duplicate confirmed (replay) must remain idempotent
			ev(WATCHER, [
				['payment-request', INVOICE],
				['status', 'confirmed'],
				['confirmations', '10'],
			]),
			ev(WATCHER, [
				['payment-request', INVOICE],
				['status', 'confirmed'],
				['confirmations', '10'],
			]),
		]
		const result = classifyOrderReceipts(events, WATCHER)
		expect(result.state).toBe('paid')
	})

	test('no configured watcher (degraded mode) can never reach paid', () => {
		const confirmed = ev(WATCHER, [
			['payment-request', INVOICE],
			['status', 'confirmed'],
			['confirmations', '10'],
		])
		expect(classifyOrderReceipts([confirmed], null).state).toBe('waiting')
	})
})

describe('queryKernelConfirmations (watcher node client, step 5)', () => {
	function mockNode(responses: Record<string, unknown>) {
		return async (_url: string, init?: { body?: string }) => {
			const method = JSON.parse(init?.body || '{}').method as string
			return {
				ok: true,
				status: 200,
				json: async () => ({ result: { Ok: responses[method] } }),
			}
		}
	}

	test('not-yet-mined kernel => found:false', async () => {
		const result = await queryKernelConfirmations('http://node', 'abcd', mockNode({ get_kernel: null }))
		expect(result.found).toBe(false)
		expect(result.confirmations).toBe(0)
	})

	test('computes depth = tip - height + 1', async () => {
		const node = mockNode({ get_kernel: [{ excess: 'abcd' }, 1000, 5], get_tip: { height: 1009 } })
		const result = await queryKernelConfirmations('http://node', 'abcd', node)
		expect(result.found).toBe(true)
		expect(result.confirmations).toBe(10)
		expect(result.height).toBe(1000)
	})

	test('throws on a node Err envelope', async () => {
		const node = async () => ({ ok: true, status: 200, json: async () => ({ result: { Err: 'boom' } }) })
		await expect(queryKernelConfirmations('http://node', 'abcd', node)).rejects.toThrow()
	})
})

describe('verifyProofDelivery (watcher steps 2-4)', () => {
	function realDelivery(opts: { kernelMismatch?: boolean; wrongInvoiceAmount?: boolean } = {}) {
		const amount = 2_000_000_000n
		const recipientPriv = ed25519.utils.randomPrivateKey()
		const recipientPub = ed25519.getPublicKey(recipientPriv)
		const senderPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey())
		const excess = new Uint8Array(33).fill(9)
		const excessHex = bytesToHex(excess)
		const msg = paymentProofMessage(amount, excessHex, senderPub)!
		const recipientSig = ed25519.sign(msg, recipientPriv)
		const merchantAddress = grinAddressFromPubkey(recipientPub)
		const proofJson = JSON.stringify({
			amount: amount.toString(),
			excess: excessHex,
			recipient_address: merchantAddress,
			recipient_sig: bytesToHex(recipientSig),
			sender_address: grinAddressFromPubkey(senderPub),
			sender_sig: bytesToHex(recipientSig),
		})
		return {
			delivery: {
				proofJson,
				kernelTag: opts.kernelMismatch ? 'ff'.repeat(33) : excessHex,
				invoiceTag: INVOICE,
				amountTag: amount.toString(),
			},
			invoice: { invoiceNumber: INVOICE, amountNanogrin: opts.wrongInvoiceAmount ? 1 : Number(amount), proofAddress: merchantAddress },
			excessHex,
		}
	}

	test('accepts a valid delivery and returns the excess for chain lookup', () => {
		const { delivery, invoice, excessHex } = realDelivery()
		const result = verifyProofDelivery(delivery, invoice)
		expect(result.ok).toBe(true)
		expect(result.excessHex).toBe(excessHex)
	})

	test('rejects when the kernel tag disagrees with the proof excess', () => {
		const { delivery, invoice } = realDelivery({ kernelMismatch: true })
		expect(verifyProofDelivery(delivery, invoice).ok).toBe(false)
	})

	test('rejects when the amount does not match the invoice', () => {
		const { delivery, invoice } = realDelivery({ wrongInvoiceAmount: true })
		expect(verifyProofDelivery(delivery, invoice).ok).toBe(false)
	})
})

describe('watcher idempotence + confirmed receipt (steps 7-8)', () => {
	test('hasExistingConfirmed detects a prior confirmed event from the watcher key', () => {
		const events = [
			ev(WATCHER, [
				['payment-request', INVOICE],
				['status', 'confirmed'],
			]),
		]
		expect(hasExistingConfirmed(events, INVOICE, WATCHER)).toBe(true)
		expect(hasExistingConfirmed(events, 'MM-OTHER', WATCHER)).toBe(false)
		expect(hasExistingConfirmed([], INVOICE, WATCHER)).toBe(false)
	})

	test('buildConfirmedReceiptTags carries an empty proof field by privacy default', () => {
		const tags = buildConfirmedReceiptTags(INVOICE, 2_000_000_000, CONFIRMATIONS_REQUIRED)
		expect(tags).toContainEqual(['payment-request', INVOICE])
		expect(tags).toContainEqual(['payment', 'grin', INVOICE, ''])
		expect(tags).toContainEqual(['status', 'confirmed'])
		expect(tags).toContainEqual(['confirmations', '10'])
	})

	test('below depth 10 the tag set is status=confirming', () => {
		const tags = buildConfirmedReceiptTags(INVOICE, 2_000_000_000, 4)
		expect(tags).toContainEqual(['status', 'confirming'])
	})
})
