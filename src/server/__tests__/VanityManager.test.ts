import { describe, test, expect } from 'bun:test'
import { generateSecretKey, getPublicKey, finalizeEvent, type UnsignedEvent } from 'nostr-tools/pure'
import { VanityManagerImpl, VANITY_PRICING, VANITY_GRIN_RECIPIENT_PUBKEY, matchVanityPricingTier } from '../VanityManager'
import { EventSigner } from '../EventSigner'
import { grinToNanogrin } from '@/lib/grin'

const APP_PRIVATE_KEY = Buffer.from(generateSecretKey()).toString('hex')

function makeManager(): VanityManagerImpl {
	return new VanityManagerImpl(new EventSigner(APP_PRIVATE_KEY))
}

function signReceipt(sk: Uint8Array, overrides: { vanityName?: string; nanogrin?: number; recipient?: string; kind?: number } = {}) {
	const unsigned: UnsignedEvent = {
		kind: overrides.kind ?? 17,
		created_at: Math.floor(Date.now() / 1000),
		pubkey: getPublicKey(sk),
		tags: [
			['p', overrides.recipient ?? VANITY_GRIN_RECIPIENT_PUBKEY],
			['subject', 'vanity-receipt'],
			['vanity', overrides.vanityName ?? 'alice-shop'],
			['payment-request', 'MM-TEST'],
			['payment', 'grin', 'MM-TEST', 'fake-proof'],
			['amount', (overrides.nanogrin ?? VANITY_PRICING['6mo'].nanogrin).toString()],
		],
		content: 'Vanity URL: alice-shop (6 Months)',
	}
	return finalizeEvent(unsigned, sk)
}

describe('matchVanityPricingTier', () => {
	test('matches the 6-month and 1-year tiers, rejects below-tier amounts', () => {
		expect(matchVanityPricingTier(VANITY_PRICING['6mo'].nanogrin)).toBe(180 * 24 * 60 * 60)
		expect(matchVanityPricingTier(VANITY_PRICING['1yr'].nanogrin)).toBe(365 * 24 * 60 * 60)
		expect(matchVanityPricingTier(grinToNanogrin(0.5))).toBeNull()
	})
})

describe('VanityManagerImpl.handleGrinPurchase', () => {
	test('registers a valid 6-month receipt', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk))

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.vanityName).toBe('alice-shop')
			const expected = Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60
			expect(result.validUntil).toBeGreaterThan(expected - 5)
			expect(result.validUntil).toBeLessThan(expected + 5)
		}
		expect(manager.resolveVanity('alice-shop')?.pubkey).toBe(getPublicKey(sk))
	})

	test('rejects a receipt addressed to the wrong recipient', async () => {
		const manager = makeManager()
		const result = await manager.handleGrinPurchase(signReceipt(generateSecretKey(), { recipient: 'a'.repeat(64) }))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.status).toBe(400)
	})

	test('rejects insufficient payment', async () => {
		const manager = makeManager()
		const result = await manager.handleGrinPurchase(signReceipt(generateSecretKey(), { nanogrin: grinToNanogrin(0.1) }))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain('Insufficient payment')
	})

	test('rejects a non-kind-17 event', async () => {
		const manager = makeManager()
		const result = await manager.handleGrinPurchase(signReceipt(generateSecretKey(), { kind: 1 }))
		expect(result.ok).toBe(false)
	})

	test('rejects a reserved vanity name', async () => {
		const manager = makeManager()
		const result = await manager.handleGrinPurchase(signReceipt(generateSecretKey(), { vanityName: 'admin' }))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain('Reserved')
	})

	test('rejects a name already taken by another pubkey', async () => {
		const manager = makeManager()
		const first = await manager.handleGrinPurchase(signReceipt(generateSecretKey(), { vanityName: 'taken-name' }))
		expect(first.ok).toBe(true)
		const second = await manager.handleGrinPurchase(signReceipt(generateSecretKey(), { vanityName: 'taken-name' }))
		expect(second.ok).toBe(false)
		if (!second.ok) expect(second.error).toContain('taken')
	})

	test('rejects a replayed (already-processed) event id', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk)
		expect((await manager.handleGrinPurchase(receipt)).ok).toBe(true)
		const replay = await manager.handleGrinPurchase(receipt)
		expect(replay.ok).toBe(false)
		if (!replay.ok) expect(replay.status).toBe(409)
	})
})
