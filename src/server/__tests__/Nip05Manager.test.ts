import { describe, test, expect } from 'bun:test'
import { generateSecretKey, getPublicKey, finalizeEvent, type UnsignedEvent } from 'nostr-tools/pure'
import { Nip05ManagerImpl, NIP05_PRICING, NIP05_GRIN_RECIPIENT_PUBKEY } from '../Nip05Manager'
import { EventSigner } from '../EventSigner'
import { buildNameOrderRef, type GoblinPayInvoiceView } from '../nameGrant'
import { grinToNanogrin } from '@/lib/grin'

const APP_PRIVATE_KEY = Buffer.from(generateSecretKey()).toString('hex')

function makeManager(): Nip05ManagerImpl {
	return new Nip05ManagerImpl(new EventSigner(APP_PRIVATE_KEY))
}

// A buyer-signed claim (kind 17) now carries `['invoice', id]` instead of the
// old amount/proof tags — the amount and payment status live on GoblinPay.
function signReceipt(
	sk: Uint8Array,
	overrides: { username?: string; recipient?: string; kind?: number; createdAt?: number; invoiceId?: string } = {},
) {
	const unsigned: UnsignedEvent = {
		kind: overrides.kind ?? 17,
		created_at: overrides.createdAt ?? Math.floor(Date.now() / 1000),
		pubkey: getPublicKey(sk),
		tags: [
			['p', overrides.recipient ?? NIP05_GRIN_RECIPIENT_PUBKEY],
			['subject', 'nip05-receipt'],
			['nip05', overrides.username ?? 'alice'],
			['invoice', overrides.invoiceId ?? 'inv-alice'],
		],
		content: 'NIP-05 Address claim',
	}
	return finalizeEvent(unsigned, sk)
}

// A fake GoblinPay fetcher returning a confirmed invoice bound to this buyer.
function confirmedFetcher(
	sk: Uint8Array,
	opts: { username?: string; nanogrin?: number; status?: string } = {},
): (invoiceId: string) => Promise<GoblinPayInvoiceView | null> {
	return async (invoiceId: string) => ({
		invoiceId,
		status: opts.status ?? 'confirmed',
		confirmations: 10,
		confirmationsRequired: 10,
		orderRef: buildNameOrderRef('nip05', opts.username ?? 'alice', getPublicKey(sk)),
		amountNanogrin: opts.nanogrin ?? NIP05_PRICING['6mo'].nanogrin,
	})
}

const unreachable = async () => null

describe('Nip05ManagerImpl.handleGrinPurchase', () => {
	test('registers a name from a confirmed 6-month invoice', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk, { username: 'alice' }), confirmedFetcher(sk, { username: 'alice' }))

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.username).toBe('alice')
			const expected = Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60
			expect(result.validUntil).toBeGreaterThan(expected - 5)
			expect(result.validUntil).toBeLessThan(expected + 5)
		}
		expect(manager.resolveUsername('alice')?.pubkey).toBe(getPublicKey(sk))
	})

	test('a 1-year invoice grants the longer tier', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(
			signReceipt(sk, { username: 'bob' }),
			confirmedFetcher(sk, { username: 'bob', nanogrin: NIP05_PRICING['1yr'].nanogrin }),
		)
		expect(result.ok).toBe(true)
		if (result.ok) {
			const expected = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
			expect(result.validUntil).toBeGreaterThan(expected - 5)
		}
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
		if (!result.ok) expect(result.error).toMatch(/not addressed to the NIP-05 payment recipient/)
	})

	test('rejects a claim with no usable invoice id', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk, { invoiceId: '' }), confirmedFetcher(sk))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/missing invoice tag/)
	})

	test('rejects an invoice whose amount clears no tier', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk), confirmedFetcher(sk, { nanogrin: grinToNanogrin(1) }))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/does not cover any pricing tier/)
	})

	test('rejects a tampered (invalid signature) claim before touching GoblinPay', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk, { username: 'carol' })
		const wireReceipt = JSON.parse(JSON.stringify(receipt))
		const tampered = { ...wireReceipt, tags: [...wireReceipt.tags, ['nip05', 'evil']] }
		const result = await manager.handleGrinPurchase(tampered, confirmedFetcher(sk))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/Invalid event signature/)
	})

	test('rejects a non-kind-17 event', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk, { kind: 1 }), confirmedFetcher(sk))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/kind 17/)
	})

	test('rejects a reserved username', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const result = await manager.handleGrinPurchase(signReceipt(sk, { username: 'admin' }), confirmedFetcher(sk, { username: 'admin' }))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/Reserved/)
	})

	test('rejects a username already taken by another pubkey', async () => {
		const manager = makeManager()
		const owner = generateSecretKey()
		await manager.handleGrinPurchase(signReceipt(owner, { username: 'dave' }), confirmedFetcher(owner, { username: 'dave' }))

		const attacker = generateSecretKey()
		const result = await manager.handleGrinPurchase(
			signReceipt(attacker, { username: 'dave', createdAt: Math.floor(Date.now() / 1000) + 1, invoiceId: 'inv-attacker' }),
			confirmedFetcher(attacker, { username: 'dave' }),
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/already taken/)
	})

	test('a renewal by the same pubkey (new invoice) extends validUntil additively', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const first = await manager.handleGrinPurchase(
			signReceipt(sk, { username: 'erin', invoiceId: 'inv-1' }),
			confirmedFetcher(sk, { username: 'erin' }),
		)
		expect(first.ok).toBe(true)

		const second = await manager.handleGrinPurchase(
			signReceipt(sk, { username: 'erin', createdAt: Math.floor(Date.now() / 1000) + 1, invoiceId: 'inv-2' }),
			confirmedFetcher(sk, { username: 'erin' }),
		)
		expect(second.ok).toBe(true)
		if (first.ok && second.ok) {
			expect(second.validUntil).toBeGreaterThan(first.validUntil + 180 * 24 * 60 * 60 - 5)
		}
	})

	test('rejects reuse of an already-consumed invoice id (a second, different claim)', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const first = await manager.handleGrinPurchase(
			signReceipt(sk, { username: 'frank', invoiceId: 'inv-dup' }),
			confirmedFetcher(sk, { username: 'frank' }),
		)
		expect(first.ok).toBe(true)

		// A brand-new claim event (different id) reusing the same confirmed invoice.
		const second = await manager.handleGrinPurchase(
			signReceipt(sk, { username: 'frank', createdAt: Math.floor(Date.now() / 1000) + 2, invoiceId: 'inv-dup' }),
			confirmedFetcher(sk, { username: 'frank' }),
		)
		expect(second.ok).toBe(false)
		if (!second.ok) expect(second.status).toBe(409)
	})

	test('rejects a replayed (already-processed) event id', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk, { username: 'grace' })
		const first = await manager.handleGrinPurchase(receipt, confirmedFetcher(sk, { username: 'grace' }))
		expect(first.ok).toBe(true)

		const second = await manager.handleGrinPurchase(receipt, confirmedFetcher(sk, { username: 'grace' }))
		expect(second.ok).toBe(false)
		if (!second.ok) expect(second.error).toMatch(/already processed/)
	})
})
