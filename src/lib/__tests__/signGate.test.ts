import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { ensureCanSign, isSigningCancelled, SigningCancelledError } from '@/lib/goblin/signGate'
import { authActions, authStore } from '@/lib/stores/auth'
import { uiActions, uiStore } from '@/lib/stores/ui'

// Control the single "can this session sign right now?" predicate the gate reads,
// so the tests never need a real NDK signer or wallet channel.
const canSignSpy = spyOn(authActions, 'canSignNow')

const resetStores = () => {
	uiActions.closeDialog('login')
	// Nudge the auth store so any leaked subscriber settles before the next test.
	authStore.setState((s) => ({ ...s }))
}

beforeEach(() => {
	canSignSpy.mockReturnValue(false)
	resetStores()
})

afterEach(() => {
	resetStores()
})

afterAll(() => {
	canSignSpy.mockRestore()
})

describe('ensureCanSign', () => {
	test('resolves immediately and opens no dialog when the session can already sign', async () => {
		canSignSpy.mockReturnValue(true)

		await expect(ensureCanSign()).resolves.toBeUndefined()
		expect(uiStore.state.dialogs.login).toBe(false)
	})

	test('opens the login dialog and stays pending while the session cannot sign', async () => {
		const pending = ensureCanSign()

		// The owner expectation: instead of throwing, we send the user to re-authorize.
		expect(uiStore.state.dialogs.login).toBe(true)

		let settled = false
		void pending.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)
		await Promise.resolve()
		expect(settled).toBe(false)

		// Clean up the still-pending promise so it doesn't leak into later tests.
		canSignSpy.mockReturnValue(true)
		authStore.setState((s) => ({ ...s }))
		await pending
	})

	test('resolves once the wallet re-authorizes (a signer becomes available)', async () => {
		const pending = ensureCanSign()
		expect(uiStore.state.dialogs.login).toBe(true)

		// Simulate the wallet trust flow completing: canSign flips true and the auth
		// store changes (loginWithGoblinTrust / loginWithExtension both do this).
		canSignSpy.mockReturnValue(true)
		authStore.setState((s) => ({ ...s, isAuthenticated: true, canSign: true }))

		await expect(pending).resolves.toBeUndefined()
	})

	test('rejects with SigningCancelledError when the dialog is closed without a signer', async () => {
		const pending = ensureCanSign()
		expect(uiStore.state.dialogs.login).toBe(true)

		// User dismissed the re-auth prompt without granting signing.
		uiActions.closeDialog('login')

		await expect(pending).rejects.toBeInstanceOf(SigningCancelledError)
	})

	test('does not reject on unrelated UI changes while the dialog stays open', async () => {
		const pending = ensureCanSign()
		expect(uiStore.state.dialogs.login).toBe(true)

		// An unrelated store write (e.g. a dashboard title change) must not cancel the gate.
		uiActions.setDashboardTitle('unrelated change')
		await Promise.resolve()

		let rejected = false
		void pending.catch(() => {
			rejected = true
		})
		await Promise.resolve()
		expect(rejected).toBe(false)

		canSignSpy.mockReturnValue(true)
		authStore.setState((s) => ({ ...s }))
		await pending
	})
})

describe('isSigningCancelled', () => {
	test('recognises SigningCancelledError instances', () => {
		expect(isSigningCancelled(new SigningCancelledError())).toBe(true)
	})

	test('recognises a cancel by name even across bundling', () => {
		const clone = new Error('Signing was cancelled')
		clone.name = 'SigningCancelledError'
		expect(isSigningCancelled(clone)).toBe(true)
	})

	test('does not match ordinary errors', () => {
		expect(isSigningCancelled(new Error('No signer available'))).toBe(false)
		expect(isSigningCancelled(undefined)).toBe(false)
	})
})
