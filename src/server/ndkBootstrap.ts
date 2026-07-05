export interface NdkBootstrapInputs {
	/** An NDK instance exists to hand to the managers (i.e. relayUrl is configured). */
	ndkCreated: boolean
	/** The connect() call resolved before the timeout on this attempt. */
	connectSucceeded: boolean
	/** The registry fetch completed (relay responded) without throwing on this attempt. */
	loadSucceeded: boolean
}

export interface NdkBootstrapPlan {
	/** Hand the NDK to the managers. MUST NOT depend on the connect race. */
	attachNdk: boolean
	/** Attempt the registry loads now (the connection is up). */
	loadNow: boolean
	/** Keep retrying the loads in the background (connect raced, or the load failed). */
	scheduleLoadRetry: boolean
}

/**
 * Decide how to wire an NDK instance into the name/blacklist managers at boot.
 *
 * THE INVARIANT (regression guard for the 2026-07-04 ~18:16 EDT incident):
 * whenever an NDK instance exists, it is attached to the managers regardless of
 * whether the first connect() won or lost its ~10s timeout race. Previously the
 * attach (setNDK) lived INSIDE the connect try-block, so a single flaky connect
 * timeout left the managers permanently holding ndk = null. Registrations then
 * still returned 200 and resolved from the in-memory Map, but publishRegistry()
 * early-returned on `if (!this.ndk)`, so the kind-30000 registry event was never
 * written — every registration was lost on restart and invisible to other
 * readers. NDK is designed to accept the reference while still connecting;
 * publishes queue and fire once the socket is up, so attaching early is safe.
 *
 * Pure decision logic only — no NDK or IO — so it can be unit-tested directly
 * (see ndkBootstrap.test.ts), mirroring the configFlags.ts boot-flag precedent.
 */
export function planNdkBootstrap({ ndkCreated, connectSucceeded, loadSucceeded }: NdkBootstrapInputs): NdkBootstrapPlan {
	return {
		// The fix: attach whenever an NDK exists, independent of the connect race.
		attachNdk: ndkCreated,
		loadNow: ndkCreated && connectSucceeded,
		// If the NDK exists but we could not load it (connect raced or the fetch
		// failed), keep retrying until the registry is populated — never leave a
		// configured instance with its registries unloaded.
		scheduleLoadRetry: ndkCreated && (!connectSucceeded || !loadSucceeded),
	}
}

/**
 * Decide whether to treat the app relay as connected for retry-scheduling
 * purposes when connect()'s promise did not resolve.
 *
 * THE READ-PATH INVARIANT (sibling of the WRITE-path race above): the registry
 * LOAD is NEVER gated on this — loadExisting*Registry always runs because
 * fetchEvents auto-connects and returns the persisted kind-30000 event even
 * while NDK 3.0.3's pool.connect() promise stays pending against a fast relay.
 * This helper only decides whether the background retry loop should STOP: if the
 * fetch just succeeded, or the pool actually has a live socket, the relay is
 * demonstrably reachable and retrying would be pointless. Previously a flaky
 * connect() promise both skipped the load AND kept the served
 * /.well-known/nostr.json empty until the next write — names vanished on restart.
 *
 * Pure decision logic only (no NDK/IO) so it is unit-tested directly.
 */
export function deriveConnectSucceeded(connectResolved: boolean, loadSucceeded: boolean, connectedRelayCount: number): boolean {
	return connectResolved || loadSucceeded || connectedRelayCount > 0
}

/**
 * Capped exponential backoff (ms) for the registry-load retry loop.
 * attempt 0 => 0 (run immediately), attempt N>0 => base * 2^(N-1), capped at maxMs.
 */
export function nextRetryDelayMs(attempt: number, baseMs = 2000, maxMs = 30000): number {
	if (attempt <= 0) return 0
	return Math.min(baseMs * 2 ** (attempt - 1), maxMs)
}
