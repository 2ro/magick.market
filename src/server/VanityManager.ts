import type { NostrEvent } from '@nostr-dev-kit/ndk'
import { verifyEvent, type Event } from 'nostr-tools/pure'
import { RegistryManager, type RegistryEntry } from './RegistryManager'
import type { EventSigner } from './EventSigner'
import { NIP05_GRIN_RECIPIENT_NPUB, NIP05_GRIN_RECIPIENT_PUBKEY } from './Nip05Manager'
import { grinToNanogrin, nanogrinToGrin } from '@/lib/grin'

// Reserved vanity names that cannot be registered
const RESERVED_NAMES = new Set([
	'admin',
	'api',
	'dashboard',
	'products',
	'product',
	'profile',
	'checkout',
	'setup',
	'community',
	'posts',
	'post',
	'nostr',
	'search',
	'collection',
	'collections',
	'settings',
	'support',
	'help',
	'about',
	'terms',
	'privacy',
	'login',
	'logout',
	'register',
	'signup',
	'signin',
	'account',
	'user',
	'users',
	'app',
	'static',
	'assets',
	'images',
	'public',
	'favicon',
	'robots',
	'sitemap',
])

export interface VanityGrinTier {
	/** Price in integer nanogrin. */
	nanogrin: number
	days: number
	seconds?: number
	label: string
}

// Pricing tiers: amount in GRIN -> validity in days (or seconds for dev).
// Same amounts as NIP05_PRICING: both are platform name fees (the old sats
// pricing was identical between the two as well).
export const VANITY_PRICING: Record<string, VanityGrinTier> = {
	...(process.env.NODE_ENV === 'development'
		? {
				dev: { nanogrin: grinToNanogrin(1), days: 0, seconds: 90, label: '90 Seconds (Dev)' },
			}
		: {}),
	'6mo': { nanogrin: grinToNanogrin(500), days: 180, label: '6 Months' },
	'1yr': { nanogrin: grinToNanogrin(800), days: 365, label: '1 Year' },
}

/**
 * Match a Grin payment amount to the best (highest) qualifying pricing tier.
 * Returns validity in seconds, or null if no tier matches.
 */
export function matchVanityPricingTier(amountNanogrin: number): number | null {
	const entries = Object.entries(VANITY_PRICING).sort(([, a], [, b]) => b.nanogrin - a.nanogrin)
	for (const [, tier] of entries) {
		if (amountNanogrin >= tier.nanogrin) {
			return tier.seconds !== undefined ? tier.seconds : tier.days * 24 * 60 * 60
		}
	}
	return null
}

// Vanity URLs are a platform fee paid to the same instance-owner identity as
// NIP-05 names (see Nip05Manager for the canonical constants).
export const VANITY_GRIN_RECIPIENT_NPUB = NIP05_GRIN_RECIPIENT_NPUB
export const VANITY_GRIN_RECIPIENT_PUBKEY = NIP05_GRIN_RECIPIENT_PUBKEY

export interface VanityEntry extends RegistryEntry {
	vanityName: string
}

export class VanityManagerImpl extends RegistryManager<VanityEntry> {
	private pubkeyToVanity: Map<string, string> = new Map() // Reverse lookup

	// Dedup set for processed Grin payment-claim events.
	private processedGrinClaims: Set<string> = new Set()

	constructor(eventSigner: EventSigner) {
		super(
			{
				registryEventKind: 30000,
				registryDTag: 'vanity-urls',
			},
			eventSigner,
		)
	}

	// --- RegistryManager abstract implementations ---

	protected validateRegistration(key: string, pubkey: string): string | null {
		if (!this.isValidVanityName(key)) {
			return `Invalid vanity name: ${key}`
		}
		if (this.isReservedName(key)) {
			return `Reserved vanity name: ${key}`
		}
		const existing = this.registry.get(key)
		if (existing && existing.pubkey !== pubkey && existing.validUntil > Math.floor(Date.now() / 1000)) {
			return `Vanity name already taken: ${key}`
		}
		return null
	}

	protected extractEntriesFromEvent(event: NostrEvent): Array<{ key: string; entry: VanityEntry }> {
		return event.tags
			.filter((tag) => tag[0] === 'vanity' && tag[1] && tag[2] && tag[3])
			.map((tag) => ({
				key: tag[1].toLowerCase(),
				entry: {
					vanityName: tag[1].toLowerCase(),
					pubkey: tag[2],
					validUntil: parseInt(tag[3]) || 0,
				},
			}))
	}

	protected buildRegistryTags(entries: Map<string, VanityEntry>): string[][] {
		return Array.from(entries.values()).map((entry) => ['vanity', entry.vanityName, entry.pubkey, entry.validUntil.toString()])
	}

	protected createEntry(key: string, pubkey: string, validUntil: number): VanityEntry {
		return { vanityName: key, pubkey, validUntil }
	}

	// --- Optional hooks ---

