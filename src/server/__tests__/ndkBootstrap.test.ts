import { describe, expect, test } from 'bun:test'
import { planNdkBootstrap, nextRetryDelayMs } from '../ndkBootstrap'

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
