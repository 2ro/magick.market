import { describe, test, expect } from 'bun:test'
import { generateSecretKey, getPublicKey, finalizeEvent, type UnsignedEvent } from 'nostr-tools/pure'
import { Nip05ManagerImpl, NIP05_PRICING, NIP05_GRIN_RECIPIENT_PUBKEY } from '../Nip05Manager'
import { EventSigner } from '../EventSigner'
import { grinToNanogrin } from '@/lib/grin'

const APP_PRIVATE_KEY = Buffer.from(generateSecretKey()).toString('hex')

function makeManager(): Nip05ManagerImpl {
	return new Nip05ManagerImpl(new EventSigner(APP_PRIVATE_KEY))
}

function signReceipt(
	sk: Uint8Array,
	overrides: { username?: string; nanogrin?: number; recipient?: string; kind?: number; createdAt?: number } = {},
) {
	const unsigned: UnsignedEvent = {
		kind: overrides.kind ?? 17,
		created_at: overrides.createdAt ?? Math.floor(Date.now() / 1000),
		pubkey: getPublicKey(sk),
		tags: [
			['p', overrides.recipient ?? NIP05_GRIN_RECIPIENT_PUBKEY],
			['subject', 'nip05-receipt'],
			['nip05', overrides.username ?? 'alice'],
			['payment-request', 'MM-TEST'],
			['payment', 'grin', 'MM-TEST', 'fake-proof'],
			['amount', (overrides.nanogrin ?? NIP05_PRICING['6mo'].nanogrin).toString()],
		],
		content: 'NIP-05 Address: alice (6 Months)',
	}
	return finalizeEvent(unsigned, sk)
}

describe('Nip05ManagerImpl.handleGrinPurchase', () => {
	test('registers a valid 6-month receipt', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk, { username: 'alice' })

		const result = await manager.handleGrinPurchase(receipt)

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.username).toBe('alice')
			const expected = Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60
			expect(result.validUntil).toBeGreaterThan(expected - 5)
			expect(result.validUntil).toBeLessThan(expected + 5)
		}
		expect(manager.resolveUsername('alice')?.pubkey).toBe(getPublicKey(sk))
	})

	test('a 1-year payment grants the longer tier', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk, { username: 'bob', nanogrin: NIP05_PRICING['1yr'].nanogrin })

		const result = await manager.handleGrinPurchase(receipt)

		expect(result.ok).toBe(true)
		if (result.ok) {
			const expected = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
			expect(result.validUntil).toBeGreaterThan(expected - 5)
		}
	})

	test('rejects a receipt addressed to the wrong recipient', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk, { recipient: 'a'.repeat(64) })

		const result = await manager.handleGrinPurchase(receipt)

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/not addressed to the NIP-05 payment recipient/)
	})

	test('rejects insufficient payment', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk, { nanogrin: grinToNanogrin(1) })

		const result = await manager.handleGrinPurchase(receipt)

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/Insufficient payment/)
	})

	test('rejects a tampered (invalid signature) receipt', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk, { username: 'carol' })
		// Round-trip through JSON first, exactly like a real POST body arriving at
		// /api/nip05/claim (JSON.parse never carries nostr-tools' internal
		// verified-cache symbol, unlike an in-process object spread would).
		const wireReceipt = JSON.parse(JSON.stringify(receipt))
		const tampered = {
			...wireReceipt,
			tags: [...wireReceipt.tags.filter((t: string[]) => t[0] !== 'amount'), ['amount', grinToNanogrin(100000).toString()]],
		}

		const result = await manager.handleGrinPurchase(tampered)

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/Invalid event signature/)
	})

	test('rejects a non-kind-17 event', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk, { kind: 1 })

		const result = await manager.handleGrinPurchase(receipt)

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/kind 17/)
	})

	test('rejects a reserved username', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk, { username: 'admin' })

		const result = await manager.handleGrinPurchase(receipt)

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/Reserved/)
	})

	test('rejects a username already taken by another pubkey', async () => {
		const manager = makeManager()
		const owner = generateSecretKey()
		await manager.handleGrinPurchase(signReceipt(owner, { username: 'dave' }))

		const attacker = generateSecretKey()
		const result = await manager.handleGrinPurchase(
			signReceipt(attacker, { username: 'dave', createdAt: Math.floor(Date.now() / 1000) + 1 }),
		)

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/already taken/)
	})

	test('a renewal by the same pubkey extends validUntil additively', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const first = await manager.handleGrinPurchase(signReceipt(sk, { username: 'erin' }))
		expect(first.ok).toBe(true)

		const second = await manager.handleGrinPurchase(signReceipt(sk, { username: 'erin', createdAt: Math.floor(Date.now() / 1000) + 1 }))

		expect(second.ok).toBe(true)
		if (first.ok && second.ok) {
			expect(second.validUntil).toBeGreaterThan(first.validUntil + 180 * 24 * 60 * 60 - 5)
		}
	})

	test('rejects a replayed (already-processed) event id', async () => {
		const manager = makeManager()
		const sk = generateSecretKey()
		const receipt = signReceipt(sk, { username: 'frank' })

		const first = await manager.handleGrinPurchase(receipt)
		expect(first.ok).toBe(true)

		const second = await manager.handleGrinPurchase(receipt)
		expect(second.ok).toBe(false)
		if (!second.ok) expect(second.error).toMatch(/already processed/)
	})
})
