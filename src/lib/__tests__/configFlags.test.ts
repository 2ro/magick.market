import { describe, expect, test } from 'bun:test'
import { computeConfigFlags } from '../configFlags'

describe('computeConfigFlags (setup/readiness gating)', () => {
	test('while initializing (not yet resolved), never reports needsSetup', () => {
		const f = computeConfigFlags({ appSettings: null, appSettingsResolved: false, eventHandlerReady: false })
		expect(f.initializing).toBe(true)
		expect(f.needsSetup).toBe(false) // the fix: no premature /setup bounce during boot
	})

	test('resolved with no settings => needsSetup', () => {
		const f = computeConfigFlags({ appSettings: null, appSettingsResolved: true, eventHandlerReady: true })
		expect(f.initializing).toBe(false)
		expect(f.needsSetup).toBe(true)
	})

	test('settings present => configured, not initializing, not needsSetup', () => {
		const f = computeConfigFlags({ appSettings: { name: 'MM' }, appSettingsResolved: true, eventHandlerReady: true })
		expect(f.needsSetup).toBe(false)
		expect(f.initializing).toBe(false)
	})

	test('settings arriving before resolution flips still not needsSetup', () => {
		const f = computeConfigFlags({ appSettings: { name: 'MM' }, appSettingsResolved: false, eventHandlerReady: true })
		expect(f.needsSetup).toBe(false)
		expect(f.initializing).toBe(true)
	})

	test('serverReady mirrors eventHandlerReady', () => {
		expect(computeConfigFlags({ appSettings: null, appSettingsResolved: true, eventHandlerReady: false }).serverReady).toBe(false)
		expect(computeConfigFlags({ appSettings: null, appSettingsResolved: true, eventHandlerReady: true }).serverReady).toBe(true)
	})
})
