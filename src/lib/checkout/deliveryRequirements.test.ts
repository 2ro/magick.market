import { describe, expect, test } from 'bun:test'
import {
	DELIVERY_CONTACT_TYPES,
	isDeliveryContactType,
	isValidDeliveryContact,
	isValidDigitalDeliveryContact,
	resolveCheckoutDeliveryRequirements,
} from '@/lib/checkout/deliveryRequirements'

const product = (id: string, shippingMethodId?: string | null) => ({ id, shippingMethodId })

describe('resolveCheckoutDeliveryRequirements', () => {
	test('digital-only cart requires delivery contact and not physical address', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('digital-product', '30406:seller:digital')],
			servicesByShippingRef: {
				'30406:seller:digital': 'digital',
			},
		})

		expect(requirements).toMatchObject({
			hasDigitalDelivery: true,
			hasPhysicalDelivery: false,
			hasPickupDelivery: false,
			needsDigitalDeliveryContact: true,
			needsPhysicalAddress: false,
			isResolved: true,
		})
	})

	test('physical-only cart requires physical address and not contact', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('physical-product', '30406:seller:standard')],
			servicesByShippingRef: {
				'30406:seller:standard': 'standard',
			},
		})

		expect(requirements).toMatchObject({
			hasDigitalDelivery: false,
			hasPhysicalDelivery: true,
			hasPickupDelivery: false,
			needsDigitalDeliveryContact: false,
			needsPhysicalAddress: true,
			isResolved: true,
		})
	})

	test('pickup-only cart requires neither physical address nor contact', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('pickup-product', '30406:seller:pickup')],
			servicesByShippingRef: {
				'30406:seller:pickup': 'pickup',
			},
		})

		expect(requirements).toMatchObject({
			hasDigitalDelivery: false,
			hasPhysicalDelivery: false,
			hasPickupDelivery: true,
			needsDigitalDeliveryContact: false,
			needsPhysicalAddress: false,
			isResolved: true,
		})
	})

	test('mixed digital and pickup requires contact and not physical address', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('digital-product', '30406:seller:digital'), product('pickup-product', '30406:seller:pickup')],
			servicesByShippingRef: {
				'30406:seller:digital': 'digital',
				'30406:seller:pickup': 'pickup',
			},
		})

		expect(requirements).toMatchObject({
			hasDigitalDelivery: true,
			hasPhysicalDelivery: false,
			hasPickupDelivery: true,
			needsDigitalDeliveryContact: true,
			needsPhysicalAddress: false,
			isResolved: true,
		})
	})

	test('mixed digital and physical requires contact and physical address', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('digital-product', '30406:seller:digital'), product('physical-product', '30406:seller:express')],
			servicesByShippingRef: {
				'30406:seller:digital': 'digital',
				'30406:seller:express': 'express',
			},
		})

		expect(requirements).toMatchObject({
			hasDigitalDelivery: true,
			hasPhysicalDelivery: true,
			hasPickupDelivery: false,
			needsDigitalDeliveryContact: true,
			needsPhysicalAddress: true,
			isResolved: true,
		})
	})

	test('missing shipping method is unresolved', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('missing-method', null)],
			servicesByShippingRef: {},
		})

		expect(requirements.isResolved).toBe(false)
		expect(requirements.unresolvedShippingRefs).toEqual(['product:missing-method:missing-shipping-method'])
	})

	test('missing service for selected shipping ref is unresolved', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('unknown-service', '30406:seller:unknown')],
			servicesByShippingRef: {
				'30406:seller:unknown': null,
			},
		})

		expect(requirements.isResolved).toBe(false)
		expect(requirements.unresolvedShippingRefs).toEqual(['30406:seller:unknown'])
	})

	test('unknown service is unresolved instead of guessed', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('drone-service', '30406:seller:drone')],
			servicesByShippingRef: {
				'30406:seller:drone': 'drone',
			},
		})

		expect(requirements.isResolved).toBe(false)
		expect(requirements.unresolvedShippingRefs).toEqual(['30406:seller:drone'])
		expect(requirements.needsPhysicalAddress).toBe(false)
		expect(requirements.needsDigitalDeliveryContact).toBe(false)
	})

	test('unresolved delivery requirement fails closed', () => {
		const requirements = resolveCheckoutDeliveryRequirements({
			products: [product('digital-product', '30406:seller:digital'), product('missing-service', '30406:seller:missing')],
			servicesByShippingRef: {
				'30406:seller:digital': 'digital',
			},
		})

		expect(requirements.hasDigitalDelivery).toBe(true)
		expect(requirements.needsDigitalDeliveryContact).toBe(true)
		expect(requirements.isResolved).toBe(false)
		expect(requirements.unresolvedShippingRefs).toEqual(['30406:seller:missing'])
	})
})

describe('isValidDigitalDeliveryContact', () => {
	test('accepts valid email contact for v1', () => {
		expect(isValidDigitalDeliveryContact('buyer@example.com')).toBe(true)
	})

	test('rejects empty or invalid contact', () => {
		expect(isValidDigitalDeliveryContact('')).toBe(false)
		expect(isValidDigitalDeliveryContact('not-an-email')).toBe(false)
	})
})

describe('delivery contact channels', () => {
	test('exposes the five privacy-respecting channels', () => {
		expect(DELIVERY_CONTACT_TYPES).toEqual(['email', 'signal', 'matrix', 'session', 'simplex'])
	})

	test('isDeliveryContactType narrows only to known channels', () => {
		expect(isDeliveryContactType('signal')).toBe(true)
		expect(isDeliveryContactType('email')).toBe(true)
		expect(isDeliveryContactType('bitcoin')).toBe(false)
		expect(isDeliveryContactType(undefined)).toBe(false)
	})
})

describe('isValidDeliveryContact', () => {
	test('email must look like an email', () => {
		expect(isValidDeliveryContact('email', 'buyer@example.com')).toBe(true)
		expect(isValidDeliveryContact('email', 'not-an-email')).toBe(false)
		// A messenger handle in the email slot is rejected.
		expect(isValidDeliveryContact('email', '@name:matrix.org')).toBe(false)
	})

	test('messenger channels accept loose handles and links', () => {
		expect(isValidDeliveryContact('signal', '+15551234567')).toBe(true)
		expect(isValidDeliveryContact('signal', 'user.01')).toBe(true)
		expect(isValidDeliveryContact('matrix', '@name:matrix.org')).toBe(true)
		expect(isValidDeliveryContact('session', '05abc123def456')).toBe(true)
		expect(isValidDeliveryContact('simplex', 'https://simplex.chat/invitation#/?v=2')).toBe(true)
	})

	test('messenger channels reject empty, whitespace, or too-short handles', () => {
		expect(isValidDeliveryContact('signal', '')).toBe(false)
		expect(isValidDeliveryContact('matrix', 'a')).toBe(false)
		expect(isValidDeliveryContact('session', 'has space')).toBe(false)
	})

	test('unknown channel type falls back to strict email validation', () => {
		expect(isValidDeliveryContact('bitcoin', 'buyer@example.com')).toBe(true)
		expect(isValidDeliveryContact('bitcoin', 'lnbc-invoice')).toBe(false)
	})
})
