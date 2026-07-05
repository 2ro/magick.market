import { describe, test, expect } from 'bun:test'
import { isClaimReceipt, isPaymentCompleted } from '@/components/orders/orderDetailHelpers'
import type { NDKEvent } from '@nostr-dev-kit/ndk'

const SELLER = 'sellerpubkeyhex00000000000000000000000000000000000000000000000000000'
const INVOICE = 'MM-DEADBEEFDEADBEEFDEADBEEF'

function ev(tags: string[][], pubkey = SELLER): NDKEvent {
	return { pubkey, tags } as unknown as NDKEvent
}

const paymentRequest = ev([
	['recipient', SELLER],
	['amount', '2000000000'],
	['payment-request', INVOICE],
])

/** A receipt carrying every tag isPaymentCompleted matches on. */
function settledReceipt(extraTags: string[][] = []): NDKEvent {
	return ev([['order', INVOICE], ['amount', '2000000000'], ['p', SELLER], ['payment', 'grin', INVOICE, 'proof'], ...extraTags])
}

describe('isClaimReceipt (buyer claims are claims, not confirmations)', () => {
	test('status=sent is a claim', () => {
		expect(isClaimReceipt(ev([['status', 'sent']]))).toBe(true)
	})

	test('status=confirming is an interim report, treated as a claim', () => {
		expect(isClaimReceipt(ev([['status', 'confirming']]))).toBe(true)
	})

	test('status=confirmed and untagged receipts are not claims', () => {
		expect(isClaimReceipt(ev([['status', 'confirmed']]))).toBe(false)
		expect(isClaimReceipt(ev([['payment', 'grin', INVOICE, '']]))).toBe(false)
	})
})

describe('isPaymentCompleted never counts claim receipts as paid', () => {
	test('a fully tag-matched receipt marks the payment completed', () => {
		expect(isPaymentCompleted(paymentRequest, [settledReceipt()])).toBe(true)
	})

	test('the same receipt with status=sent is only a buyer claim and does not mark paid', () => {
		expect(isPaymentCompleted(paymentRequest, [settledReceipt([['status', 'sent']])])).toBe(false)
	})

	test('status=confirming does not mark paid either', () => {
		expect(isPaymentCompleted(paymentRequest, [settledReceipt([['status', 'confirming']])])).toBe(false)
	})

	test("the wallet's canonical plain sent receipt (payment-request only, no order/p tags) does not mark paid", () => {
		const walletPlainReceipt = ev(
			[
				['payment-request', INVOICE],
				['payment', 'grin', INVOICE, ''],
				['amount', '2000000000'],
				['status', 'sent'],
				['goblin', '1'],
			],
			'buyerpubkeyhex0000000000000000000000000000000000000000000000000000000',
		)
		expect(isPaymentCompleted(paymentRequest, [walletPlainReceipt])).toBe(false)
	})

	test('a claim receipt alongside a settled receipt does not block the settled one', () => {
		expect(isPaymentCompleted(paymentRequest, [settledReceipt([['status', 'sent']]), settledReceipt()])).toBe(true)
	})
})
