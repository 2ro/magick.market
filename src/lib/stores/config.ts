import { Store } from '@tanstack/store'
import type { Stage } from '@/lib/constants'

interface ConfigState {
	config: {
		appRelay?: string
		stage?: Stage
		appSettings?: any
		appPublicKey?: string
		cvmServerPubkey?: string
		needsSetup?: boolean
		/** Instance watcher npub for proof-on-request confirmation (spec 4.4/4.5). */
		watcherNpub?: string
		[key: string]: any
	}
	isLoaded: boolean
}

const initialState: ConfigState = {
	config: {},
	isLoaded: false,
}

export const configStore = new Store<ConfigState>(initialState)

export const configActions = {
	setConfig: (config: any) => {
		configStore.setState((state) => ({
			...state,
			config,
			isLoaded: true,
		}))
		return config
	},

	getAppRelay: () => {
		return configStore.state.config.appRelay
	},

	getStage: (): Stage => {
		return configStore.state.config.stage || 'development'
	},

	getAppPublicKey: () => {
		return configStore.state.config.appPublicKey
	},

	/**
	 * The instance watcher's npub (proof-on-request, spec section 7 + contract 4.4).
	 * The only new persistent config value the marketplace needs for proofs. It is
	 * emitted as the pay-URI `notify` param (so the wallet gift-wraps the proof to
	 * it) and is the ONLY pubkey allowed to flip an order to "paid" (contract 4.5).
	 * Absent -> proofs run in degraded mode (M4): no auto-flip to paid.
	 */
	getWatcherNpub: (): string | undefined => {
		const npub = configStore.state.config.watcherNpub
		return typeof npub === 'string' && npub.startsWith('npub1') ? npub : undefined
	},

	getAppSettings: () => {
		return configStore.state.config.appSettings
	},

	needsSetup: () => {
		return configStore.state.config.needsSetup
	},

	isConfigLoaded: () => {
		return configStore.state.isLoaded
	},
}

// React hook for consuming the store
export const useConfig = () => {
	return {
		...configStore.state,
		...configActions,
	}
}
