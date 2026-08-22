import { DEFAULT_PUBLIC_RELAYS, MAIN_RELAY_BY_STAGE, type Stage } from '@/lib/constants'
import type { NDKFilter, NDKSigner, NDKSubscriptionOptions, NDKUser } from '@nostr-dev-kit/ndk'
import NDK, { NDKEvent, NDKRelaySet } from '@nostr-dev-kit/ndk'
import { Store } from '@tanstack/store'
import { configStore } from './config'

export interface NDKState {
	ndk: NDK | null
	isConnecting: boolean
	isConnected: boolean
	explicitRelayUrls: string[]
	writeRelayUrls: string[] // Relays we're allowed to write to (staging restriction)
	signer?: NDKSigner
}

const initialState: NDKState = {
	ndk: null,
	isConnecting: false,
	isConnected: false,
	explicitRelayUrls: [],
	writeRelayUrls: [],
	signer: undefined,
}

export const ndkStore = new Store<NDKState>(initialState)

let configRelaySyncInitialized = false
let lastSyncedAppRelay: string | undefined
let connectPromise: Promise<void> | null = null

/**
 * Helper to connect an NDK instance with timeout
 * Returns true if at least one relay connected
 */
async function connectNdkWithTimeout(ndk: NDK, timeoutMs: number, label: string): Promise<boolean> {
	try {
		await Promise.race([
			ndk.connect(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} connection timeout`)), timeoutMs)),
		])
		return true
	} catch (error) {
		console.warn(`${label} connection issue:`, error)
		// Check if any relays connected despite the timeout
		try {
			const connected = ndk.pool?.connectedRelays() || []
			if (connected.length > 0) {
				console.log(`✅ ${label} partially connected to ${connected.length} relays`)
				return true
			}
		} catch {
			// Ignore pool access errors
		}
		return false
	}
}

/**
 * Get the current stage from config.
 * Returns undefined if config hasn't been loaded yet.
 */
function getCurrentStage(): Stage | undefined {
	if (!configStore.state.isLoaded) return undefined
	return configStore.state.config.stage || 'development'
}

/**
 * Get the main relay for the current stage.
 * Returns undefined if config hasn't been loaded yet (prevents localhost relay in production).
 */
export function getMainRelay(): string | undefined {
	const appRelay = configStore.state.config.appRelay
	if (appRelay) return appRelay // Server-provided appRelay takes precedence
	const stage = getCurrentStage()
	if (!stage) return undefined // Config not loaded yet, don't assume a stage
	return MAIN_RELAY_BY_STAGE[stage]
}

/**
 * Get the write relay(s) for the current stage
 * Staging: main relay only
 * Development: main relay only (prevents leaking test/dev data to public relays)
 * Production: all connected relays
 */
export function getWriteRelays(): string[] {
	const stage = getCurrentStage()
	if (stage === 'staging') {
		const mainRelay = getMainRelay()
		return mainRelay ? [mainRelay] : []
	}
	if (stage === 'development') {
		const mainRelay = getMainRelay()
		return mainRelay ? [mainRelay] : []
	}
	// Production: write to all connected relays
	return ndkStore.state.explicitRelayUrls
}

/**
 * Get an NDKRelaySet configured for write operations.
 * Staging: only the main relay
 * Development: only the main relay (prevents leaking to public relays)
 * Production: undefined (NDK default = all connected relays)
 */
export function getWriteRelaySet(): NDKRelaySet | undefined {
	const ndk = ndkStore.state.ndk
	if (!ndk) return undefined

	const stage = getCurrentStage()
	if (stage === 'staging') {
		const writeRelays = getWriteRelays()
		console.log(`📝 Staging mode: restricting writes to ${writeRelays.join(', ')}`)
		return NDKRelaySet.fromRelayUrls(writeRelays, ndk)
	}
	if (stage === 'development') {
		const writeRelays = getWriteRelays()
		console.log(`📝 Development mode: restricting writes to ${writeRelays.join(', ')}`)
		return NDKRelaySet.fromRelayUrls(writeRelays, ndk)
	}

	// Production: return undefined to use default behavior (all relays)
	return undefined
}

/**
 * Get an NDKRelaySet pinned to ONLY the app's main relay.
 * Use for reads of app-config events (kind 31990 handler info, kind 30000 d=admins/editors,
 * kind 10000 mute list, NIP-51 featured lists). Prevents stale copies on user-added
 * NIP-65 relays or public relays from racing the canonical answer.
 *
 * Returns undefined if NDK or the app relay isn't ready yet — callers should treat
 * that as "config not available yet" rather than falling back to all relays.
 */
export function getAppRelaySet(): NDKRelaySet | undefined {
	const ndk = ndkStore.state.ndk
	const mainRelay = getMainRelay()
	if (!ndk || !mainRelay) return undefined
	return NDKRelaySet.fromRelayUrls([mainRelay], ndk)
}

/**
 * Filter shape accepted by fetchLatestAppEvent. Kinds is widened to plain number[]
 * so call sites can use literal kinds (e.g. NIP-99 30402, featured-products 30405)
 * that aren't members of NDK's NDKKind enum.
 */
export type AppEventFilter = Omit<NDKFilter, 'kinds'> & { kinds?: number[] }

/**
 * Fetch the latest event (highest created_at) matching the filter from the app relay only.
 * Returns null if NDK isn't ready, the app relay isn't known yet, or no event was found.
 */
export async function fetchLatestAppEvent(filter: AppEventFilter): Promise<NDKEvent | null> {
	const ndk = ndkStore.state.ndk
	const relaySet = getAppRelaySet()
	if (!ndk || !relaySet) return null
	const events = await ndk.fetchEvents(filter as NDKFilter, undefined, relaySet)
	const arr = Array.from(events)
	if (arr.length === 0) return null
	return arr.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0]
}

/**
 * Determine which relays to use based on config and environment
 */
function getRelayUrls(overrideRelays?: string[]): string[] {
	const stage = getCurrentStage()
	// @ts-ignore - Bun.env is available in Bun runtime
	const localRelayOnly = typeof Bun !== 'undefined' && Bun.env?.LOCAL_RELAY_ONLY === 'true'

	// Get main relay (from config or stage default)
	// Will be undefined if config hasn't loaded yet, preventing localhost relay in production
	const mainRelay = getMainRelay()

	// Development mode: only use local/main relay to prevent polluting public relays
	// This applies to both server (Bun) and browser environments
	if (stage === 'development' && mainRelay) {
		return [mainRelay]
	}

	// Server-side with LOCAL_RELAY_ONLY flag: only local relay
	if (localRelayOnly && mainRelay) {
		return [mainRelay]
	}

	// Override relays take precedence if provided (include main relay if available)
	if (overrideRelays?.length) {
		const relays = mainRelay ? [mainRelay, ...overrideRelays] : overrideRelays
		return Array.from(new Set(relays))
	}

	// Standard case: main relay (if available) + public default relays
	const relays = mainRelay ? [mainRelay, ...DEFAULT_PUBLIC_RELAYS] : DEFAULT_PUBLIC_RELAYS
	return Array.from(new Set(relays))
}

export const ndkActions = {
	/**
	 * Ensure the instance relay (config.appRelay) is always present,
	 * even before a signer exists (read-only queries must still work).
	 */
	ensureAppRelayFromConfig: (): void => {
		const appRelay = configStore.state.config.appRelay
		if (!appRelay) return

		// Avoid repeated attempts when config updates but relay is unchanged
		if (lastSyncedAppRelay === appRelay) return

		// Add/connect to the relay if NDK is ready
		const added = ndkActions.addSingleRelay(appRelay)
		if (added) lastSyncedAppRelay = appRelay
	},

	/**
	 * Fetch events, but guarantee resolution even if some relays never EOSE.
	 * This prevents UI loading states from hanging indefinitely.
	 */
	fetchEventsWithTimeout: async (
		filters: NDKFilter | NDKFilter[],
		opts?: NDKSubscriptionOptions & { timeoutMs?: number; relaySet?: NDKRelaySet },
	): Promise<Set<NDKEvent>> => {
		const ndk = ndkStore.state.ndk
		if (!ndk) throw new Error('NDK not initialized')

		const { timeoutMs = 8000, relaySet, ...subOpts } = opts ?? {}

		return await new Promise<Set<NDKEvent>>((resolve) => {
			const events = new Map<string, NDKEvent>()
			let settled = false
			let timer: ReturnType<typeof setTimeout> | undefined

			const finalize = (subscription?: { stop: () => void }) => {
				if (settled) return
				settled = true
				if (timer) clearTimeout(timer)
				subscription?.stop()
				resolve(new Set(events.values()))
			}

			const subscriptionOpts = {
				...subOpts,
				closeOnEose: true,
				onEvent: (event) => {
					const key = event.deduplicationKey()
					const existing = events.get(key)
					if (!existing) {
						events.set(key, event)
						return
					}
					const existingCreatedAt = existing.created_at || 0
					const nextCreatedAt = event.created_at || 0
					if (nextCreatedAt >= existingCreatedAt) {
						events.set(key, event)
					}
				},
				onEose: () => finalize(subscription),
				onClose: () => finalize(subscription),
			}

			const subscription = relaySet ? ndk.subscribe(filters, subscriptionOpts, relaySet) : ndk.subscribe(filters, subscriptionOpts)

			timer = setTimeout(() => finalize(subscription), timeoutMs)
		})
	},

	/**
	 * Initialize NDK instances (does not connect yet)
	 */
	initialize: (relays?: string[]) => {
		const state = ndkStore.state
		if (state.ndk) return state.ndk

		if (!configRelaySyncInitialized) {
			configRelaySyncInitialized = true
			configStore.subscribe((currentVal) => {
				const appRelay = currentVal.config.appRelay
				if (!appRelay) return
				if (lastSyncedAppRelay === appRelay) return
				const added = ndkActions.addSingleRelay(appRelay)
				if (added) lastSyncedAppRelay = appRelay
			})
		}

		const explicitRelays = getRelayUrls(relays)
		const stage = getCurrentStage()

		// The app is deliberately single-relay: it talks only to its own app relay.
		// Disable the outbox model unconditionally so NDK never discovers or connects
		// to additional relays from users' NIP-65 relay lists (no federation/discovery).
		//
		// AI Guardrails are an NDK dev-time educational tool (shipped off by
		// default). Enabling them in production turns a single malformed pubkey
		// in any filter into a fatal throw ("AI_GUARDRAILS ERROR") that crashes
		// the page. Keep them on only in dev/staging where they're useful.
		//
		// NDK's default filter validation ('validate', strict) is intentionally
		// retained in all stages: invalid/empty pubkeys are rejected at the query
		// layer before any filter is built (fail closed) — never by loosening NDK
		// validation. 'fix' mode would strip a bad author and broaden an
		// identity-scoped request instead of rejecting it, which is unsafe for
		// marketplace identity/order/payment boundaries.
		const enableGuardrails = stage === 'development' || stage === 'staging'
		const ndk = new NDK({
			explicitRelayUrls: explicitRelays,
			enableOutboxModel: false,
			aiGuardrails: enableGuardrails ? { skip: new Set(['ndk-no-cache', 'fetch-events-usage']) } : false,
		})

		// Determine write relays - staging only writes to main relay, others write to all
		const mainRelay = getMainRelay()
		const writeRelays =
			stage === 'staging' && mainRelay
				? [mainRelay] // Staging: only main relay
				: explicitRelays // Others: all explicit relays

		ndkStore.setState((s) => ({
			...s,
			ndk,
			explicitRelayUrls: explicitRelays,
			writeRelayUrls: writeRelays,
		}))

		// If config was already loaded before initialization, ensure appRelay is included.
		ndkActions.ensureAppRelayFromConfig()

		return ndk
	},

	/**
	 * Connect NDK to relays (non-blocking, runs in background)
	 */
	connect: async (timeoutMs = 10000): Promise<void> => {
		const state = ndkStore.state
		if (!state.ndk) return
		if (state.isConnected) return
		if (state.isConnecting) {
			if (connectPromise) return await connectPromise
			return
		}

		connectPromise = (async () => {
			ndkStore.setState((s) => ({ ...s, isConnecting: true }))

			try {
				const connected = await connectNdkWithTimeout(state.ndk!, timeoutMs, 'NDK')
				ndkStore.setState((s) => ({ ...s, isConnected: connected }))
				if (connected) console.log('✅ NDK connected to relays')
			} finally {
				ndkStore.setState((s) => ({ ...s, isConnecting: false }))
				connectPromise = null
			}
		})()

		return await connectPromise
	},

	addExplicitRelay: (relayUrls: string[]): string[] => {
		const state = ndkStore.state
		if (!state.ndk) return []

		relayUrls.forEach((relayUrl) => {
			state.ndk!.addExplicitRelay(relayUrl)
		})

		const updatedUrls = Array.from(new Set([...state.explicitRelayUrls, ...relayUrls]))
		ndkStore.setState((state) => ({ ...state, explicitRelayUrls: updatedUrls }))
		return updatedUrls
	},

	addSingleRelay: (relayUrl: string): boolean => {
		const state = ndkStore.state
		if (!state.ndk) return false

		try {
			// Normalize the URL (add wss:// if missing)
			const normalizedUrl = relayUrl.startsWith('ws://') || relayUrl.startsWith('wss://') ? relayUrl : `wss://${relayUrl}`

			// Already present?
			if (state.explicitRelayUrls.includes(normalizedUrl)) return true

			state.ndk.addExplicitRelay(normalizedUrl)

			const updatedUrls = Array.from(new Set([...state.explicitRelayUrls, normalizedUrl]))
			ndkStore.setState((state) => ({ ...state, explicitRelayUrls: updatedUrls }))
			return true
		} catch (error) {
			console.error('Failed to add relay:', error)
			return false
		}
	},

	setSigner: async (signer: NDKSigner | undefined) => {
		const state = ndkStore.state
		if (!state.ndk) {
			console.warn('Attempted to set signer before NDK was initialized. Initializing NDK now.')
			ndkActions.initialize()
			if (!ndkStore.state.ndk) {
				console.error('NDK initialization failed. Cannot set signer.')
				return
			}
			const newState = ndkStore.state
			newState.ndk!.signer = signer
		} else {
			state.ndk.signer = signer
		}

		ndkStore.setState((s) => ({ ...s, signer }))

		// NOTE: The connection set is operator infrastructure, not user preference.
		// We deliberately do NOT read the user's kind-10002 relay list here — the app
		// federates only with its operator-configured relay(s) (config.appRelay /
		// MAIN_RELAY_BY_STAGE + DEFAULT_PUBLIC_RELAYS). Any user relay prefs persisted
		// on Nostr are ignored for this app's connections.
	},

	removeSigner: () => {
		ndkActions.setSigner(undefined)
	},

	getNDK: () => {
		return ndkStore.state.ndk
	},

	getUser: async (): Promise<NDKUser | null> => {
		const state = ndkStore.state
		if (!state.ndk || !state.ndk.signer) return null
		try {
			return await state.ndk.signer.user()
		} catch (e) {
			console.error('Error fetching user from signer in getUser:', e)
			return null
		}
	},

	getSigner: () => {
		return ndkStore.state.ndk?.signer
	},

	/**
	 * Publish an event respecting the current stage's write restrictions.
	 * In staging, events are only published to the staging relay.
	 * In production/development, events are published to all connected relays.
	 *
	 * @param event The NDKEvent to publish (must already be signed)
	 * @returns Promise resolving to the set of relays the event was published to
	 */
	publishEvent: async (event: NDKEvent, relaySet?: NDKRelaySet): Promise<Set<any>> => {
		relaySet ??= getWriteRelaySet()
		return event.publish(relaySet)
	},
}

export const useNDK = () => {
	return {
		...ndkStore.state,
		...ndkActions,
	}
}
