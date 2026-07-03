import { describe, test, expect } from 'bun:test'
import {
	NANOGRIN_PER_GRIN,
	buildGoblinPayUri,
	formatGrin,
	formatGrinAmount,
	grinToNanogrin,
	isValidGoblinPayAddress,
	looksLikeGrinPaymentProof,
	mintInvoiceNumber,
	nanogrinToGrin,
} from '@/lib/grin'

// Parse the memo back out of a goblin:pay URI the way the Goblin wallet would.
function memoOf(payUri: string): string | null {
	const query = payUri.slice(payUri.indexOf('?') + 1)
	return new URLSearchParams(query).get('memo')
}

describe('grin nanogrin conversions', () => {
	test('1 GRIN is 10^9 nanogrin', () => {
		expect(NANOGRIN_PER_GRIN).toBe(1_000_000_000)
		expect(grinToNanogrin(1)).toBe(1_000_000_000)
	})

	test('grin<->nanogrin round-trips', () => {
		for (const grin of [0, 0.000000001, 0.25, 1, 1.5, 1234.567891234]) {
			expect(nanogrinToGrin(grinToNanogrin(grin))).toBeCloseTo(grin, 9)
		}
	})

	test('formatGrin trims trailing zeros and formatGrinAmount adds suffix', () => {
		expect(formatGrin(1_000_000_000)).toBe('1')
		expect(formatGrin(1_250_000_000)).toBe('1.25')
		expect(formatGrin(1)).toBe('0.000000001')
		expect(formatGrin(0)).toBe('0')
		expect(formatGrinAmount(1_250_000_000)).toBe('1.25 GRIN')
	})
})

describe('mintInvoiceNumber', () => {
	test('has the MM- prefix and 24 uppercase hex chars', () => {
		const inv = mintInvoiceNumber()
		expect(inv).toMatch(/^MM-[0-9A-F]{24}$/)
	})

	test('is unique across a batch (high entropy)', () => {
		const seen = new Set<string>()
		for (let i = 0; i < 2000; i++) seen.add(mintInvoiceNumber())
		expect(seen.size).toBe(2000)
	})
})

describe('buildGoblinPayUri (the invoice-number bridge)', () => {
	test('carries to / amount(nanogrin) / memo(invoice#)', () => {
		const invoice = mintInvoiceNumber()
		const uri = buildGoblinPayUri({ to: 'nprofile1abcdef', amountNanogrin: 1_500_000_000, memo: invoice })
		expect(uri.startsWith('goblin:pay?')).toBe(true)
		const params = new URLSearchParams(uri.slice(uri.indexOf('?') + 1))
		expect(params.get('to')).toBe('nprofile1abcdef')
		expect(params.get('amount')).toBe('1500000000')
		expect(params.get('memo')).toBe(invoice)
	})

	test('memo parsed from the URI equals the minted invoice number (round-trip)', () => {
		const invoice = mintInvoiceNumber()
		const uri = buildGoblinPayUri({ to: 'npub1seller', amountNanogrin: 42, memo: invoice })
		expect(memoOf(uri)).toBe(invoice)
	})

	test('amount is rounded to an integer nanogrin and never negative', () => {
		expect(memoOf(buildGoblinPayUri({ to: 'x', amountNanogrin: 10 }))).toBeNull()
		const uri = buildGoblinPayUri({ to: 'x', amountNanogrin: 10.7 })
		expect(new URLSearchParams(uri.slice(uri.indexOf('?') + 1)).get('amount')).toBe('11')
		const neg = buildGoblinPayUri({ to: 'x', amountNanogrin: -5 })
		expect(new URLSearchParams(neg.slice(neg.indexOf('?') + 1)).get('amount')).toBe('0')
	})

	test('URL-encodes the memo so it survives transport', () => {
		const uri = buildGoblinPayUri({ to: 'x', amountNanogrin: 1, memo: 'MM AB+CD' })
		// Raw string must be percent-encoded, but decode back to the original.
		expect(uri).not.toContain('MM AB+CD')
		expect(memoOf(uri)).toBe('MM AB+CD')
	})
})

describe('isValidGoblinPayAddress', () => {
	test('accepts nprofile / npub / grin slatepack addresses (bech32 charset)', () => {
		// bech32 data charset excludes b, i, o and 1 after the separator.
		expect(isValidGoblinPayAddress('nprofile1qpzry9x8gf2tvdw0s3jn')).toBe(true)
		expect(isValidGoblinPayAddress('npub1qpzry9x8gf2tvdw0s3jn')).toBe(true)
		expect(isValidGoblinPayAddress('grin1qpzry9x8gf2tvdw0s3jn54kh')).toBe(true)
		expect(isValidGoblinPayAddress('tgrin1qpzry9x8gf2tvdw0s3jn54kh')).toBe(true)
	})

	test('rejects lud16 and empty / junk', () => {
		expect(isValidGoblinPayAddress('user@wallet.example')).toBe(false)
		expect(isValidGoblinPayAddress('')).toBe(false)
		expect(isValidGoblinPayAddress('   ')).toBe(false)
	})
})

describe('looksLikeGrinPaymentProof', () => {
	test('accepts JSON, armored, and base64-ish blobs above the min length', () => {
		expect(looksLikeGrinPaymentProof('{"recipient_sig":"abc123","kernel":"09ab"}')).toBe(true)
		expect(looksLikeGrinPaymentProof('BEGINPROOF-abcdefghijklmnop-ENDPROOF')).toBe(true)
		expect(looksLikeGrinPaymentProof('ZmFrZS1wcm9vZi1ibG9iLWJhc2U2NA==')).toBe(true)
	})

	test('rejects too-short or clearly-not-a-proof input', () => {
		expect(looksLikeGrinPaymentProof('short')).toBe(false)
		expect(looksLikeGrinPaymentProof('   ')).toBe(false)
		expect(looksLikeGrinPaymentProof('has spaces and 🚀 emoji not allowed')).toBe(false)
	})
})
