import { beforeEach, describe, expect, test } from 'bun:test'

import { DEFAULT_FORM_STATE, productFormActions, productFormStore, type ProductFormState } from '@/lib/stores/product'

// Owner decision (2026-08-22): a magick.market listing must be priced at least
// 1 GRIN. The publish path has to fail closed on an empty or sub-minimum price
// instead of coercing it to a free listing.

/**
 * A signer that records whether the publish path ever reached the signing
 * boundary, then throws. Everything before the signature is pure, so a
 * recorded attempt means the price guard let the listing through.
 */
function sentinelSigner(): { signer: any; attempted: () => boolean } {
	let attempted = false
	const signer = {
		user: async () => {
			attempted = true
			throw new Error('sentinel signer: publish attempted')
		},
		sign: async () => {
			attempted = true
			throw new Error('sentinel signer: publish attempted')
		},
	}
	return { signer, attempted: () => attempted }
}

function setForm(overrides: Partial<ProductFormState>): void {
	productFormStore.setState(() => ({
		...DEFAULT_FORM_STATE,
		name: 'Test product',
		summary: 'Summary',
		description: 'A description',
		quantity: '1',
		currency: 'GRIN',
		mainCategory: 'Bitcoin',
		images: [{ imageUrl: 'https://example.com/product.png', imageOrder: 0 }],
		shippings: [{ shippingRef: '30406:merchant:standard', extraCost: '' }],
		...overrides,
	}))
}

beforeEach(() => {
	productFormStore.setState(() => ({ ...DEFAULT_FORM_STATE }))
})

describe('continuePublishing minimum listing price', () => {
	test('an empty price is rejected instead of published as a free listing', async () => {
		setForm({ price: '' })
		const { signer, attempted } = sentinelSigner()

		const result = await productFormActions.continuePublishing(signer, {} as any)

		expect(attempted()).toBe(false)
		expect(result).toBe(false)
	})

	test('a price below 1 GRIN is rejected', async () => {
		setForm({ price: '0.5' })
		const { signer, attempted } = sentinelSigner()

		const result = await productFormActions.continuePublishing(signer, {} as any)

		expect(attempted()).toBe(false)
		expect(result).toBe(false)
	})

	test('a zero price is rejected', async () => {
		setForm({ price: '0' })
		const { signer, attempted } = sentinelSigner()

		const result = await productFormActions.continuePublishing(signer, {} as any)

		expect(attempted()).toBe(false)
		expect(result).toBe(false)
	})

	test('a non-numeric price is rejected', async () => {
		setForm({ price: 'abc' })
		const { signer, attempted } = sentinelSigner()

		const result = await productFormActions.continuePublishing(signer, {} as any)

		expect(attempted()).toBe(false)
		expect(result).toBe(false)
	})

	test('a price of 1 GRIN reaches the publish boundary', async () => {
		setForm({ price: '1' })
		const { signer, attempted } = sentinelSigner()

		await productFormActions.continuePublishing(signer, {} as any)

		expect(attempted()).toBe(true)
	})
})
