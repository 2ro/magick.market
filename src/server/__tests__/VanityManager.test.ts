import { describe, test, expect } from 'bun:test'
import { generateSecretKey, getPublicKey, finalizeEvent, type UnsignedEvent } from 'nostr-tools/pure'
import { VanityManagerImpl, VANITY_PRICING, VANITY_GRIN_RECIPIENT_PUBKEY, matchVanityPricingTier } from '../VanityManager'
import { EventSigner } from '../EventSigner'
import { buildNameOrderRef, type GoblinPayInvoiceView } from '../nameGrant'
import { grinToNanogrin } from '@/lib/grin'

const APP_PRIVATE_KEY = Buffer.from(generateSecretKey()).toString('hex')

function makeManager(): VanityManagerImpl {
	return new VanityManagerImpl(new EventSigner(APP_PRIVATE_KEY))
}

// A buyer-signed claim (kind 17) carrying `['invoice', id]`.
function signReceipt(
	sk: Uint8Array,
	overrides: { vanityName?: string; recipient?: string; kind?: number; createdAt?: number; invoiceId?: string } = {},
) {
	const unsigned: UnsignedEvent = {
		kind: overrides.kind ?? 17,
		created_at: overrides.createdAt ?? Math.floor(Date.now() / 1000),
		pubkey: getPublicKey(sk),
		tags: [
			['p', overrides.recipient ?? VANITY_GRIN_RECIPIENT_PUBKEY],
			['subject', 'vanity-receipt'],
			['vanity', overrides.vanityName ?? 'alice-shop'],
			['invoice', overrides.invoiceId ?? 'inv-vanity'],
		],
		content: 'Vanity URL claim',
	}
	return finalizeEvent(unsigned, sk)
}

// A fake GoblinPay fetcher returning a confirmed invoice bound to this buyer.
function confirmedFetcher(
	sk: Uint8Array,
	opts: { vanityName?: string; nanogrin?: number; status?: string } = {},
): (invoiceId: string) => Promise<GoblinPayInvoiceView | null> {
	return async (invoiceId: string) => ({
		invoiceId,
		status: opts.status ?? 'confirmed',
		confirmations: 10,
		confirmationsRequired: 10,
		orderRef: buildNameOrderRef('vanity', opts.vanityName ?? 'alice-shop', getPublicKey(sk)),
		amountNanogrin: opts.nanogrin ?? VANITY_PRICING['6mo'].nanogrin,
	})
}

const unreachable = async () => null

describe('matchVanityPricingTier', () => {
	test('matches the 6-month and 1-year tiers, rejects below-tier amounts', () => {
		expect(matchVanityPricingTier(VANITY_PRICING['6mo'].nanogrin)).toBe(180 * 24 * 60 * 60)
		expect(matchVanityPricingTier(VANITY_PRICING['1yr'].nanogrin)).toBe(365 * 24 * 60 * 60)
		expect(matchVanityPricingTier(grinToNanogrin(0.5))).toBeNull()
	})
})

describe('VanityManagerImpl.handleGrinPurchase', () => {
	test('registers a vanity URL from a confirmed 6-month invoice', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk), confirmedFetcher(sk))

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.vanityName).toBe('alice-shop')
			const expected = Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60
			expect(result.validUntil).toBeGreaterThan(expected - 5)
			expect(result.validUntil).toBeLessThan(expected + 5)
		}
		expect(manager.resolveVanity('alice-shop')?.pubkey).toBe(getPublicKey(sk))
	})

	test('does not grant while the invoice is not yet confirmed', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk), confirmedFetcher(sk, { status: 'paid' }))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.status).toBe(402)
	})

	test('fails closed when GoblinPay is unreachable', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk), unreachable)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.status).toBe(503)
	})

	test('rejects a claim addressed to the wrong recipient', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk, { recipient: 'a'.repeat(64) }), confirmedFetcher(sk))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.status).toBe(400)
	})

	test('rejects an invoice whose amount clears no tier', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk), confirmedFetcher(sk, { nanogrin: grinToNanogrin(0.1) }))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain('does not cover any pricing tier')
	})

	test('rejects a non-kind-17 event', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk, { kind: 1 }), confirmedFetcher(sk))
		expect(result.ok).toBe(false)
	})

	test('rejects a reserved vanity name', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk, { vanityName: 'admin' }), confirmedFetcher(sk, { vanityName: 'admin' }))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain('Reserved')
	})

	test('rejects a name already taken by another pubkey', async () => {
		const manager = makeManager()
		const owner = generateSecretKey()
		const first = await manager.handleGrinPurchase(
			signReceipt(owner, { vanityName: 'taken-name' }),
			confirmedFetcher(owner, { vanityName: 'taken-name' }),
		)
		expect(first.ok).toBe(true)
		const attacker = generateSecretKey()
		const second = await manager.handleGrinPurchase(
			signReceipt(attacker, { vanityName: 'taken-name', invoiceId: 'inv-2' }),
			confirmedFetcher(attacker, { vanityName: 'taken-name' }),
		)
		expect(second.ok).toBe(false)
		if (!second.ok) expect(second.error).toContain('taken')
	})

	test('rejects reuse of an already-consumed invoice id', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const first = await manager.handleGrinPurchase(
			signReceipt(sk, { vanityName: 'reuse-shop', invoiceId: 'inv-dup' }),
			confirmedFetcher(sk, { vanityName: 'reuse-shop' }),
		)
		expect(first.ok).toBe(true)
		const second = await manager.handleGrinPurchase(
			signReceipt(sk, { vanityName: 'reuse-shop', createdAt: Math.floor(Date.now() / 1000) + 2, invoiceId: 'inv-dup' }),
			confirmedFetcher(sk, { vanityName: 'reuse-shop' }),
		)
		expect(second.ok).toBe(false)
		if (!second.ok) expect(second.status).toBe(409)
	})

	test('rejects a replayed (already-processed) event id', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk, { vanityName: 'replay-shop' })
		expect((await manager.handleGrinPurchase(receipt, confirmedFetcher(sk, { vanityName: 'replay-shop' }))).ok).toBe(true)
		const replay = await manager.handleGrinPurchase(receipt, confirmedFetcher(sk, { vanityName: 'replay-shop' }))
		expect(replay.ok).toBe(false)
		if (!replay.ok) expect(replay.status).toBe(409)
	})
})
