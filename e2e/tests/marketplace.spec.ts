import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures'
import { devUser2 } from '../../src/lib/fixtures'
import { nip19 } from 'nostr-tools'

test.use({ scenario: 'marketplace' })

// ---------------------------------------------------------------------------
// Helper: resilient navigation for SPA with TanStack Router
// ---------------------------------------------------------------------------

async function safeGoto(page: Page, url: string): Promise<void> {
	const targetPath = url.split('?')[0]

	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await page.goto(url)
		} catch (error) {
			const msg = String(error)
			if (!msg.includes('interrupted by another navigation') && !msg.includes('ERR_ABORTED')) throw error
			await page.waitForLoadState('networkidle').catch(() => {})
		}

		await page.waitForTimeout(1000)
		await page.waitForLoadState('networkidle').catch(() => {})

		const currentPath = new URL(page.url()).pathname
		if (currentPath === targetPath || currentPath.startsWith(targetPath)) {
			return
		}
	}

	await page.goto(url)
}

// ---------------------------------------------------------------------------
// Helper: add products from both sellers to cart (for newUserPage)
// ---------------------------------------------------------------------------

async function addProductsFromBothSellers(page: Page): Promise<void> {
	// Navigate to products page
	await safeGoto(page, '/products')

	// Wait for products from both sellers to be visible
	await expect(async () => {
		const content = await page.locator('main').textContent()
		expect(content).toContain('Bitcoin Hardware Wallet')
		expect(content).toContain('Lightning Node Setup Guide')
	}).toPass({ timeout: 30_000 })

	// --- Add devUser1's product ---
	const wallet = page.locator('[data-testid="product-card"]').filter({ hasText: 'Bitcoin Hardware Wallet' })
	await wallet.getByRole('button', { name: /add to cart/i }).click()
	// Wait for the button to confirm addition
	await expect(wallet.getByRole('button', { name: /add/i })).toBeVisible()

	// --- Add devUser2's product ---
	const guide = page.locator('[data-testid="product-card"]').filter({ hasText: 'Lightning Node Setup Guide' })
	await guide.getByRole('button', { name: /add to cart/i }).click()
	await expect(guide.getByRole('button', { name: /add/i })).toBeVisible()
}

// ---------------------------------------------------------------------------
// Helper: open cart drawer
// ---------------------------------------------------------------------------

async function openCart(page: Page): Promise<void> {
	await page
		.getByRole('button')
		.filter({ has: page.locator('.i-basket') })
		.click()
	await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible({ timeout: 5_000 })
}

// ---------------------------------------------------------------------------
// A. Marketplace Display
// ---------------------------------------------------------------------------

test.describe('Marketplace Display', () => {
	test('shows products from multiple sellers', async ({ newUserPage }) => {
		await safeGoto(newUserPage, '/products')

		// Wait for products from both merchants to load
		await expect(async () => {
			const content = await newUserPage.locator('main').textContent()
			expect(content).toContain('Bitcoin Hardware Wallet')
			expect(content).toContain('Lightning Node Setup Guide')
		}).toPass({ timeout: 30_000 })

		// Verify product cards are visible
		const walletCard = newUserPage.locator('[data-testid="product-card"]').filter({ hasText: 'Bitcoin Hardware Wallet' })
		await expect(walletCard).toBeVisible()

		const guideCard = newUserPage.locator('[data-testid="product-card"]').filter({ hasText: 'Lightning Node Setup Guide' })
		await expect(guideCard).toBeVisible()

		// Navigate to each product detail page and verify "Sold by"
		await walletCard.click()
		await expect(newUserPage.getByText('Sold by:')).toBeVisible({ timeout: 10_000 })

		// Go back and check the second product
		await safeGoto(newUserPage, '/products')
		await expect(guideCard).toBeVisible({ timeout: 15_000 })
		await guideCard.click()
		await expect(newUserPage.getByText('Sold by:')).toBeVisible({ timeout: 10_000 })
	})
})

// ---------------------------------------------------------------------------
// B. Multi-Merchant Cart
// ---------------------------------------------------------------------------

test.describe('Multi-Merchant Cart', () => {
	test('can add products from two different sellers to cart', async ({ newUserPage }) => {
		await addProductsFromBothSellers(newUserPage)

		// Open cart drawer
		await openCart(newUserPage)

		// Cart should show items grouped by seller.
		// Verify both product names appear in the cart.
		const cartDialog = newUserPage.getByRole('dialog', { name: /your cart/i })
		await expect(cartDialog.getByText('Bitcoin Hardware Wallet')).toBeVisible()
		await expect(cartDialog.getByText('Lightning Node Setup Guide')).toBeVisible()

		// Shipping selection is deferred to checkout: each item shows the
		// "Select shipping at checkout" placeholder instead of an inline picker.
		const shippingPlaceholders = cartDialog.getByText('Select shipping at checkout', { exact: true })
		await expect(shippingPlaceholders).toHaveCount(2, { timeout: 10_000 })
	})

	test('checkout requires shipping per seller before continuing', async ({ newUserPage }) => {
		await addProductsFromBothSellers(newUserPage)
		await openCart(newUserPage)

		const cartDialog = newUserPage.getByRole('dialog', { name: /your cart/i })

		// Cart no longer gates on shipping — proceed straight to checkout,
		// where the shipping step enforces a method per item/seller.
		await cartDialog.getByRole('button', { name: /^checkout$/i }).click()

		// The shipping step shows the missing-shipping notice and disables Continue
		await expect(newUserPage.getByText(/please select shipping options for all items/i)).toBeVisible({ timeout: 15_000 })
		const continueButton = newUserPage.getByRole('button', { name: /continue to review/i })
		await expect(continueButton).toBeDisabled()

		// Select shipping for the first seller only
		await newUserPage.getByText('Select shipping method').first().click()
		await newUserPage.getByRole('option', { name: /digital delivery/i }).click()
		await newUserPage.waitForTimeout(500)

		// Still gated (second seller missing)
		await expect(continueButton).toBeDisabled()

		// Select shipping for the second seller
		await newUserPage.getByText('Select shipping method').first().click()
		await newUserPage.getByRole('option', { name: /digital delivery/i }).click()

		// Notice clears once every item has a shipping method
		await expect(newUserPage.getByText(/please select shipping options for all items/i)).not.toBeVisible({ timeout: 10_000 })
	})
})

