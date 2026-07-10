import { describe, test, expect } from 'bun:test'
import { parseV4VSharesFromEvent, isV4VShareTag, V4V_SHARE_TAG, LEGACY_V4V_SHARE_TAG } from '@/queries/v4v'

// V4V share tag migration: shares are written under the `split` tag, but the
// reader must keep parsing already-published 30078 events that used the legacy
// `zap` tag (read-both / write-new). ndk is passed as null so no profile fetch
// happens and names resolve to ''.

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)

function eventWith(content: unknown) {
	return { content: JSON.stringify(content) }
}

describe('isV4VShareTag', () => {
	test('accepts the current split tag', () => {
		expect(isV4VShareTag(V4V_SHARE_TAG)).toBe(true)
		expect(isV4VShareTag('split')).toBe(true)
	})
	test('accepts the legacy zap tag', () => {
		expect(isV4VShareTag(LEGACY_V4V_SHARE_TAG)).toBe(true)
		expect(isV4VShareTag('zap')).toBe(true)
	})
	test('rejects unrelated tag names', () => {
		expect(isV4VShareTag('price')).toBe(false)
		expect(isV4VShareTag('p')).toBe(false)
		expect(isV4VShareTag(undefined)).toBe(false)
	})
})

describe('parseV4VSharesFromEvent read-both shim', () => {
	test('parses shares written under the new split tag', async () => {
		const shares = await parseV4VSharesFromEvent(eventWith([[V4V_SHARE_TAG, HEX_A, '10']]), null)
		expect(shares).toHaveLength(1)
		expect(shares[0].pubkey).toBe(HEX_A)
		expect(shares[0].percentage).toBe(10)
	})

	test('still parses legacy events written under the zap tag', async () => {
		const shares = await parseV4VSharesFromEvent(eventWith([[LEGACY_V4V_SHARE_TAG, HEX_A, '5']]), null)
		expect(shares).toHaveLength(1)
		expect(shares[0].pubkey).toBe(HEX_A)
		expect(shares[0].percentage).toBe(5)
	})

	test('parses a mix of legacy zap and new split tags', async () => {
		const shares = await parseV4VSharesFromEvent(
			eventWith([
				[LEGACY_V4V_SHARE_TAG, HEX_A, '10'],
				[V4V_SHARE_TAG, HEX_B, '20'],
			]),
			null,
		)
		expect(shares.map((s) => s.pubkey).sort()).toEqual([HEX_A, HEX_B].sort())
	})

	test('ignores non-share tags', async () => {
		const shares = await parseV4VSharesFromEvent(
			eventWith([
				['price', '1', 'GRIN'],
				[V4V_SHARE_TAG, HEX_A, '10'],
			]),
			null,
		)
		expect(shares).toHaveLength(1)
		expect(shares[0].pubkey).toBe(HEX_A)
	})

	test('empty content array yields no shares', async () => {
		const shares = await parseV4VSharesFromEvent(eventWith([]), null)
		expect(shares).toEqual([])
	})
})
