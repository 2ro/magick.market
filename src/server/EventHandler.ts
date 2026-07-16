import type { NostrEvent } from '@nostr-dev-kit/ndk'
import type { EventHandlerConfig, ProcessedEvent } from './types'
import { AdminManagerImpl } from './AdminManager'
import { EditorManagerImpl } from './EditorManager'
import { BootstrapManagerImpl } from './BootstrapManager'
import { BlacklistManagerImpl } from './BlacklistManager'
import { VanityManagerImpl } from './VanityManager'
import { Nip05ManagerImpl } from './Nip05Manager'
import { EventValidator } from './EventValidator'
import { EventSigner } from './EventSigner'
import { NDKService } from './NDKService'
import NDK from '@nostr-dev-kit/ndk'
import type { RegistryManager, RegistryEntry } from './RegistryManager'
import { planNdkBootstrap, nextRetryDelayMs, deriveConnectSucceeded } from './ndkBootstrap'

export class EventHandler {
	private static instance: EventHandler
	private isInitialized: boolean = false

	// Core components
	private adminManager: AdminManagerImpl
	private editorManager: EditorManagerImpl
	private bootstrapManager: BootstrapManagerImpl
	private blacklistManager: BlacklistManagerImpl
	private vanityManager: VanityManagerImpl
	private nip05Manager: Nip05ManagerImpl
	private eventValidator: EventValidator
	private eventSigner: EventSigner
	private ndkService: NDKService
	private ndk: NDK | null = null

	// Registered GRIN name registries (vanity URLs, nip05)
	private nameManagers: RegistryManager<RegistryEntry>[] = []

	private constructor() {
		// Initialize with empty managers - components requiring private key will be set up during initialize()
		this.adminManager = new AdminManagerImpl()
		this.editorManager = new EditorManagerImpl()
		this.bootstrapManager = new BootstrapManagerImpl(this.adminManager)
		// These will be properly initialized in the initialize() method
		this.eventValidator = null as any
		this.eventSigner = null as any
		this.ndkService = null as any
		this.blacklistManager = null as any
		this.vanityManager = null as any
		this.nip05Manager = null as any
	}

	public static getInstance(): EventHandler {
		if (!EventHandler.instance) {
			EventHandler.instance = new EventHandler()
		}
		return EventHandler.instance
	}

	public async initialize(config: EventHandlerConfig): Promise<void> {
		if (this.isInitialized) {
			throw new Error('EventHandler is already initialized')
		}

		// Initialize core components
		this.adminManager = new AdminManagerImpl(config.adminPubkeys)
		this.editorManager = new EditorManagerImpl()
		this.bootstrapManager = new BootstrapManagerImpl(this.adminManager, config.adminPubkeys.length)
		this.eventSigner = new EventSigner(config.appPrivateKey)
		this.eventValidator = new EventValidator(config.appPrivateKey, this.adminManager, this.editorManager, this.bootstrapManager)
		this.ndkService = new NDKService(this.eventSigner.getAppPubkey(), this.adminManager, this.editorManager, this.bootstrapManager)
		this.blacklistManager = new BlacklistManagerImpl(this.eventSigner, this.ndkService)
		this.vanityManager = new VanityManagerImpl(this.eventSigner)
		this.nip05Manager = new Nip05ManagerImpl(this.eventSigner)

		// Register all GRIN name registries
		this.nameManagers = [this.vanityManager, this.nip05Manager]

		// Initialize NDK service and load existing data with timeout
		try {
			await Promise.race([
				this.ndkService.initialize(config.relayUrl),
				new Promise((_, reject) => setTimeout(() => reject(new Error('NDK service init timeout')), 10000)),
			])
		} catch (e) {
			console.warn('⚠️ NDK service init failed, continuing anyway:', e)
		}

		try {
			await Promise.race([
				this.ndkService.loadExistingData(),
				new Promise((_, reject) => setTimeout(() => reject(new Error('Load existing data timeout')), 10000)),
			])
		} catch (e) {
			console.warn('⚠️ Load existing data failed, continuing anyway:', e)
		}

		// SECURITY: close bootstrap mode once admins have been restored from the
		// relay. loadExistingData repopulates adminManager from the persisted setup
		// event / admin list, but the bootstrap flag was fixed at construction from
		// the (always-empty) config admin list, so without this a restarted-but-
		// already-set-up instance stays in bootstrap mode — accepting setup and
		// admin/editor-list events from ANY anonymous caller (an unauthenticated
		// takeover). Reconcile against the restored admin count so a fresh instance
		// still bootstraps (size 0) but an established one closes on every boot.
		this.bootstrapManager.reconcileFromAdminCount(this.adminManager.size())

		try {
			this.ndkService.startSubscriptions()
		} catch (e) {
			console.warn('⚠️ Starting NDK service subscriptions failed, continuing anyway:', e)
		}

		// Set up NDK for the blacklist and name-registry managers.
		if (config.relayUrl) {
			this.ndk = new NDK({ explicitRelayUrls: [config.relayUrl] })

			// INVARIANT (see planNdkBootstrap / ndkBootstrap.ts): attach the NDK to
			// every manager UNCONDITIONALLY, before and regardless of the connect
			// race. NDK accepts the reference while still connecting and queues
			// publishes until the socket is up. Previously these setNDK calls lived
			// inside the connect try-block, so a flaky ~10s connect timeout left the
			// managers permanently holding ndk = null and name registrations were
			// never published (kind-30000 registry) — lost on restart.
			const attach = planNdkBootstrap({ ndkCreated: true, connectSucceeded: false, loadSucceeded: false })
			if (attach.attachNdk) {
				this.blacklistManager.setNDK(this.ndk)
				this.vanityManager.setNDK(this.ndk)
				this.nip05Manager.setNDK(this.ndk)
			}

			const appPubkey = this.eventSigner.getAppPubkey()

			// Bring the connection up and load existing registries on the happy path.
			// If the first connect races/fails or a load does not complete, keep the
			// (already-attached) NDK and retry the loads in the background so the
			// registries populate once the relay is reachable — never block boot on
			// the flaky connection.
			const outcome = await this.connectAndLoadRegistries(this.ndk, appPubkey)
			const plan = planNdkBootstrap({ ndkCreated: true, ...outcome })
			if (plan.scheduleLoadRetry) {
				void this.retryRegistryLoads(this.ndk, appPubkey)
			}

			// magick.market is GRIN-only: we do NOT connect to Lightning "zap"
			// relays or subscribe to zap receipts. Payments are made in Grin via
			// the Goblin wallet; there is nothing to listen for here.
		}

		this.isInitialized = true
		console.log('EventHandler initialized successfully')
	}