	protected onEntryRegistered(key: string, entry: VanityEntry): void {
		this.pubkeyToVanity.set(entry.pubkey, key)
	}

	protected onRegistryRebuilt(): void {
		this.pubkeyToVanity.clear()
		for (const [key, entry] of Array.from(this.registry.entries())) {
			this.pubkeyToVanity.set(entry.pubkey, key)
		}
	}

	// --- Vanity-specific public API ---

	/**
	 * Handle vanity registry event (kind 30000 with d=vanity-urls).
	 * Convenience wrapper over base class handleRegistryEvent.
	 */
	public async handleVanityEvent(event: NostrEvent): Promise<void> {
		return this.handleRegistryEvent(event)
	}

	public resolveVanity(vanityName: string): VanityEntry | null {
		return this.getEntry(vanityName.toLowerCase())
	}

	public isVanityAvailable(vanityName: string): boolean {
		if (this.isReservedName(vanityName)) return false
		if (!this.isValidVanityName(vanityName)) return false

		const entry = this.registry.get(vanityName.toLowerCase())
		if (!entry) return true

		// Available if expired
		return entry.validUntil < Math.floor(Date.now() / 1000)
	}

	public isReservedName(vanityName: string): boolean {
		return RESERVED_NAMES.has(vanityName.toLowerCase())
	}

	public getVanityForPubkey(pubkey: string): VanityEntry | null {
		const vanityName = this.pubkeyToVanity.get(pubkey)
		if (!vanityName) return null
		return this.resolveVanity(vanityName)
	}

	public getAllVanityEntries(): VanityEntry[] {
		return this.getAllEntries()
	}

	/**
	 * Load existing vanity registry from relay.
	 * Convenience wrapper over base class loadExistingRegistry.
	 */
	public async loadExistingVanityRegistry(appPubkey: string): Promise<void> {
		return this.loadExistingRegistry(appPubkey)
	}

	/**
	 * Verify a buyer-signed Grin payment receipt (kind 17) and register the
	 * vanity URL it pays for. Same shape and trust model as
	 * Nip05ManagerImpl.handleGrinPurchase: the receipt is signed by the buyer's
	 * own logged-in Nostr key, so `event.pubkey` is the verified registrant.
	 */
	public async handleGrinPurchase(
		event: Event,
	): Promise<{ ok: true; vanityName: string; validUntil: number } | { ok: false; error: string; status: number }> {
		if (event?.kind !== 17) {
			return { ok: false, error: 'Not a payment receipt (kind 17)', status: 400 }
		}
		if (!event.id || this.processedGrinClaims.has(event.id)) {
			return { ok: false, error: 'Receipt already processed', status: 409 }
		}
		if (!verifyEvent(event)) {
			return { ok: false, error: 'Invalid event signature', status: 400 }
		}

		const recipientTag = event.tags.find((t) => t[0] === 'p')?.[1]
		if (recipientTag !== VANITY_GRIN_RECIPIENT_PUBKEY) {
			return { ok: false, error: 'Receipt is not addressed to the vanity URL payment recipient', status: 400 }
		}

		const vanityName = event.tags.find((t) => t[0] === 'vanity')?.[1]?.toLowerCase()
		if (!vanityName) {
			return { ok: false, error: 'Receipt missing vanity tag', status: 400 }
		}

		const amountTag = event.tags.find((t) => t[0] === 'amount')?.[1]
		const amountNanogrin = amountTag ? parseInt(amountTag, 10) : NaN
		if (!Number.isFinite(amountNanogrin) || amountNanogrin <= 0) {
			return { ok: false, error: 'Receipt missing a valid amount tag', status: 400 }
		}

		const requesterPubkey = event.pubkey
		const validationError = this.validateRegistration(vanityName, requesterPubkey)
		if (validationError) {
			return { ok: false, error: validationError, status: 400 }
		}

		const validitySeconds = matchVanityPricingTier(amountNanogrin)
		if (validitySeconds === null) {
			return { ok: false, error: `Insufficient payment: ${nanogrinToGrin(amountNanogrin)} GRIN`, status: 400 }
		}

		this.processedGrinClaims.add(event.id)
		if (this.processedGrinClaims.size > 2000) {
			this.processedGrinClaims.clear()
			this.processedGrinClaims.add(event.id)
		}

		const now = Math.floor(Date.now() / 1000)
		let validUntil = now + validitySeconds
		const existing = this.registry.get(vanityName)
		if (existing && existing.pubkey === requesterPubkey && existing.validUntil > now) {
			validUntil = existing.validUntil + validitySeconds
		}

		const entry = this.createEntry(vanityName, requesterPubkey, validUntil)
		this.registry.set(vanityName, entry)
		this.onEntryRegistered?.(vanityName, entry)
		await this.publishRegistry()

		return { ok: true, vanityName, validUntil }
	}

	private isValidVanityName(name: string): boolean {
		// Allow alphanumeric, hyphens, underscores, 3-30 characters
		const regex = /^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$/
		return regex.test(name.toLowerCase())
	}
}
