import { describe, test, expect } from 'bun:test'
import {
	NANOGRIN_PER_GRIN,
	buildGoblinPayUri,
	deriveProofAddress,
	formatGrin,
	formatGrinAmount,
	grinToNanogrin,
	isValidGoblinPayAddress,
	mintInvoiceNumber,
	nanogrinToGrin,
	toGoblinDeeplink,
} from '@/lib/grin'

// Parse a Goblin pay-URI the way the Goblin wallet's payuri.rs does:
//   nostr:<recipient>?amount=<decimal GRIN>&memo=<percent-encoded>
// The recipient rides in the path (everything between `nostr:` and `?`); the
// emitter percent-encodes with encodeURIComponent (space -> %20, never `+`), so
// URLSearchParams decoding here agrees with the wallet's RFC-3986 decoder.
function parseGoblinPayUri(uri: string): {
	recipient: string
	amount: string | null
	memo: string | null
	proof: string | null
	order: string | null
	notify: string | null
} {
	const rest = uri.replace(/^nostr:/i, '')
	const qIndex = rest.indexOf('?')
	if (qIndex === -1) return { recipient: rest, amount: null, memo: null, proof: null, order: null, notify: null }
	const params = new URLSearchParams(rest.slice(qIndex + 1))
	return {
		recipient: rest.slice(0, qIndex),
		amount: params.get('amount'),
		memo: params.get('memo'),
		proof: params.get('proof'),
		order: params.get('order'),
		notify: params.get('notify'),
	}
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

describe('buildGoblinPayUri (canonical Goblin wallet pay-URI, the invoice-number bridge)', () => {
	test('emits nostr:<recipient>?amount=<decimal GRIN>&memo=<invoice#>', () => {
		const invoice = mintInvoiceNumber()
		const uri = buildGoblinPayUri({ to: 'nprofile1abcdef', amountNanogrin: 1_500_000_000, memo: invoice })
		expect(uri.startsWith('nostr:')).toBe(true)
		const { recipient, amount, memo } = parseGoblinPayUri(uri)
		// Recipient rides in the path (the wallet feeds it to its resolver), NOT as a `to=` param.
		expect(recipient).toBe('nprofile1abcdef')
		expect(uri).not.toContain('to=')
		// Decimal GRIN, NOT nanogrin: 1_500_000_000 nanogrin == 1.5 GRIN.
		expect(amount).toBe('1.5')
		expect(memo).toBe(invoice)
	})

	test('amount is decimal GRIN across the whole precision range', () => {
		expect(parseGoblinPayUri(buildGoblinPayUri({ to: 'x', amountNanogrin: 1_000_000_000 })).amount).toBe('1')
		expect(parseGoblinPayUri(buildGoblinPayUri({ to: 'x', amountNanogrin: 250_000_000 })).amount).toBe('0.25')
		// Smallest Grin unit: 1 nanogrin == 0.000000001 GRIN.
		expect(parseGoblinPayUri(buildGoblinPayUri({ to: 'x', amountNanogrin: 1 })).amount).toBe('0.000000001')
	})

	test('memo parsed from the URI equals the minted invoice number (round-trip)', () => {
		const invoice = mintInvoiceNumber()
		const uri = buildGoblinPayUri({ to: 'npub1seller', amountNanogrin: 1_000_000_000, memo: invoice })
		expect(parseGoblinPayUri(uri).memo).toBe(invoice)
	})

	test('omits memo when none is given, rounds to nanogrin, and clamps negatives to 0', () => {
		expect(parseGoblinPayUri(buildGoblinPayUri({ to: 'x', amountNanogrin: 1_000_000_000 })).memo).toBeNull()
		// 10.7 nanogrin rounds to 11 nanogrin == 0.000000011 GRIN.
		expect(parseGoblinPayUri(buildGoblinPayUri({ to: 'x', amountNanogrin: 10.7 })).amount).toBe('0.000000011')
		expect(parseGoblinPayUri(buildGoblinPayUri({ to: 'x', amountNanogrin: -5 })).amount).toBe('0')
	})

	test('percent-encodes the memo (space -> %20, never +) to match the wallet decoder', () => {
		const uri = buildGoblinPayUri({ to: 'x', amountNanogrin: 1_000_000_000, memo: 'MM AB+CD' })
		// Space must be %20 and the literal + must be %2B — never a bare `+`, which
		// the wallet's RFC-3986 decoder would keep literal instead of turning to space.
		expect(uri).not.toContain('MM AB+CD')
		expect(uri).toContain('memo=MM%20AB%2BCD')
		expect(parseGoblinPayUri(uri).memo).toBe('MM AB+CD')
	})
})

describe('toGoblinDeeplink (clickable goblin: scheme deeplink)', () => {
	test('swaps only the scheme, preserving recipient/amount/memo verbatim', () => {
		const invoice = mintInvoiceNumber()
		const payUri = buildGoblinPayUri({ to: 'nprofile1abcdef', amountNanogrin: 1_500_000_000, memo: invoice })
		const deeplink = toGoblinDeeplink(payUri)
		expect(deeplink.startsWith('goblin:')).toBe(true)
		expect(deeplink).not.toContain('nostr:')
		// Everything after the scheme is byte-for-byte identical.
		expect(deeplink).toBe(payUri.replace(/^nostr:/, 'goblin:'))
		expect(deeplink).toBe(`goblin:nprofile1abcdef?amount=1.5&memo=${invoice}`)
	})

	test('is a no-op for anything not on the nostr: scheme', () => {
		expect(toGoblinDeeplink('goblin:npub1x?amount=1')).toBe('goblin:npub1x?amount=1')
		expect(toGoblinDeeplink('grin1abc')).toBe('grin1abc')
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

describe('deriveProofAddress (proof-on-request, contract 4.1)', () => {
	test('returns the grin1/tgrin1 slatepack address when the merchant advertised one', () => {
		expect(deriveProofAddress('grin1qpzry9x8gf2tvdw0s3jn54kh')).toBe('grin1qpzry9x8gf2tvdw0s3jn54kh')
		expect(deriveProofAddress('  tgrin1qpzry9x8gf2tvdw0s3jn54kh  ')).toBe('tgrin1qpzry9x8gf2tvdw0s3jn54kh')
	})

	test('returns null for nprofile/npub-only details (degraded mode, no proof address)', () => {
		expect(deriveProofAddress('nprofile1qpzry9x8gf2tvdw0s3jn')).toBeNull()
		expect(deriveProofAddress('npub1qpzry9x8gf2tvdw0s3jn')).toBeNull()
		expect(deriveProofAddress('')).toBeNull()
		expect(deriveProofAddress(null)).toBeNull()
		expect(deriveProofAddress(undefined)).toBeNull()
	})
})

describe('buildGoblinPayUri proof-on-request params (contract 4.1)', () => {
	const grin1 = 'grin1qpzry9x8gf2tvdw0s3jn54kh'
	const npub = 'npub1qpzry9x8gf2tvdw0s3jn'

	test('emits proof, order, and notify when supplied, after amount/memo', () => {
		const invoice = mintInvoiceNumber()
		const uri = buildGoblinPayUri({
			to: 'nprofile1abcdef',
			amountNanogrin: 1_500_000_000,
			memo: invoice,
			proofAddress: grin1,
			order: invoice,
			notify: npub,
		})
		const parsed = parseGoblinPayUri(uri)
		// recipient stays the nprofile transport identity, proof is the grin1 key.
		expect(parsed.recipient).toBe('nprofile1abcdef')
		expect(parsed.proof).toBe(grin1)
		expect(parsed.order).toBe(invoice)
		expect(parsed.notify).toBe(npub)
		// amount/memo remain first for backward-compatible ordering.
		expect(uri.indexOf('amount=')).toBeLessThan(uri.indexOf('proof='))
	})

	test('omits the proof params entirely when not supplied (proof-free send)', () => {
		const uri = buildGoblinPayUri({ to: 'nprofile1abcdef', amountNanogrin: 1_000_000_000, memo: 'MM-1' })
		expect(uri).not.toContain('proof=')
		expect(uri).not.toContain('order=')
		expect(uri).not.toContain('notify=')
	})

	test('a pre-feature parser (recipient/amount/memo only) is unaffected by the new params', () => {
		const uri = buildGoblinPayUri({
			to: 'x',
			amountNanogrin: 1_000_000_000,
			memo: 'MM-2',
			proofAddress: grin1,
			order: 'MM-2',
			notify: npub,
		})
		const parsed = parseGoblinPayUri(uri)
		expect(parsed.amount).toBe('1')
		expect(parsed.memo).toBe('MM-2')
	})
})
