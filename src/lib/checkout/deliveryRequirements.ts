export type CheckoutDeliveryMode = 'physical' | 'pickup' | 'digital'

export type CheckoutDeliveryRequirementInput = {
	products: Array<{
		id: string
		shippingMethodId?: string | null
	}>
	servicesByShippingRef: Record<string, string | null | undefined>
}

export type CheckoutDeliveryRequirements = {
	hasDigitalDelivery: boolean
	hasPhysicalDelivery: boolean
	hasPickupDelivery: boolean
	needsDigitalDeliveryContact: boolean
	needsPhysicalAddress: boolean
	isResolved: boolean
	unresolvedShippingRefs: string[]
}

const PHYSICAL_SERVICES = new Set(['standard', 'express', 'overnight'])

export function getCheckoutDeliveryMode(service: string | null | undefined): CheckoutDeliveryMode | null {
	if (service === 'digital') return 'digital'
	if (service === 'pickup') return 'pickup'
	if (service && PHYSICAL_SERVICES.has(service)) return 'physical'
	return null
}

export function resolveCheckoutDeliveryRequirements(input: CheckoutDeliveryRequirementInput): CheckoutDeliveryRequirements {
	let hasDigitalDelivery = false
	let hasPhysicalDelivery = false
	let hasPickupDelivery = false
	const unresolvedShippingRefs = new Set<string>()

	for (const product of input.products) {
		const shippingRef = product.shippingMethodId?.trim()

		if (!shippingRef) {
			unresolvedShippingRefs.add(`product:${product.id}:missing-shipping-method`)
			continue
		}

		const mode = getCheckoutDeliveryMode(input.servicesByShippingRef[shippingRef])

		if (!mode) {
			unresolvedShippingRefs.add(shippingRef)
			continue
		}

		if (mode === 'digital') {
			hasDigitalDelivery = true
		} else if (mode === 'pickup') {
			hasPickupDelivery = true
		} else {
			hasPhysicalDelivery = true
		}
	}

	return {
		hasDigitalDelivery,
		hasPhysicalDelivery,
		hasPickupDelivery,
		needsDigitalDeliveryContact: hasDigitalDelivery,
		needsPhysicalAddress: hasPhysicalDelivery,
		isResolved: unresolvedShippingRefs.size === 0,
		unresolvedShippingRefs: Array.from(unresolvedShippingRefs),
	}
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Privacy-respecting delivery contact channels a buyer can hand a seller so the
 * seller can reach them to deliver a digital item. Email stays the default and
 * keeps its historical on-order wire shape; the others are messenger handles or
 * invite links validated only loosely (they have no single canonical format).
 */
export const DELIVERY_CONTACT_TYPES = ['email', 'signal', 'matrix', 'session', 'simplex'] as const

export type DeliveryContactType = (typeof DELIVERY_CONTACT_TYPES)[number]

export const DEFAULT_DELIVERY_CONTACT_TYPE: DeliveryContactType = 'email'

export function isDeliveryContactType(value: string | null | undefined): value is DeliveryContactType {
	return !!value && (DELIVERY_CONTACT_TYPES as readonly string[]).includes(value)
}

type DeliveryContactChannelMeta = {
	value: DeliveryContactType
	label: string
	fieldLabel: string
	placeholder: string
}

export const DELIVERY_CONTACT_CHANNELS: Record<DeliveryContactType, DeliveryContactChannelMeta> = {
	email: { value: 'email', label: 'Email', fieldLabel: 'Email address', placeholder: 'e.g. name@example.com' },
	signal: { value: 'signal', label: 'Signal', fieldLabel: 'Signal number or username', placeholder: 'e.g. +15551234567 or user.01' },
	matrix: { value: 'matrix', label: 'Matrix', fieldLabel: 'Matrix ID', placeholder: 'e.g. @name:matrix.org' },
	session: { value: 'session', label: 'Session', fieldLabel: 'Session ID', placeholder: 'e.g. 05abc… Session ID' },
	simplex: {
		value: 'simplex',
		label: 'SimpleX',
		fieldLabel: 'SimpleX address or invite link',
		placeholder: 'e.g. https://simplex.chat/invitation#…',
	},
}

export const DELIVERY_CONTACT_CHANNEL_LIST: DeliveryContactChannelMeta[] = DELIVERY_CONTACT_TYPES.map(
	(type) => DELIVERY_CONTACT_CHANNELS[type],
)

/**
 * Light per-type validation. Email must look like an email; the messenger
 * channels accept any single-token handle or link (no whitespace, a few chars
 * long) because their handle/link formats vary and we do not want to reject a
 * valid contact the buyer knows works.
 */
export function isValidDeliveryContact(type: DeliveryContactType | string | null | undefined, value: string | null | undefined): boolean {
	const trimmed = value?.trim()
	if (!trimmed) return false

	if (type === 'email' || !isDeliveryContactType(type)) {
		return EMAIL_REGEX.test(trimmed)
	}

	// Messenger handles / invite links: no internal whitespace, reasonable length.
	if (/\s/.test(trimmed)) return false
	return trimmed.length >= 3 && trimmed.length <= 2000
}

/**
 * Back-compat email-only check retained for the historical digital-delivery
 * contact path. Equivalent to {@link isValidDeliveryContact} with type 'email'.
 */
export function isValidDigitalDeliveryContact(value: string | null | undefined): boolean {
	return isValidDeliveryContact('email', value)
}
