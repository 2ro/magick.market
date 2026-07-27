import { expect, type Page } from '@playwright/test'

/**
 * Dismiss the PII exposure modal if it appears.
 *
 * The PII scanner runs on page load when the user has kind-16 order events
 * with PII tags (address, email, phone) on the relay. PII events from
 * previous test runs accumulate on the reused relay and trigger the modal
 * on subsequent page loads, blocking all clicks. This helper dismisses
 * the modal so test interactions can proceed.
 *
 * Uses `waitFor` (not `isVisible`) so it genuinely waits for React to
 * render the modal before checking — `isVisible({ timeout })` returns
 * immediately and can miss a modal that appears shortly after load.
 */
export async function dismissPIIModalIfPresent(page: Page): Promise<void> {
	const piiVisible = await page
		.getByRole('heading', { name: /personal data may be exposed/i })
		.waitFor({ state: 'visible', timeout: 5000 })
		.then(() => true)
		.catch(() => false)
	if (!piiVisible) return

	const dismissButton = page.getByRole('button', { name: /dismiss warning/i })
	await dismissButton.click()
	await expect(dismissButton).not.toBeVisible({ timeout: 5000 })
}
