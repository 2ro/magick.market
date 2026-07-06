export type CheckoutDeliveryMode = 'physical' | 'pickup' | 'digital'

export type CheckoutDeliveryRequirementInput = {
	products: Array<{
		id: string
		shippingMethodId?: string | null
	}>
	servicesByShippingRef: Record<string, string | null | undefined>
	// Seller-controlled: the secure contact/messaging methods each digital
	// shipping option enables. The buyer picks from this per-product-seller set.
	// Older products with no methods set fall back to the full default channel list.
	contactMethodsByShippingRef?: Record<string, string[] | null | undefined>
}

export type CheckoutDeliveryRequirements = {
	hasDigitalDelivery: boolean
	hasPhysicalDelivery: boolean
	hasPickupDelivery: boolean
	needsDigitalDeliveryContact: boolean
	needsPhysicalAddress: boolean
	isResolved: boolean
	unresolvedShippingRefs: string[]
	// The union of seller-enabled contact methods across the cart's digital
	// products. Empty means no seller configured a set (older products) — the
	// buyer form falls back to the full default channel list.
	digitalDeliveryContactMethods: string[]
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
	const digitalContactMethods = new Set<string>()

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
			// Seller-controlled set for this product: fold its enabled methods into
			// the cart-wide union the buyer will pick from.
			for (const method of normalizeDeliveryContactMethods(input.contactMethodsByShippingRef?.[shippingRef])) {
				digitalContactMethods.add(method)
			}
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
		digitalDeliveryContactMethods: Array.from(digitalContactMethods),
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

// --- SELLER-CONTROLLED CONTACT METHODS ---
//
// A seller enables, per digital product, which secure contact/messaging methods
// they offer (from the known channels above, plus any free-text custom entry).
// The buyer then picks their contact from that seller-enabled set at checkout.

/**
 * Fallback method set for older digital products that never had a seller set
 * (nothing persisted). Keeps checkout working: the buyer sees the full default
 * channel list instead of an empty picker.
 */
export const DEFAULT_DELIVERY_CONTACT_METHODS: string[] = [...DELIVERY_CONTACT_TYPES]

/**
 * Normalizes a raw seller-enabled method list: trims, drops empties, and
 * de-duplicates while preserving order. Custom (free-text) entries are kept
 * as-is alongside the known channel ids.
 */
export function normalizeDeliveryContactMethods(methods: readonly string[] | null | undefined): string[] {
	if (!methods) return []
	const seen = new Set<string>()
	const result: string[] = []
	for (const raw of methods) {
		const trimmed = typeof raw === 'string' ? raw.trim() : ''
		if (!trimmed || seen.has(trimmed)) continue
		seen.add(trimmed)
		result.push(trimmed)
	}
	return result
}

export type ResolvedDeliveryContactOption = {
	value: string
	label: string
	fieldLabel: string
	placeholder: string
	isCustom: boolean
}

/**
 * Resolves a method id (a known channel like 'signal', or a seller's custom
 * free-text entry) into display + input metadata for the buyer's picker.
 */
export function resolveDeliveryContactOption(method: string): ResolvedDeliveryContactOption {
	if (isDeliveryContactType(method)) {
		const channel = DELIVERY_CONTACT_CHANNELS[method]
		return { ...channel, isCustom: false }
	}
	const label = method.trim() || 'Contact'
	return {
		value: method,
		label,
		fieldLabel: `${label} contact`,
		placeholder: `Your ${label} contact`,
		isCustom: true,
	}
}

/**
 * Buyer picker options for a seller-enabled set. Falls back to the full default
 * channel list when the set is empty (older products with nothing persisted).
 */
export function getDeliveryContactOptions(allowedMethods: readonly string[] | null | undefined): ResolvedDeliveryContactOption[] {
	const normalized = normalizeDeliveryContactMethods(allowedMethods)
	const source = normalized.length > 0 ? normalized : DEFAULT_DELIVERY_CONTACT_METHODS
	return source.map(resolveDeliveryContactOption)
}

/**
 * Custom-aware validation. Known channels reuse {@link isValidDeliveryContact}
 * (email strict, messengers loose); custom free-text methods validate loosely
 * (single token, reasonable length) since they have no canonical format.
 */
export function isValidResolvedDeliveryContact(method: string | null | undefined, value: string | null | undefined): boolean {
	if (isDeliveryContactType(method)) return isValidDeliveryContact(method, value)

	const trimmed = value?.trim()
	if (!trimmed) return false
	if (/\s/.test(trimmed)) return false
	return trimmed.length >= 3 && trimmed.length <= 2000
}
