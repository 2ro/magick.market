import { describe, test, expect } from 'bun:test'
import { cartActions, cartStore } from '@/lib/stores/cart'
import type { V4VDTO } from '@/lib/stores/cart'

function setShares(sellerPubkey: string, shares: V4VDTO[]) {
	cartStore.setState((state) => ({
		...state,
		v4vShares: { ...state.v4vShares, [sellerPubkey]: shares },
	}))
}

const SELLER = 'seller-pubkey'

describe('cartActions.calculateShares (circular economy / V4V split)', () => {
	test('no configured shares: seller keeps 100%', () => {
		setShares(SELLER, [])
		const result = cartActions.calculateShares(SELLER, 1_000_000_000)
		expect(result).toEqual({ sellerAmount: 1_000_000_000, communityAmount: 0, sellerPercentage: 100, recipientAmounts: [] })
	})

	test('a single 10% recipient splits correctly and sums to the total', () => {
		setShares(SELLER, [{ id: 'r1', name: 'Cause', pubkey: 'cause-pubkey', percentage: 10 }])
		const result = cartActions.calculateShares(SELLER, 1_000_000_000)

		expect(result.sellerPercentage).toBe(90)
		expect(result.sellerAmount).toBe(900_000_000)
		expect(result.communityAmount).toBe(100_000_000)
		expect(result.recipientAmounts).toEqual([{ pubkey: 'cause-pubkey', name: 'Cause', amountNanogrin: 100_000_000 }])
		expect(result.sellerAmount + result.recipientAmounts.reduce((s, r) => s + r.amountNanogrin, 0)).toBe(1_000_000_000)
	})

	test('multiple recipients split proportionally and sum to communityAmount', () => {
		setShares(SELLER, [
			{ id: 'r1', name: 'Cause A', pubkey: 'a', percentage: 10 },
			{ id: 'r2', name: 'Cause B', pubkey: 'b', percentage: 5 },
		])
		const result = cartActions.calculateShares(SELLER, 1_000_000_000)

		expect(result.sellerPercentage).toBe(85)
		expect(result.communityAmount).toBe(150_000_000)
		const [a, b] = result.recipientAmounts
		expect(a).toEqual({ pubkey: 'a', name: 'Cause A', amountNanogrin: 100_000_000 })
		expect(b).toEqual({ pubkey: 'b', name: 'Cause B', amountNanogrin: 50_000_000 })
		expect(a.amountNanogrin + b.amountNanogrin).toBe(result.communityAmount)
	})

	test('shares summing over 100% are clamped: seller gets 0, recipients split the whole amount by relative weight', () => {
		setShares(SELLER, [
			{ id: 'r1', name: 'Cause A', pubkey: 'a', percentage: 75 },
			{ id: 'r2', name: 'Cause B', pubkey: 'b', percentage: 75 },
		])
		const result = cartActions.calculateShares(SELLER, 1_000_000_000)

		expect(result.sellerAmount).toBe(0)
		expect(result.communityAmount).toBe(1_000_000_000)
		const [a, b] = result.recipientAmounts
		// Equal weights (75/75) -> equal split of the full amount, not 75% each.
		expect(a.amountNanogrin).toBe(500_000_000)
		expect(b.amountNanogrin).toBe(500_000_000)
	})

	test('decimal-stored percentages (0.1 meaning 10%) are normalized', () => {
		setShares(SELLER, [{ id: 'r1', name: 'Cause', pubkey: 'cause-pubkey', percentage: 0.1 }])
		const result = cartActions.calculateShares(SELLER, 1_000_000_000)

		expect(result.sellerPercentage).toBe(90)
		expect(result.recipientAmounts).toEqual([{ pubkey: 'cause-pubkey', name: 'Cause', amountNanogrin: 100_000_000 }])
	})

	test('invalid percentages (<=0, >100, NaN) are dropped from the split', () => {
		setShares(SELLER, [
			{ id: 'r1', name: 'Zero', pubkey: 'zero', percentage: 0 },
			{ id: 'r2', name: 'TooBig', pubkey: 'toobig', percentage: 150 },
			{ id: 'r3', name: 'Valid', pubkey: 'valid', percentage: 10 },
		])
		const result = cartActions.calculateShares(SELLER, 1_000_000_000)

		expect(result.recipientAmounts).toEqual([{ pubkey: 'valid', name: 'Valid', amountNanogrin: 100_000_000 }])
	})
})
