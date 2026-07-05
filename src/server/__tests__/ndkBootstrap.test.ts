import { describe, expect, test } from 'bun:test'
import { planNdkBootstrap, nextRetryDelayMs, deriveConnectSucceeded } from '../ndkBootstrap'

describe('planNdkBootstrap (boot NDK wiring invariant)', () => {
	test('THE INVARIANT: attaches NDK even when the first connect races/times out', () => {
		// This is the exact 2026-07-04 18:16 EDT incident: connect lost its race.
		// The managers must STILL receive the NDK, otherwise publishRegistry()
		// early-returns and registrations are never written to the relay.
		const plan = planNdkBootstrap({ ndkCreated: true, connectSucceeded: false, loadSucceeded: false })
		expect(plan.attachNdk).toBe(true)
	})

	test('attaches NDK on the happy path too', () => {
		const plan = planNdkBootstrap({ ndkCreated: true, connectSucceeded: true, loadSucceeded: true })
		expect(plan.attachNdk).toBe(true)
	})

	test('never attaches when no NDK exists (relayUrl unset)', () => {
		const plan = planNdkBootstrap({ ndkCreated: false, connectSucceeded: false, loadSucceeded: false })
		expect(plan.attachNdk).toBe(false)
		expect(plan.loadNow).toBe(false)
		expect(plan.scheduleLoadRetry).toBe(false)
	})

	test('loads now only once the connection is up', () => {
		expect(planNdkBootstrap({ ndkCreated: true, connectSucceeded: true, loadSucceeded: false }).loadNow).toBe(true)
		expect(planNdkBootstrap({ ndkCreated: true, connectSucceeded: false, loadSucceeded: false }).loadNow).toBe(false)
	})

	test('schedules a retry when connect raced', () => {
		const plan = planNdkBootstrap({ ndkCreated: true, connectSucceeded: false, loadSucceeded: false })
		expect(plan.scheduleLoadRetry).toBe(true)
	})

	test('schedules a retry when connected but the load did not complete', () => {
		const plan = planNdkBootstrap({ ndkCreated: true, connectSucceeded: true, loadSucceeded: false })
		expect(plan.scheduleLoadRetry).toBe(true)
	})

	test('no retry once connected and loaded', () => {
		const plan = planNdkBootstrap({ ndkCreated: true, connectSucceeded: true, loadSucceeded: true })
		expect(plan.scheduleLoadRetry).toBe(false)
	})
})

describe('deriveConnectSucceeded (READ-path connect race)', () => {
	test('THE READ INVARIANT: a successful fetch counts as connected even when connect() never resolved', () => {
		// This is the restart bug: NDK 3.0.3 left connect() pending against a fast
		// relay, but fetchEvents returned the persisted kind-30000 registry fine.
		// The load must be treated as reachable so the retry loop stops (and, in
		// EventHandler, so the load is never skipped in the first place).
		expect(deriveConnectSucceeded(false, true, 0)).toBe(true)
	})

	test('a live pool socket counts as connected even when connect() never resolved', () => {
		expect(deriveConnectSucceeded(false, false, 1)).toBe(true)
	})

	test('a resolved connect() still counts (happy path preserved)', () => {
		expect(deriveConnectSucceeded(true, false, 0)).toBe(true)
	})

	test('genuinely unreachable: no resolve, no load, no socket => not connected (retry)', () => {
		expect(deriveConnectSucceeded(false, false, 0)).toBe(false)
	})

	test('feeds scheduleLoadRetry: fetch-succeeded-while-connect-pending stops the retry loop', () => {
		const connectSucceeded = deriveConnectSucceeded(false, true, 1)
		const plan = planNdkBootstrap({ ndkCreated: true, connectSucceeded, loadSucceeded: true })
		expect(plan.scheduleLoadRetry).toBe(false)
	})
})

describe('nextRetryDelayMs (capped exponential backoff)', () => {
	test('attempt 0 runs immediately', () => {
		expect(nextRetryDelayMs(0)).toBe(0)
	})

	test('grows exponentially from the base', () => {
		expect(nextRetryDelayMs(1, 2000, 30000)).toBe(2000)
		expect(nextRetryDelayMs(2, 2000, 30000)).toBe(4000)
		expect(nextRetryDelayMs(3, 2000, 30000)).toBe(8000)
	})

	test('is capped at maxMs', () => {
		expect(nextRetryDelayMs(20, 2000, 30000)).toBe(30000)
	})
})