	/**
	 * One connect + registry-load attempt against the app relay. The NDK is
	 * assumed already attached to the managers. Returns whether the connect won
	 * its timeout race and whether the name registries loaded (relay responded).
	 * Errors are swallowed and reported via the returned flags so the caller can
	 * decide whether to retry — a failed load never throws and never wipes an
	 * already-populated registry.
	 */
	private async connectAndLoadRegistries(ndk: NDK, appPubkey: string): Promise<{ connectSucceeded: boolean; loadSucceeded: boolean }> {
		let connectSucceeded = false
		try {
			await Promise.race([
				ndk.connect(),
				new Promise((_, reject) => setTimeout(() => reject(new Error('App relay NDK connect timeout')), 10000)),
			])
			connectSucceeded = true
		} catch (e) {
			console.warn(
				'⚠️ App relay NDK connect raced/timed out; NDK stays attached, loading registries anyway (fetchEvents auto-connects):',
				e,
			)
		}

		// INVARIANT (READ-path sibling of the 2026-07-04 ndkBootstrap WRITE-path
		// race): NEVER gate the registry load on the connect() promise. NDK 3.0.3's
		// pool.connect() can stay unresolved while the relay is actually CONNECTED
		// (connectedRelays().length > 0) and fetchEvents returns the persisted
		// kind-30000 registry event fine. The old early-return here (`if
		// (!connectSucceeded) return`) skipped loadExisting*Registry whenever the
		// promise flaked, so the served /.well-known/nostr.json stayed empty until
		// the next write republished — every name silently vanished on restart.
		// Always attempt the load; loadExistingRegistry only returns false if the
		// fetch itself throws.

		// Blacklist is best-effort and not part of the persistence invariant.
		try {
			await this.blacklistManager.loadExistingBlacklist(appPubkey)
		} catch (e) {
			console.warn('⚠️ Blacklist load failed, continuing anyway:', e)
		}

		const vanityLoaded = await this.vanityManager.loadExistingVanityRegistry(appPubkey)
		const nip05Loaded = await this.nip05Manager.loadExistingNip05Registry(appPubkey)
		const loadSucceeded = vanityLoaded && nip05Loaded

		// Derive connectSucceeded from an actual live socket or a successful fetch
		// when connect()'s promise never resolved, so the background retry loop
		// (planNdkBootstrap.scheduleLoadRetry) stops once the registries are loaded
		// instead of spinning against a relay that is demonstrably reachable.
		const connectedRelayCount = ndk.pool?.connectedRelays()?.length ?? 0
		connectSucceeded = deriveConnectSucceeded(connectSucceeded, loadSucceeded, connectedRelayCount)

		return { connectSucceeded, loadSucceeded }
	}

