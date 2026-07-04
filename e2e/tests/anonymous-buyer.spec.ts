import { test, expect } from '../fixtures'
import { queryRelayEvents, filterByTag, getTagValue } from '../utils/relay-query'
import { seedProduct } from '../scenarios'
import { RELAY_URL, TEST_APP_PUBLIC_KEY } from '../test-config'
import { devUser1, devUser2 } from '../../src/lib/fixtures'
import { finalizeEvent } from 'nostr-tools/pure'
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import { nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils.js'
import WebSocket from 'ws'

useWebSocketImplementation(WebSocket)

/**
 * Plan 4, M3 acceptance: the anonymous guest buyer.
 *
 * A shopper with no account buys a GRIN-priced product. This exercises the
 * whole M3/M4/M5 seam:
 *   - a fresh ephemeral guest ORDER key is minted (never the logged-in signer)
 *   - a kind-16 order is published carrying the opaque invoice number
 *   - the payment screen shows the goblin:pay QR/URI with memo = invoice#  (M4)
 *   - pasting a Grin payment proof publishes a kind-17 receipt              (M5)
 *   - the order code is recoverable from localStorage                      (M3)
 *
 * Manual leg (mocked here at the proof seam): a real Goblin wallet producing a
 * real receiver-signed proof and settling the round trip on-chain. The market
 * only carries the proof and does a shape check (looksLikeGrinPaymentProof),
 * so we paste a fixture proof exactly where a buyer would paste the real one.
 */

const GUEST_ORDERS_KEY = 'magick_guest_orders_v1'
const PRODUCT_TITLE = 'Grin Test Widget'
// Shape-valid fixture standing in for the receiver-signed proof Goblin emits.
const FIXTURE_PROOF = '{"recipient_sig":"e2e-stub-signature-0001","kernel":"09fixturekernelcommitment"}'

test.use({ scenario: 'merchant' })

/**
 * Seed the two things the shared 'merchant' scenario lacks for a GRIN sale:
 *  - a GRIN-priced product (the seeded ones are SATS, which the GRIN-only cart
 *    converts to 0 nanogrin so no payable order can form), and
 *  - devUser1's Goblin payment address (a GRIN payment detail) so the payment
 *    leg resolves a goblin:pay URI. It reuses the scenario's worldwide-standard
 *    shipping option.
 */
async function seedGrinFixtures() {
	const relay = await Relay.connect(RELAY_URL)
	try {
		await seedProduct(relay, devUser1.sk, {
			title: PRODUCT_TITLE,
			description: 'A GRIN-priced widget for the anonymous-buyer e2e.',
			price: '3',
			currency: 'GRIN',
			status: 'on-sale',
			category: 'Grin',
			stock: '10',
			shippingOptions: [`30406:${devUser1.pk}:worldwide-standard`],
		})

		const grinAddress = nip19.nprofileEncode({ pubkey: devUser2.pk, relays: [RELAY_URL] })
		const paymentDetail = finalizeEvent(
			{
				kind: 30078,
				created_at: Math.floor(Date.now() / 1000),
				content: JSON.stringify({
					payment_method: 'grin',
					payment_detail: grinAddress,
					stall_id: null,
					stall_name: 'General',
					is_default: true,
				}),
				tags: [
					['d', `payment-grin-${Date.now()}`],
					['l', 'payment_detail'],
					['p', TEST_APP_PUBLIC_KEY],
				],
			},
			hexToBytes(devUser1.sk),
		)
		await relay.publish(paymentDetail)
	} finally {
		relay.close()
	}
}

test.describe('Anonymous guest buyer (M3)', () => {
	test('checkout with no login: ephemeral key, invoice bridge, goblin:pay URI, proof receipt, recoverable order code', async ({
		unauthenticatedPage: page,
	}) => {
		test.setTimeout(120_000)
		const testStartTime = Math.floor(Date.now() / 1000) - 5

		await seedGrinFixtures()

		// --- 1. Anon shopper adds a product to the cart ------------------------
		await page.goto('/products')
		const productCard = page.locator('[data-testid="product-card"]').filter({ hasText: PRODUCT_TITLE })
		await expect(productCard).toBeVisible({ timeout: 15_000 })
		await productCard.getByRole('button', { name: /Add to Cart/i }).click()
		await expect(productCard.getByRole('button', { name: /Add/i })).toBeVisible()

		// Open the cart drawer and head to checkout (no login wall).
		await page
			.getByRole('button')
			.filter({ has: page.locator('.i-basket') })
			.click()
		await page.getByRole('button', { name: /^Checkout$/ }).click()

		// --- 2. Checkout shipping step (no login wall) ------------------------
		// The product has a single shipping option, so it auto-selects; if a
		// picker is shown instead, choose Worldwide Standard.
		await expect(page.getByText('Shipping Address', { exact: true })).toBeVisible({ timeout: 15_000 })
		const shippingPicker = page.getByText('Select shipping method').first()
		if (await shippingPicker.isVisible().catch(() => false)) {
			await shippingPicker.click()
			await page.getByRole('option', { name: /Worldwide Standard/ }).click()
		}

		// Fill the ship-to address.
		await page.locator('#name').fill('Anon Guest')
		await page.locator('#firstLineOfAddress').fill('1 Privacy Road')
		await page.locator('#zipPostcode').fill('SW1A 1AA')
		await page.locator('#country').fill('United Kingdom')
		await page.locator('[data-country-item]').filter({ hasText: 'United Kingdom' }).first().click()
		await page.locator('#city').fill('London')
		await page.keyboard.press('Escape')
		const continueToReview = page.locator('button[form="shipping-form"]')
		await expect(continueToReview).toBeEnabled({ timeout: 15_000 })
		await continueToReview.click()

		// --- 3. Summary -> create the order (mints the guest key + invoice#) ----
		await expect(page.getByText('Order Summary')).toBeVisible({ timeout: 10_000 })
		// Privacy microcopy for anon buyers is present.
		await expect(page.getByText(/No account needed/i)).toBeVisible()
		const continueToPayment = page.getByRole('button', { name: /Continue to Payment/ })
		await expect(continueToPayment).toBeEnabled()
		await continueToPayment.click()

		// --- 4. The guest order key + invoice# were persisted locally ----------
		// (saved at order creation, before payment). This is the recoverable
		// order record; the guest key is NOT the app's logged-in signer.
		await expect
			.poll(async () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]').length, GUEST_ORDERS_KEY), { timeout: 30_000 })
			.toBeGreaterThan(0)

		const guestOrders = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), GUEST_ORDERS_KEY)
		expect(Array.isArray(guestOrders)).toBe(true)
		const guestOrder = guestOrders[0]
		expect(guestOrder.secretKeyHex).toMatch(/^[0-9a-f]{64}$/) // a real ephemeral key
		expect(guestOrder.invoiceNumber).toMatch(/^MM-[0-9A-F]{24}$/)
		const invoiceNumber: string = guestOrder.invoiceNumber

		// --- 5. Payment screen shows the canonical nostr: pay URI with memo = invoice# ---
		// The Goblin wallet's pay URI is `nostr:<recipient>?amount=<GRIN>&memo=<invoice#>`;
		// the recipient (nprofile) rides in the path, not a `to` query param.
		await expect(page.getByText('Pay with Goblin')).toBeVisible({ timeout: 20_000 })
		// The load-bearing bridge: the pay URI's memo is exactly the invoice#.
		await expect(page.getByText(new RegExp(`nostr:nprofile1\\w+\\?.*memo=${invoiceNumber}`)).first()).toBeVisible({ timeout: 20_000 })
		// textContent (not innerText) returns the full URI even though it is
		// visually truncated in the copy row.
		const payUri = (
			(await page
				.getByText(/nostr:nprofile1\w+\?/)
				.first()
				.textContent()) || ''
		).trim()
		const uriBody = payUri.slice(payUri.indexOf('nostr:') + 'nostr:'.length)
		const recipient = uriBody.slice(0, uriBody.indexOf('?'))
		const payParams = new URLSearchParams(uriBody.slice(uriBody.indexOf('?') + 1))
		expect(payParams.get('memo')).toBe(invoiceNumber)
		expect(Number(payParams.get('amount'))).toBeGreaterThan(0)
		expect(recipient).toMatch(/^nprofile1/)

		// --- 6. The kind-16 order on the relay carries the invoice# ------------
		const orderEvents = await queryRelayEvents({ kinds: [16], '#p': [devUser1.pk], since: testStartTime })
		const creations = filterByTag(orderEvents, 'type', '1')
		expect(creations.length).toBeGreaterThanOrEqual(1)
		expect(creations.some((e) => getTagValue(e, 'invoice') === invoiceNumber)).toBe(true)

		// --- 7. Buyer-proof path (M5): paste the proof -> kind-17 receipt ------
		await page.getByRole('button', { name: /I paid .* import proof/i }).click()
		await page.getByPlaceholder(/Paste the Grin payment proof/i).fill(FIXTURE_PROOF)
		await page.getByRole('button', { name: /Submit proof/i }).click()

		// --- 8. Completion: recoverable order code shown ----------------------
		await expect(page.getByText(/Your order code/i)).toBeVisible({ timeout: 20_000 })
		await expect(page.getByText(/^mmorder1/).first()).toBeVisible()

		// The kind-17 receipt reached the seller, keyed to the invoice number.
		await expect
			.poll(
				async () => {
					const receipts = await queryRelayEvents({ kinds: [17], '#p': [devUser1.pk], since: testStartTime })
					return receipts.length
				},
				{ timeout: 20_000 },
			)
			.toBeGreaterThanOrEqual(1)

		// --- 9. No account was ever created -----------------------------------
		await expect(page.getByTestId('login-button')).toBeVisible()
	})
})