// ---------------------------------------------------------------------------
// C. Multi-Seller Checkout with V4V
// ---------------------------------------------------------------------------

test.describe('Multi-Seller Checkout with V4V', () => {
	test('cart shows V4V payment breakdown per seller', async ({ newUserPage }) => {
		// Both merchants already have V4V configured (10% to TEST_APP_PUBLIC_KEY)
		// from the marketplace scenario seeding.

		await addProductsFromBothSellers(newUserPage)
		await openCart(newUserPage)

		const cartDialog = newUserPage.getByRole('dialog', { name: /your cart/i })

		// Wait for payment breakdown to appear
		await expect(cartDialog.getByText('Payment Breakdown').first()).toBeVisible({ timeout: 10_000 })

		// Should show "Payment Breakdown" for each seller group
		const breakdowns = cartDialog.getByText('Payment Breakdown')
		await expect(breakdowns).toHaveCount(2, { timeout: 10_000 })

		// Each seller should show "Merchant:" and "Community Share:" labels
		const merchantLabels = cartDialog.getByText(/^Merchant:/)
		await expect(merchantLabels).toHaveCount(2, { timeout: 5_000 })

		const communityLabels = cartDialog.getByText(/^Community Share:/)
		await expect(communityLabels).toHaveCount(2, { timeout: 5_000 })

		// Verify percentage displays (90% seller, 10% community)
		await expect(cartDialog.getByText(/90\.00%/).first()).toBeVisible()
		await expect(cartDialog.getByText(/10\.00%/).first()).toBeVisible()
	})
})

// ---------------------------------------------------------------------------
// D. V4V Dashboard Management
// ---------------------------------------------------------------------------

test.describe('V4V Dashboard Management', () => {
	test('circular economy page shows V4V configuration', async ({ merchantPage }) => {
		await safeGoto(merchantPage, '/dashboard/sales/circular-economy')

		// Wait for auth and page to load
		await expect(merchantPage.getByRole('heading', { name: /circular economy/i })).toBeVisible({ timeout: 15_000 })

		// V4V Manager should show the slider with percentage labels.
		// devUser1 has 10% V4V configured (from scenario seeding).
		await expect(merchantPage.getByText(/^Seller: \d+(\.\d+)?%$/)).toBeVisible({ timeout: 10_000 })
		await expect(merchantPage.getByText(/^V4V: \d+(\.\d+)?%$/)).toBeVisible({ timeout: 10_000 })

		// Save button should be visible
		await expect(merchantPage.getByTestId('save-v4v-button')).toBeVisible()
	})

	test('can add a V4V recipient and save', async ({ merchantPage }) => {
		test.setTimeout(60_000)

		await safeGoto(merchantPage, '/dashboard/sales/circular-economy')
		await expect(merchantPage.getByRole('heading', { name: /circular economy/i })).toBeVisible({ timeout: 15_000 })

		// Wait for V4V manager to load
		await expect(merchantPage.getByTestId('add-v4v-recipient-form-button')).toBeVisible({ timeout: 10_000 })

		// Click "Add Recipient" to open the form
		await merchantPage.getByTestId('add-v4v-recipient-form-button').click()

		// The ProfileSearch input should appear
		const searchInput = merchantPage.getByPlaceholder('Search profiles or paste npub...')
		await expect(searchInput).toBeVisible({ timeout: 5_000 })

		// Paste devUser2's npub (has a seeded GRIN payment detail, so the GRIN-capability gate passes)
		const devUser2Npub = nip19.npubEncode(devUser2.pk)
		await searchInput.fill(devUser2Npub)

		// Wait for the profile to resolve and the "Add" button to become enabled
		await expect(merchantPage.getByTestId('add-v4v-recipient-button')).toBeEnabled({ timeout: 15_000 })

		// Click "Add" to confirm
		await merchantPage.getByTestId('add-v4v-recipient-button').click()

		// The recipient should now appear in the list
		// The V4V split section shows recipients with UserWithAvatar
		await expect(merchantPage.getByText(/V4V split between recipients/i)).toBeVisible({ timeout: 5_000 })

		// Click "Save Changes"
		await merchantPage.getByTestId('save-v4v-button').click()

		// Wait for save to complete — button text changes to "Saved"
		await expect(merchantPage.getByText('Saved')).toBeVisible({ timeout: 10_000 })

		// Reload and verify persistence
		await safeGoto(merchantPage, '/dashboard/sales/circular-economy')
		await expect(merchantPage.getByRole('heading', { name: /circular economy/i })).toBeVisible({ timeout: 15_000 })

		// The recipient should still be visible after reload
		await expect(merchantPage.getByText(/V4V split between recipients/i)).toBeVisible({ timeout: 10_000 })
	})
})
