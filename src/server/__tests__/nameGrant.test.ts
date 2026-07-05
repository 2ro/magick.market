import { describe, test, expect } from 'bun:test'
import { buildNameOrderRef, decideNameGrant, type GoblinPayInvoiceView } from '../nameGrant'
import { grinToNanogrin } from '@/lib/grin'

const SIX_MONTHS = 180 * 24 * 60 * 60

// A confirmed 6-month invoice for `alice` bought by pubkey `PK`.
const PK = 'a'.repeat(64)

function invoice(overrides: Partial<GoblinPayInvoiceView> = {}): GoblinPayInvoiceView {
	return {
		invoiceId: 'inv-1',
		status: 'confirmed',
		confirmations: 10,
		confirmationsRequired: 10,
		orderRef: buildNameOrderRef('nip05', 'alice', PK),
		amountNanogrin: grinToNanogrin(500),
		...overrides,
	}
}

// Amount -> validity matcher: >= 500 GRIN grants 6 months, else null.
const matchTier = (amountNanogrin: number): number | null => (amountNanogrin >= grinToNanogrin(500) ? SIX_MONTHS : null)

function decide(overrides: {
	invoice?: GoblinPayInvoiceView | null
	invoiceId?: string
	claimedName?: string
	buyerPubkey?: string
	consumed?: Set<string>
}) {
	return decideNameGrant({
		invoice: overrides.invoice === undefined ? invoice() : overrides.invoice,
		invoiceId: overrides.invoiceId ?? 'inv-1',
		claimedName: overrides.claimedName ?? 'alice',
		buyerPubkey: overrides.buyerPubkey ?? PK,
		orderRefPrefix: 'nip05',
		matchTier,
		isConsumed: (id) => (overrides.consumed ?? new Set<string>()).has(id),
	})
}

describe('buildNameOrderRef', () => {
	test('lowercases the name and joins prefix:name:pubkey', () => {
		expect(buildNameOrderRef('nip05', 'Alice', PK)).toBe(`nip05:alice:${PK}`)
		expect(buildNameOrderRef('vanity', 'My-Shop', PK)).toBe(`vanity:my-shop:${PK}`)
	})
})

describe('decideNameGrant', () => {
	test('grants a confirmed invoice with matching order_ref and sufficient amount', () => {
		const d = decide({})
		expect(d.ok).toBe(true)
		if (d.ok) {
			expect(d.validitySeconds).toBe(SIX_MONTHS)
			expect(d.amountNanogrin).toBe(grinToNanogrin(500))
		}
	})

	test('rejects a missing invoice id', () => {
		const d = decide({ invoiceId: '' })
		expect(d.ok).toBe(false)
		if (!d.ok) expect(d.status).toBe(400)
	})

	test('rejects reuse of an already-consumed invoice id (before any other check)', () => {
		const d = decide({ consumed: new Set(['inv-1']) })
		expect(d.ok).toBe(false)
		if (!d.ok) {
			expect(d.status).toBe(409)
			expect(d.error).toMatch(/already been used/)
		}
	})

	test('fails closed when the invoice is unreachable (null)', () => {
		const d = decide({ invoice: null })
		expect(d.ok).toBe(false)
		if (!d.ok) {
			expect(d.status).toBe(503)
			expect(d.error).toMatch(/unavailable/)
		}
	})

	test('does not grant while the invoice is only open', () => {
		const d = decide({ invoice: invoice({ status: 'open' }) })
		expect(d.ok).toBe(false)
		if (!d.ok) expect(d.status).toBe(402)
	})

	test('does not grant while the invoice is paid but not yet confirmed', () => {
		const d = decide({ invoice: invoice({ status: 'paid', confirmations: 3 }) })
		expect(d.ok).toBe(false)
		if (!d.ok) expect(d.status).toBe(402)
	})

	test('rejects an order_ref for a different name', () => {
		const d = decide({ claimedName: 'bob' })
		expect(d.ok).toBe(false)
		if (!d.ok) expect(d.error).toMatch(/does not match/)
	})

	test('rejects an order_ref for a different buyer pubkey', () => {
		const d = decide({ buyerPubkey: 'b'.repeat(64) })
		expect(d.ok).toBe(false)
		if (!d.ok) expect(d.error).toMatch(/does not match/)
	})

	test('rejects a confirmed invoice whose amount clears no tier', () => {
		const d = decide({ invoice: invoice({ amountNanogrin: grinToNanogrin(1) }) })
		expect(d.ok).toBe(false)
		if (!d.ok) expect(d.error).toMatch(/does not cover any pricing tier/)
	})

	test('grants when the amount exceeds the tier floor', () => {
		const d = decide({ invoice: invoice({ amountNanogrin: grinToNanogrin(800) }) })
		expect(d.ok).toBe(true)
	})
})
