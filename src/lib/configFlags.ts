export interface ConfigFlagInputs {
	appSettings: unknown
	appSettingsResolved: boolean
	eventHandlerReady: boolean
}

export interface ConfigFlags {
	needsSetup: boolean
	initializing: boolean
	serverReady: boolean
}

/**
 * Derive the setup/readiness flags the client uses to decide whether to show the
 * market or bounce to /setup.
 *
 * Invariant: `needsSetup` is only true once the server has FINISHED trying to
 * load app settings (appSettingsResolved) and still has none. While the boot
 * fetch is in flight we report `initializing` instead, so a client that loads
 * during the boot window waits and re-polls rather than concluding the instance
 * is unconfigured and stranding the user on /setup.
 */
export function computeConfigFlags({ appSettings, appSettingsResolved, eventHandlerReady }: ConfigFlagInputs): ConfigFlags {
	return {
		needsSetup: appSettingsResolved && !appSettings,
		initializing: !appSettingsResolved,
		serverReady: eventHandlerReady,
	}
}