	/**
	 * Background retry loop for the app-relay registry loads, with capped
	 * exponential backoff. Runs only when the first boot attempt raced/failed.
	 * The NDK is already attached to the managers, so registrations published in
	 * the meantime are not lost; this only backfills the in-memory registries
	 * from the relay once it becomes reachable.
	 */
	private async retryRegistryLoads(ndk: NDK, appPubkey: string): Promise<void> {
		const maxAttempts = 8
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			await new Promise((r) => setTimeout(r, nextRetryDelayMs(attempt)))
			const outcome = await this.connectAndLoadRegistries(ndk, appPubkey)
			const plan = planNdkBootstrap({ ndkCreated: true, ...outcome })
			if (!plan.scheduleLoadRetry) {
				console.log('✅ App relay registries loaded on retry')
				return
			}
			console.warn(`⚠️ App relay registry load retry ${attempt}/${maxAttempts} incomplete; will keep trying`)
		}
		console.warn('⚠️ App relay registry loads did not complete after retries; NDK remains attached so writes still publish')
	}

	public handleEvent(event: NostrEvent): NostrEvent | null {
		if (!this.isInitialized) {
			throw new Error('EventHandler is not initialized')
		}

		const processed = this.processEvent(event)
		return processed.signedEvent
	}

	public processEvent(event: NostrEvent): ProcessedEvent {
		if (!this.isInitialized || !this.eventValidator || !this.eventSigner) {
			throw new Error('EventHandler is not initialized')
		}

		// Validate the event
		const validationResult = this.eventValidator.validateEvent(event)

		if (!validationResult.isValid) {
			console.log(validationResult.reason)
			return {
				originalEvent: event,
				signedEvent: null,
				validationResult,
			}
		}

		// Handle special event types that update internal state
		// Note: handleSpecialEvents is async for blacklist processing, but we don't await to maintain sync API
		this.handleSpecialEvents(event).catch((error) => {
			console.error('Error handling special event:', error)
		})

		// Sign the event
		const signedEvent = this.eventSigner.signEvent(event)

		return {
			originalEvent: event,
			signedEvent,
			validationResult,
		}
	}

	private async handleSpecialEvents(event: NostrEvent): Promise<void> {
		const isSetupEvent = event.kind === 31990 && event.content.includes('"name":')
		const isAdminListEvent = event.kind === 30000 && event.tags.some((tag) => tag[0] === 'd' && tag[1] === 'admins')
		const isEditorListEvent = event.kind === 30000 && event.tags.some((tag) => tag[0] === 'd' && tag[1] === 'editors')
		const isBlacklistEvent = event.kind === 10000

		if (isSetupEvent) {
			this.bootstrapManager.handleSetupEvent(event)
		} else if (isAdminListEvent) {
			console.log('Admin list event accepted, updating internal admin list')
			this.adminManager.updateFromEvent(event)
		} else if (isEditorListEvent) {
			console.log('Editor list event accepted, updating internal editor list')
			this.editorManager.updateFromEvent(event)
		} else if (isBlacklistEvent) {
			console.log('Blacklist event accepted, processing blacklist update')
			await this.blacklistManager.handleBlacklistEvent(event)
		}

		// Route registry events to matching name registries
		for (const manager of this.nameManagers) {
			if (
				event.kind === manager.config.registryEventKind &&
				event.tags.some((tag) => tag[0] === 'd' && tag[1] === manager.config.registryDTag)
			) {
				console.log(`Registry event accepted for [${manager.config.registryDTag}]`)
				await manager.handleRegistryEvent(event)
			}
		}
	}

	// Public API methods
	public addAdmin(pubkey: string): void {
		if (!this.isInitialized) {
			throw new Error('EventHandler is not initialized')
		}
		this.adminManager.addAdmin(pubkey)
	}

	public addEditor(pubkey: string): void {
		if (!this.isInitialized) {
			throw new Error('EventHandler is not initialized')
		}
		this.editorManager.addEditor(pubkey)
	}

	public isAdmin(pubkey: string): boolean {
		return this.adminManager.isAdmin(pubkey)
	}

	public isEditor(pubkey: string): boolean {
		return this.editorManager.isEditor(pubkey)
	}

	public isAdminOrEditor(pubkey: string): boolean {
		return this.isAdmin(pubkey) || this.isEditor(pubkey)
	}

	public isBootstrapMode(): boolean {
		return this.bootstrapManager.isBootstrapMode()
	}

	public isBlacklisted(pubkey: string): boolean {
		if (!this.isInitialized) {
			throw new Error('EventHandler is not initialized')
		}
		return this.blacklistManager.isBlacklisted(pubkey)
	}

	public getBlacklistedPubkeys(): string[] {
		if (!this.isInitialized) {
			throw new Error('EventHandler is not initialized')
		}
		return this.blacklistManager.getBlacklistedPubkeys()
	}

	/**
	 * Get the vanity URL registry manager.
	 */
	public getVanityManager(): VanityManagerImpl {
		return this.vanityManager
	}

	/**
	 * Get the NIP-05 purchase manager.
	 */
	public getNip05Manager(): Nip05ManagerImpl {
		return this.nip05Manager
	}

	public getStats() {
		return {
			adminCount: this.adminManager.size(),
			editorCount: this.editorManager.size(),
			blacklistedPubkeys: this.isInitialized ? this.blacklistManager.getBlacklistedPubkeys().length : 0,
			isBootstrapMode: this.bootstrapManager.isBootstrapMode(),
			isInitialized: this.isInitialized,
		}
	}

	public shutdown(): void {
		if (this.ndkService) {
			this.ndkService.shutdown()
		}
		this.isInitialized = false
		console.log('EventHandler shut down')
	}
}

// Export singleton instance getter - call getInstance() to get the instance
// Note: Don't create the instance immediately to avoid initialization errors
export const getEventHandler = () => EventHandler.getInstance()
