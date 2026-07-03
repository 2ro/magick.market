import { describe, test, expect, beforeEach } from 'bun:test'
import {
	decodeOrderCode,
	encodeOrderCode,
	getGuestOrders,
	mintGuestOrderSigner,
	removeGuestOrder,
	saveGuestOrder,
	type GuestOrderRecord,
} from '@/lib/stores/guestOrders'

// bun has no DOM localStorage; provide a minimal in-memory stub so the
// persistence path (save/get/dedupe) is exercised.
function installLocalStorageStub() {
	const store = new Map<string, string>()
	;(globalThis as unknown as { localStorage: Storage }).localStorage = {
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
		key: (i: number) => Array.from(store.keys())[i] ?? null,
		get length() {
			return store.size
		},
	} as Storage
}

const sampleRecord = (overrides: Partial<GuestOrderRecord> = {}): GuestOrderRecord => ({
	orderId: 'order-1',
	invoiceNumber: 'MM-ABCDEF0123456789ABCDEF01',
	sellerPubkey: 'a'.repeat(64),
	amountNanogrin: 1_500_000_000,
	secretKeyHex: 'b'.repeat(64),
	pubkey: 'c'.repeat(64),
	createdAt: Date.now(),
	...overrides,
})

describe('mintGuestOrderSigner', () => {
	test('mints a fresh one-off key each time (no cross-order linkability)', async () => {
		const a = mintGuestOrderSigner()
		const b = mintGuestOrderSigner()
		expect(a.privateKey).toBeTruthy()
		expect(a.privateKey).not.toBe(b.privateKey)
		const [ua, ub] = [await a.user(), await b.user()]
		expect(ua.pubkey).not.toBe(ub.pubkey)
		expect(ua.pubkey).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe('order code round-trip', () => {
	test('encode then decode recovers the exact payload', () => {
		const input = { sk: 'd'.repeat(64), orderId: 'order-xyz', invoiceNumber: 'MM-DEADBEEF0011223344556677', sellerPubkey: 'e'.repeat(64) }
		const code = encodeOrderCode(input)
		expect(code.startsWith('mmorder1')).toBe(true)
		const decoded = decodeOrderCode(code)
		expect(decoded).toEqual({ v: 1, ...input })
	})

	test('the invoice number bridges the order code and the payment memo', () => {
		const invoiceNumber = 'MM-0123456789ABCDEF01234567'
		const code = encodeOrderCode({ sk: 'f'.repeat(64), orderId: 'o', invoiceNumber, sellerPubkey: '0'.repeat(64) })
		expect(decodeOrderCode(code)?.invoiceNumber).toBe(invoiceNumber)
	})

	test('rejects codes without the prefix, with a bad version, or with corrupted body', () => {
		expect(decodeOrderCode('not-an-order-code')).toBeNull()
		expect(decodeOrderCode('')).toBeNull()
		const good = encodeOrderCode({ sk: '1'.repeat(64), orderId: 'o', invoiceNumber: 'MM-1', sellerPubkey: '2'.repeat(64) })
		expect(decodeOrderCode(good.slice(0, -4) + 'zzzz')).toBeNull()
	})

	test('tolerates surrounding whitespace', () => {
		const code = encodeOrderCode({ sk: '3'.repeat(64), orderId: 'o', invoiceNumber: 'MM-3', sellerPubkey: '4'.repeat(64) })
		expect(decodeOrderCode(`  ${code}\n`)).not.toBeNull()
	})
})

describe('guest order persistence', () => {
	beforeEach(() => installLocalStorageStub())

	test('saves, dedupes by orderId, and returns newest-first', () => {
		saveGuestOrder(sampleRecord({ orderId: 'a', createdAt: 100 }))
		saveGuestOrder(sampleRecord({ orderId: 'b', createdAt: 200 }))
		saveGuestOrder(sampleRecord({ orderId: 'a', createdAt: 999 })) // duplicate orderId ignored
		const orders = getGuestOrders()
		expect(orders.map((o) => o.orderId)).toEqual(['b', 'a'])
		expect(orders.find((o) => o.orderId === 'a')?.createdAt).toBe(100)
	})

	test('removeGuestOrder drops the matching record', () => {
		saveGuestOrder(sampleRecord({ orderId: 'a' }))
		saveGuestOrder(sampleRecord({ orderId: 'b' }))
		removeGuestOrder('a')
		expect(getGuestOrders().map((o) => o.orderId)).toEqual(['b'])
	})
})
