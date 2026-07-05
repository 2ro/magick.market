import type { NostrEvent } from '@nostr-dev-kit/ndk'
import { verifyEvent, type Event } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { RegistryManager, type RegistryEntry } from './RegistryManager'
import type { EventSigner } from './EventSigner'
import { grinToNanogrin } from '@/lib/grin'
import { buildNameOrderRef, decideNameGrant, type GoblinPayInvoiceView } from './nameGrant'
import type { CreatedNameInvoice } from './goblinPayServer'

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

export interface Nip05Entry extends RegistryEntry {
	username: string
	/** The GoblinPay invoice consumed to grant this entry (reuse guard). */
	invoiceId?: string
}

export class Nip05ManagerImpl extends RegistryManager<Nip05Entry> {
	private pubkeyToUsername: Map<string, string> = new Map() // Reverse lookup

	// Dedup set for processed Grin payment-claim events.
	private processedGrinClaims: Set<string> = new Set()

	// GoblinPay invoice ids already spent on a grant. Rebuilt from the registry
	// on load so reuse is rejected across restarts.
	private consumedInvoiceIds: Set<string> = new Set()

	constructor(eventSigner: EventSigner) {
		super(
			{
				registryEventKind: 30000,
				registryDTag: 'nip05-names',
			},
			eventSigner,
		)
	}

	// --- RegistryManager abstract implementations ---

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
					invoiceId: tag[4] || undefined,
				},
			}))
	}

	protected buildRegistryTags(entries: Map<string, Nip05Entry>): string[][] {
		return Array.from(entries.values()).map((entry) => [
			'nip05',
			entry.username,
			entry.pubkey,
			entry.validUntil.toString(),
			...(entry.invoiceId ? [entry.invoiceId] : []),
		])
	}

	protected createEntry(key: string, pubkey: string, validUntil: number): Nip05Entry {
		return { username: key, pubkey, validUntil }
	}

	protected onEntryRegistered(key: string, entry: Nip05Entry): void {
		this.pubkeyToUsername.set(entry.pubkey, key)
		if (entry.invoiceId) this.consumedInvoiceIds.add(entry.invoiceId)
	}

	protected onRegistryRebuilt(): void {
		this.pubkeyToUsername.clear()
		this.consumedInvoiceIds.clear()
		for (const [key, entry] of Array.from(this.registry.entries())) {
			this.pubkeyToUsername.set(entry.pubkey, key)
			if (entry.invoiceId) this.consumedInvoiceIds.add(entry.invoiceId)
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

	public async loadExistingNip05Registry(appPubkey: string): Promise<boolean> {
		return this.loadExistingRegistry(appPubkey)
	}

	/**
	 * Create a REAL GoblinPay invoice for a NIP-05 name purchase.
	 *
	 * Validates the name is available and the tier exists, then mints an invoice
	 * whose funds land in the marketplace till wallet. The `order_ref` binds the
	 * invoice to `nip05:<name>:<buyerPubkey>` so only that name+buyer can later
	 * consume it. Returns the invoice id and hosted pay URL for the client to
	 * deep-link into the wallet and poll.
	 */
	public async createPurchaseInvoice(
		params: { name: string; tierKey: string; buyerPubkey: string },
		createInvoiceFn: (p: { amountNanogrin: number; orderRef: string; memo: string }) => Promise<CreatedNameInvoice>,
	): Promise<{ ok: true; invoiceId: string; payUrl: string } | { ok: false; error: string; status: number }> {
		const name = params.name?.toLowerCase()
		const tier = NIP05_PRICING[params.tierKey]
		if (!tier) {
			return { ok: false, error: 'Unknown pricing tier', status: 400 }
		}
		if (!name || !this.isUsernameAvailable(name)) {
			return { ok: false, error: `NIP-05 username unavailable: ${name}`, status: 400 }
		}
		const existing = this.registry.get(name)
		if (existing && existing.pubkey !== params.buyerPubkey && existing.validUntil > Math.floor(Date.now() / 1000)) {
			return { ok: false, error: `NIP-05 username already taken: ${name}`, status: 400 }
		}
		try {
			const invoice = await createInvoiceFn({
				amountNanogrin: tier.nanogrin,
				orderRef: buildNameOrderRef('nip05', name, params.buyerPubkey),
				memo: `magick.market NIP-05 name ${name} (${tier.label})`,
			})
			return { ok: true, invoiceId: invoice.invoiceId, payUrl: invoice.payUrl }
		} catch (error) {
			console.error('[nip05] GoblinPay invoice creation failed:', error)
			return { ok: false, error: 'Could not create a payment invoice', status: 502 }
		}
	}

	/**
	 * Verify a buyer-signed claim (kind 17) against a CONFIRMED GoblinPay invoice
	 * and register the NIP-05 username it pays for.
	 *
	 * The kind-17 event is the buyer's pubkey-ownership authorization: its
	 * signature proves `event.pubkey` (the registrant) controls the key, and it
	 * carries `['invoice', invoiceId]`. Payment trust comes entirely from
	 * GoblinPay: we fetch the invoice, require `status === "confirmed"` (10
	 * on-chain confirmations), require its `order_ref` to equal
	 * `nip05:<name>:<event.pubkey>`, and require the paid amount to clear a tier.
	 * The consumed invoice id is persisted on the entry and rejected on reuse.
	 * If GoblinPay is unreachable the grant fails closed.
	 */
	public async handleGrinPurchase(
		event: Event,
		fetchInvoice: (invoiceId: string) => Promise<GoblinPayInvoiceView | null>,
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

		const invoiceId = event.tags.find((t) => t[0] === 'invoice')?.[1]
		if (!invoiceId) {
			return { ok: false, error: 'Receipt missing invoice tag', status: 400 }
		}

		const requesterPubkey = event.pubkey
		const validationError = this.validateRegistration(username, requesterPubkey)
		if (validationError) {
			return { ok: false, error: validationError, status: 400 }
		}

		const invoice = await fetchInvoice(invoiceId)
		const decision = decideNameGrant({
			invoice,
			invoiceId,
			claimedName: username,
			buyerPubkey: requesterPubkey,
			orderRefPrefix: 'nip05',
			matchTier: matchNip05PricingTier,
			isConsumed: (id) => this.consumedInvoiceIds.has(id),
		})
		if (!decision.ok) {
			return decision
		}

		this.processedGrinClaims.add(event.id)
		if (this.processedGrinClaims.size > 2000) {
			this.processedGrinClaims.clear()
			this.processedGrinClaims.add(event.id)
		}

		const now = Math.floor(Date.now() / 1000)
		let validUntil = now + decision.validitySeconds
		const existing = this.registry.get(username)
		if (existing && existing.pubkey === requesterPubkey && existing.validUntil > now) {
			validUntil = existing.validUntil + decision.validitySeconds
		}

		const entry = this.createEntry(username, requesterPubkey, validUntil)
		entry.invoiceId = invoiceId
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
