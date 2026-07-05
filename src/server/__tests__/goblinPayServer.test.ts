import { describe, test, expect } from 'bun:test'
import { parseInvoiceAmountNanogrin, invoiceViewFromJson } from '../goblinPayServer'
import { grinToNanogrin } from '@/lib/grin'

describe('parseInvoiceAmountNanogrin', () => {
	test('reads an explicit nanogrin field', () => {
		expect(parseInvoiceAmountNanogrin({ amount_nanogrin: grinToNanogrin(500) })).toBe(grinToNanogrin(500))
		expect(parseInvoiceAmountNanogrin({ expected_amount: grinToNanogrin(800) })).toBe(grinToNanogrin(800))
	})

	test('parses a human decimal-GRIN string with a currency suffix', () => {
		expect(parseInvoiceAmountNanogrin({ amount: '500 GRIN' })).toBe(grinToNanogrin(500))
		expect(parseInvoiceAmountNanogrin({ amount: '0.25' })).toBe(grinToNanogrin(0.25))
	})

	test('returns 0 when nothing parses', () => {
		expect(parseInvoiceAmountNanogrin({})).toBe(0)
		expect(parseInvoiceAmountNanogrin({ amount: 'free' })).toBe(0)
	})
})

describe('invoiceViewFromJson', () => {
	test('normalizes the confirmed-invoice contract', () => {
		const view = invoiceViewFromJson({
			invoice_id: 'inv-9',
			status: 'confirmed',
			confirmations: 10,
			confirmations_required: 10,
			order_ref: 'nip05:alice:abc',
			amount: '500 GRIN',
		})
		expect(view).toEqual({
			invoiceId: 'inv-9',
			status: 'confirmed',
			confirmations: 10,
			confirmationsRequired: 10,
			orderRef: 'nip05:alice:abc',
			amountNanogrin: grinToNanogrin(500),
		})
	})
})
