import { test, expect } from '../fixtures'
import { seedProduct } from '../scenarios'
import { RELAY_URL } from '../test-config'
import { devUser1 } from '../../src/lib/fixtures'
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import WebSocket from 'ws'

useWebSocketImplementation(WebSocket)

// The 'merchant' scenario publishes the market_merchants allowlist (devUser1 +
// devUser2), so devUser1's GRIN products are in scope. A non-GRIN listing, however,
// fails the GRIN-only invariant and can never be viewed here.
test.use({ scenario: 'merchant' })

test.describe('Admin/GRIN scope — filtered product deep link', () => {
	test('a non-GRIN product deep link renders "Product not found", not an infinite spinner', async ({ unauthenticatedPage: page }) => {
		// Seed a USD-priced product (upstream-style) under an allowlisted merchant.
		// filterGrinOnly rejects it, so fetchProduct throws ProductUnavailableError —
		// which the route must surface immediately instead of retrying forever.
		const relay = await Relay.connect(RELAY_URL)
		let productId: string
		try {
			const event = await seedProduct(relay, devUser1.sk, {
				title: 'Upstream USDC Gadget',
				description: 'A non-GRIN listing that must not be viewable in this market.',
				price: '20',
				currency: 'USD',
				status: 'on-sale',
				category: 'Other',
				stock: '5',
			})
			productId = event.id
		} finally {
			relay.close()
		}

		await page.goto(`/products/${productId}`)

		// The permanent not-found state appears; the loading spinner must not persist.
		await expect(page.getByTestId('product-not-found')).toBeVisible({ timeout: 15_000 })
		await expect(page.getByText('Product not found')).toBeVisible()
		await expect(page.getByText('Loading product…')).toHaveCount(0)
	})
})
