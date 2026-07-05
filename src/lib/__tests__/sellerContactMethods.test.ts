import { describe, expect, test } from 'bun:test'
import {
	DEFAULT_DELIVERY_CONTACT_METHODS,
	getDeliveryContactOptions,
	isValidResolvedDeliveryContact,
	normalizeDeliveryContactMethods,
	resolveCheckoutDeliveryRequirements,
	resolveDeliveryContactOption,
} from '@/lib/checkout/deliveryRequirements'

const product = (id: string, shippingMethodId?: string | null) => ({ id, shippingMethodId })

describe('normalizeDeliveryContactMethods', () => {
	test('trims, drops empties, de-duplicates while preserving order', () => {
		expect(normalizeDeliveryContactMethods([' signal ', 'signal', '', 'Telegram', '   '])).toEqual(['signal', 'Telegram'])
	})

	test('null/undefined yields empty list', () => {
		expect(normalizeDeliveryContactMethods(null)).toEqual([])
		expect(normalizeDeliveryContactMethods(undefined)).toEqual([])
	})
})

describe('resolveCheckoutDeliveryRequirements — seller-enabled contact methods', () => {
	test('exposes the seller-enabled set for a digital product', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('digital-product', '30406:seller:digital')],
			servicesByShippingRef: { '30406:seller:digital': 'digital' },
			contactMethodsByShippingRef: { '30406:seller:digital': ['signal'] },
		})

		expect(requirements.needsDigitalDeliveryContact).toBe(true)
		expect(requirements.digitalDeliveryContactMethods).toEqual(['signal'])
	})

	test('unions the enabled sets across multiple digital products', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('a', '30406:seller:d1'), product('b', '30406:seller:d2')],
			servicesByShippingRef: { '30406:seller:d1': 'digital', '30406:seller:d2': 'digital' },
			contactMethodsByShippingRef: {
				'30406:seller:d1': ['signal', 'session'],
				'30406:seller:d2': ['session', 'Telegram'],
			},
		})

		expect(requirements.digitalDeliveryContactMethods).toEqual(['signal', 'session', 'Telegram'])
	})

	test('older digital product with no seller set falls back to an empty list (buyer form uses defaults)', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('legacy', '30406:seller:digital')],
			servicesByShippingRef: { '30406:seller:digital': 'digital' },
			// No contactMethodsByShippingRef entry — legacy product.
		})

		expect(requirements.needsDigitalDeliveryContact).toBe(true)
		expect(requirements.digitalDeliveryContactMethods).toEqual([])
	})

	test('ignores contact methods for non-digital products', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('physical', '30406:seller:standard')],
			servicesByShippingRef: { '30406:seller:standard': 'standard' },
			contactMethodsByShippingRef: { '30406:seller:standard': ['signal'] },
		})

		expect(requirements.digitalDeliveryContactMethods).toEqual([])
	})
})

describe('getDeliveryContactOptions', () => {
	test('returns only the seller-enabled methods when a set is configured', () => {
		const options = getDeliveryContactOptions(['signal'])
		expect(options.map((o) => o.value)).toEqual(['signal'])
		expect(options[0].label).toBe('Signal')
	})

	test('falls back to the full default channel list when the set is empty', () => {
		const options = getDeliveryContactOptions([])
		expect(options.map((o) => o.value)).toEqual(DEFAULT_DELIVERY_CONTACT_METHODS)
	})

	test('supports custom (free-text) seller methods', () => {
		const options = getDeliveryContactOptions(['Telegram'])
		expect(options).toEqual([
			{ value: 'Telegram', label: 'Telegram', fieldLabel: 'Telegram contact', placeholder: 'Your Telegram contact', isCustom: true },
		])
	})
})

describe('resolveDeliveryContactOption', () => {
	test('known channel resolves to its metadata', () => {
		const option = resolveDeliveryContactOption('signal')
		expect(option.isCustom).toBe(false)
		expect(option.label).toBe('Signal')
	})

	test('custom method resolves to a loose free-text option', () => {
		const option = resolveDeliveryContactOption('Briar')
		expect(option.isCustom).toBe(true)
		expect(option.label).toBe('Briar')
	})
})

describe('isValidResolvedDeliveryContact', () => {
	test('known channels keep their per-type validation', () => {
		expect(isValidResolvedDeliveryContact('email', 'buyer@example.com')).toBe(true)
		expect(isValidResolvedDeliveryContact('email', 'not-an-email')).toBe(false)
		expect(isValidResolvedDeliveryContact('signal', '+15551234567')).toBe(true)
	})

	test('custom methods validate loosely (single token, reasonable length)', () => {
		expect(isValidResolvedDeliveryContact('Telegram', '@myhandle')).toBe(true)
		expect(isValidResolvedDeliveryContact('Telegram', 'ab')).toBe(false)
		expect(isValidResolvedDeliveryContact('Telegram', 'has space')).toBe(false)
		expect(isValidResolvedDeliveryContact('Telegram', '')).toBe(false)
	})
})
