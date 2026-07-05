import NDK, { NDKEvent } from '@nostr-dev-kit/ndk'
import type { NostrEvent } from '@nostr-dev-kit/ndk'
import type { EventSigner } from './EventSigner'

export interface RegistryEntry {
	pubkey: string
	validUntil: number
}

export interface RegistryConfig {
	registryEventKind: number
	registryDTag: string
}

/**
 * Base class for magick.market's GRIN-paid name registries (NIP-05 usernames,
 * vanity URLs). It holds the shared in-memory registry mechanics: rebuilding
 * state from a Nostr registry event, loading it from the relay on startup, and
 * publishing the signed registry back to the relay.
 *
 * magick.market is GRIN-only: there is no Lightning/zap purchase path here.
 * Purchase verification is done per-subclass in handleGrinPurchase (kind 17
 * Grin payment receipts).
 */
export abstract class RegistryManager<TEntry extends RegistryEntry> {
	protected registry: Map<string, TEntry> = new Map()
	protected eventSigner: EventSigner
	protected ndk: NDK | null = null
	protected appPubkey: string = ''
	public readonly config: RegistryConfig

	constructor(config: RegistryConfig, eventSigner: EventSigner) {
		this.config = config
		this.eventSigner = eventSigner
	}

	// --- Abstract methods implemented in subclasses ---
	protected abstract validateRegistration(key: string, pubkey: string): string | null
	protected abstract extractEntriesFromEvent(event: NostrEvent): Array<{ key: string; entry: TEntry }>
	protected abstract buildRegistryTags(entries: Map<string, TEntry>): string[][]
	protected abstract createEntry(key: string, pubkey: string, validUntil: number): TEntry

	// --- Optional hooks (override in subclass) ---
	protected onEntryRegistered?(key: string, entry: TEntry): void
	protected onRegistryRebuilt?(): void

	public setNDK(ndk: NDK): void {
		this.ndk = ndk
	}

	public setAppPubkey(pubkey: string): void {
		this.appPubkey = pubkey
	}

	// Handle a registry event (rebuild in-memory state from a Nostr event).
	// Called when a registry (kind 30000) event is received.
	public async handleRegistryEvent(event: NostrEvent): Promise<void> {
		console.log(`[${this.config.registryDTag}] Processing registry event: ${event.id}`)

		const entries = this.extractEntriesFromEvent(event)

		this.registry.clear()
		const now = Math.floor(Date.now() / 1000)

		for (const { key, entry } of entries) {
			if (entry.validUntil >= now) {
				this.registry.set(key, entry)
			}
		}

		this.onRegistryRebuilt?.()
		console.log(`[${this.config.registryDTag}] Registry updated: ${this.registry.size} active entries`)
	}

	// Load existing registry state from the relay on startup.
	//
	// Returns true when the relay was reached and the fetch completed (including
	// the "no existing registry" case — that is a successful empty read), and
	// false when it could not load (no NDK, or the fetch threw). The boot
	// bootstrap uses this to decide whether to retry: a false result means the
	// connection was not actually usable yet and the load should be reattempted.
	//
	// A failed fetch throws before reaching handleRegistryEvent, so it never
	// clears an already-populated in-memory registry.
	public async loadExistingRegistry(appPubkey: string): Promise<boolean> {
		if (!this.ndk) {
			console.warn(`[${this.config.registryDTag}] NDK not available, cannot load existing registry`)
			return false
		}

		this.appPubkey = appPubkey

		try {
			const events = await this.ndk.fetchEvents({
				kinds: [this.config.registryEventKind],
				authors: [appPubkey],
				'#d': [this.config.registryDTag],
				limit: 1,
			})

			if (events.size > 0) {
				const latestEvent = Array.from(events)[0]
				await this.handleRegistryEvent(latestEvent.rawEvent())
				console.log(`[${this.config.registryDTag}] Loaded existing registry`)
			} else {
				console.log(`[${this.config.registryDTag}] No existing registry found`)
			}
			return true
		} catch (error) {
			console.error(`[${this.config.registryDTag}] Error loading existing registry:`, error)
			return false
		}
	}

	// Get all active (non-expired) entries.
	public getAllEntries(): TEntry[] {
		const now = Math.floor(Date.now() / 1000)
		return Array.from(this.registry.values()).filter((e) => e.validUntil > now)
	}

	// Get an entry by registry key, or null if not found or expired.
	public getEntry(key: string): TEntry | null {
		const entry = this.registry.get(key)
		if (!entry) return null
		if (entry.validUntil < Math.floor(Date.now() / 1000)) return null
		return entry
	}

	// Publish the current registry as a signed Nostr event to connected relays.
	protected async publishRegistry(): Promise<void> {
		if (!this.ndk) {
			console.error(`[${this.config.registryDTag}] NDK not available, cannot publish registry`)
			return
		}

		const event = new NDKEvent(this.ndk)
		event.kind = this.config.registryEventKind
		event.content = ''
		event.created_at = Math.floor(Date.now() / 1000)

		const tags: string[][] = [['d', this.config.registryDTag]]
		tags.push(...this.buildRegistryTags(this.registry))
		event.tags = tags

		try {
			const signedEvent = this.eventSigner.signEvent(event.rawEvent())
			if (signedEvent) {
				const ndkEvent = new NDKEvent(this.ndk, signedEvent)
				await ndkEvent.publish()
				console.log(`[${this.config.registryDTag}] Registry published: ${signedEvent.id}`)
			}
		} catch (error) {
			console.error(`[${this.config.registryDTag}] Failed to publish registry:`, error)
		}
	}
}
