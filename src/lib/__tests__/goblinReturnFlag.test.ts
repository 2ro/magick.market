import { describe, expect, test } from 'bun:test'
import { RETURN_FLAG_PARAM, withReturnFlag } from '@/lib/goblin/session/protocol'

// NOTE: RETURN_FLAG_PARAM ('rt') is a PLACEHOLDER. The final param name must match
// the Goblin wallet's URI parser; these tests are written against the constant so a
// rename stays a single-line change in protocol.ts.
describe('login/trust return flag', () => {
	const base = 'goblin:trust?c=abc&d=magick.market&cb=https%3A%2F%2Fmagick.market%2Fcb&sk=deadbeef&r=wss%3A%2F%2Frelay&k=1,4'

	test('same-device deep-link keeps return-to-caller (flag absent)', () => {
		expect(withReturnFlag(base, true)).toBe(base)
	})

	test('QR variant appends the no-return flag', () => {
		expect(withReturnFlag(base, false)).toBe(`${base}&${RETURN_FLAG_PARAM}=0`)
	})

	test('QR and deep-link variants differ ONLY by the return param', () => {
		const deepLink = withReturnFlag(base, true)
		const qr = withReturnFlag(base, false)
		expect(qr).not.toBe(deepLink)
		// Removing the appended `&rt=0` from the QR variant yields exactly the deep-link URI.
		expect(qr.replace(`&${RETURN_FLAG_PARAM}=0`, '')).toBe(deepLink)
	})

	test('flag off is off regardless of the login (goblin:login) URI shape', () => {
		const loginBase = 'goblin:login?c=abc&d=magick.market&cb=https%3A%2F%2Fmagick.market%2Fcb'
		expect(withReturnFlag(loginBase, false)).toBe(`${loginBase}&${RETURN_FLAG_PARAM}=0`)
		expect(withReturnFlag(loginBase, true)).toBe(loginBase)
	})
})
