import type { NostrEvent } from '@nostr-dev-kit/ndk'
import { verifyEvent, type Event } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { ZapPurchaseManager, type ZapPurchaseEntry } from './ZapPurchaseManager'
import type { EventSigner } from './EventSigner'
import { grinToNanogrin, nanogrinToGrin } from '@/lib/grin'

// Reserved NIP-05 names that cannot be registered
const RESERVED_NAMES = new Set([
	'admin',
	'_',
	'root',
	'postmaster',
	'webmaster',
	'hostmaster',
	'abuse',
	'noc',
	'security',
	'info',
	'support',
	'help',
	'noreply',
	'no-reply',
	'app',
	'system',
	'api',
	'bot',
])

export interface Nip05GrinTier {
	/** Price in integer nanogrin. */
	nanogrin: number
	days: number
	seconds?: number
	label: string
}

// Pricing tiers: amount in GRIN -> validity in days (or seconds for dev)
export const NIP05_PRICING: Record<string, Nip05GrinTier> = {
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
export function matchNip05PricingTier(amountNanogrin: number): number | null {
	const entries = Object.entries(NIP05_PRICING).sort(([, a], [, b]) => b.nanogrin - a.nanogrin)
	for (const [, tier] of entries) {
		if (amountNanogrin >= tier.nanogrin) {
			return tier.seconds !== undefined ? tier.seconds : tier.days * 24 * 60 * 60
		}
	}
	return null
}

// Platform recipient for NIP-05 purchases (the instance owner's own Goblin
// wallet identity) — this is a fee for a magick.market service, not seller
// revenue, so it goes to the same identity that owns/administers the instance.
export const NIP05_GRIN_RECIPIENT_NPUB = 'npub1k3gqphpwdu7hk6ypglmpr4578vntq7hw2plrgdgmt7nhdkmyml2saq5dqw'
const decodedRecipient = nip19.decode(NIP05_GRIN_RECIPIENT_NPUB)
if (decodedRecipient.type !== 'npub') {
	throw new Error('NIP05_GRIN_RECIPIENT_NPUB must decode to an npub')
}
export const NIP05_GRIN_RECIPIENT_PUBKEY: string = decodedRecipient.data

export interface Nip05Entry extends ZapPurchaseEntry {
	username: string
}

export class Nip05ManagerImpl extends ZapPurchaseManager<Nip05Entry> {
	private pubkeyToUsername: Map<string, string> = new Map() // Reverse lookup

	// Dedup set for processed Grin payment-claim events, mirroring the base
	// class's zap-receipt dedup (see ZapPurchaseManager.processedReceipts).
	private processedGrinClaims: Set<string> = new Set()

	constructor(eventSigner: EventSigner) {
		super(
			{
				zapLabel: 'nip05-register',
				registryEventKind: 30000,
				registryDTag: 'nip05-names',
				// magick.market is GRIN-only: the base class's sats/zap-request
				// pricing and invoice flow (generateInvoice/handleZapReceipt) are
				// unused here. Grin purchases are verified in handleGrinPurchase
				// below, against NIP05_PRICING (nanogrin) instead.
				pricing: {},
			},
			eventSigner,
		)
	}

	// --- ZapPurchaseManager abstract implementations ---

	protected extractRegistryKey(zapRequest: NostrEvent): string | null {
		const tag = zapRequest.tags.find((t) => t[0] === 'nip05')
		return tag?.[1]?.toLowerCase() ?? null
	}

	protected validateRegistration(key: string, pubkey: string): string | null {
		if (!this.isValidUsername(key)) {
			return `Invalid NIP-05 username: ${key}`
		}
		if (this.isReservedName(key)) {
			return `Reserved NIP-05 username: ${key}`
		}
		const existing = this.registry.get(key)
		if (existing && existing.pubkey !== pubkey && existing.validUntil > Math.floor(Date.now() / 1000)) {
			return `NIP-05 username already taken: ${key}`
		}
		return null
	}

	protected extractEntriesFromEvent(event: NostrEvent): Array<{ key: string; entry: Nip05Entry }> {
		return event.tags
			.filter((tag) => tag[0] === 'nip05' && tag[1] && tag[2] && tag[3])
			.map((tag) => ({
				key: tag[1].toLowerCase(),
				entry: {
					username: tag[1].toLowerCase(),
					pubkey: tag[2],
					validUntil: parseInt(tag[3]) || 0,
				},
			}))
	}

	protected buildRegistryTags(entries: Map<string, Nip05Entry>): string[][] {
		return Array.from(entries.values()).map((entry) => ['nip05', entry.username, entry.pubkey, entry.validUntil.toString()])
	}

	protected createEntry(key: string, pubkey: string, validUntil: number): Nip05Entry {
		return { username: key, pubkey, validUntil }
	}

	protected getInvoiceComment(registryKey: string): string {
		return `NIP-05 Address: ${registryKey}`
	}

	protected onEntryRegistered(key: string, entry: Nip05Entry): void {
		this.pubkeyToUsername.set(entry.pubkey, key)
	}

	protected onRegistryRebuilt(): void {
		this.pubkeyToUsername.clear()
		for (const [key, entry] of Array.from(this.registry.entries())) {
			this.pubkeyToUsername.set(entry.pubkey, key)
		}
	}

	// --- NIP-05-specific public API ---

	/**
	 * Build the NIP-05 nostr.json response from active entries.
	 * Returns { names: { username: pubkey } } for all active registrations.
	 */
	public buildNostrJson(requestedName?: string): { names: Record<string, string> } {
		const now = Math.floor(Date.now() / 1000)
		const names: Record<string, string> = {}

		if (requestedName) {
			const entry = this.registry.get(requestedName.toLowerCase())
			if (entry && entry.validUntil > now) {
				names[entry.username] = entry.pubkey
			}
		} else {
			for (const [, entry] of Array.from(this.registry.entries())) {
				if (entry.validUntil > now) {
					names[entry.username] = entry.pubkey
				}
			}
		}

		return { names }
	}

	public resolveUsername(username: string): Nip05Entry | null {
		return this.getEntry(username.toLowerCase())
	}

	public isUsernameAvailable(username: string): boolean {
		if (this.isReservedName(username)) return false
		if (!this.isValidUsername(username)) return false

		const entry = this.registry.get(username.toLowerCase())
		if (!entry) return true

		// Available if expired
		return entry.validUntil < Math.floor(Date.now() / 1000)
	}

	public isReservedName(username: string): boolean {
		return RESERVED_NAMES.has(username.toLowerCase())
	}

	public getUsernameForPubkey(pubkey: string): Nip05Entry | null {
		const username = this.pubkeyToUsername.get(pubkey)
		if (!username) return null
		return this.resolveUsername(username)
	}

	public getAllNip05Entries(): Nip05Entry[] {
		return this.getAllEntries()
	}

	public async loadExistingNip05Registry(appPubkey: string): Promise<void> {
		return this.loadExistingRegistry(appPubkey)
	}

	/**
	 * Verify a buyer-signed Grin payment receipt (kind 17) and register the
	 * NIP-05 username it pays for.
	 *
	 * The receipt is signed by the buyer's own Nostr key (their real, logged-in
	 * identity — not a seller's or the platform's), published client-side
	 * either after the buyer pastes the receiver-signed Grin payment proof
	 * Goblin shows them, mirroring the checkout "proof-import" path in
	 * publishPaymentReceipt (src/publish/payment.tsx). Trust comes entirely
	 * from the Nostr signature: `event.pubkey` is the verified registrant, so
	 * there is nothing else for the caller to authenticate.
	 */
	public async handleGrinPurchase(
		event: Event,
	): Promise<{ ok: true; username: string; validUntil: number } | { ok: false; error: string; status: number }> {
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
		if (recipientTag !== NIP05_GRIN_RECIPIENT_PUBKEY) {
			return { ok: false, error: 'Receipt is not addressed to the NIP-05 payment recipient', status: 400 }
		}

		const username = event.tags.find((t) => t[0] === 'nip05')?.[1]?.toLowerCase()
		if (!username) {
			return { ok: false, error: 'Receipt missing nip05 tag', status: 400 }
		}

		const amountTag = event.tags.find((t) => t[0] === 'amount')?.[1]
		const amountNanogrin = amountTag ? parseInt(amountTag, 10) : NaN
		if (!Number.isFinite(amountNanogrin) || amountNanogrin <= 0) {
			return { ok: false, error: 'Receipt missing a valid amount tag', status: 400 }
		}

		const requesterPubkey = event.pubkey
		const validationError = this.validateRegistration(username, requesterPubkey)
		if (validationError) {
			return { ok: false, error: validationError, status: 400 }
		}

		const validitySeconds = matchNip05PricingTier(amountNanogrin)
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
		const existing = this.registry.get(username)
		if (existing && existing.pubkey === requesterPubkey && existing.validUntil > now) {
			validUntil = existing.validUntil + validitySeconds
		}

		const entry = this.createEntry(username, requesterPubkey, validUntil)
		this.registry.set(username, entry)
		this.onEntryRegistered?.(username, entry)
		await this.publishRegistry()

		return { ok: true, username, validUntil }
	}

	private isValidUsername(name: string): boolean {
		// Allow alphanumeric, hyphens, underscores, dots, 1-30 characters
		const regex = /^[a-z0-9][a-z0-9._-]{0,28}[a-z0-9]$|^[a-z0-9]$/
		return regex.test(name.toLowerCase())
	}
}
