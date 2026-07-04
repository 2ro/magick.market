import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { encrypt } from 'nostr-tools/nip49'
import { hexToBytes } from 'nostr-tools/utils'
import { decryptAsync } from '@/lib/crypto/nip49Async'
import { authActions, authStore, NOSTR_AUTO_LOGIN, NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY, NOSTR_SESSION_PRIVATE_KEY } from '@/lib/stores/auth'
import { ndkActions } from '@/lib/stores/ndk'
import { cartActions } from '@/lib/stores/cart'
import { TERMS_ACCEPTED_KEY } from '@/components/dialogs/TermsConditionsDialog'

class MemoryStorage {
	private s = new Map<string, string>()
	getItem(k: string) {
		return this.s.has(k) ? this.s.get(k)! : null
	}
	setItem(k: string, v: string) {
		this.s.set(k, v)
	}
	removeItem(k: string) {
		this.s.delete(k)
	}
	clear() {
		this.s.clear()
	}
}

// A throwaway private key (fixed so the test is deterministic).
const PRIVATE_KEY_HEX = 'a'.repeat(64)
const PASSWORD = 'hunter2-correct-horse'

// Stub the NDK / cart touchpoints with spies on the REAL modules rather than
// mock.module: bun's mock.module replaces the module registry entry for the
// whole test run, which (on some bun versions, e.g. the 1.3.4 CI runs on)
// leaks into later test files — a cart stub here broke v4v-shares.test.ts in
// CI. spyOn only mutates the live object and is restored in afterAll.
const spies = [
	spyOn(ndkActions, 'getNDK').mockReturnValue({} as never),
	spyOn(ndkActions, 'setSigner').mockImplementation((async () => {}) as never),
	spyOn(cartActions, 'reconcileRemoteCartForUser').mockImplementation((async () => {}) as never),
	spyOn(cartActions, 'clear').mockImplementation((() => {}) as never),
]

const loginCalls: string[] = []
const originalLogin = authActions.loginWithPrivateKey
const trackLogins = () => {
	authActions.loginWithPrivateKey = async (pk: string) => {
		loginCalls.push(pk)
		return originalLogin.call(authActions, pk)
	}
}

afterAll(() => {
	for (const spy of spies) spy.mockRestore()
	authActions.loginWithPrivateKey = originalLogin
})

describe('auth session key cache', () => {
	beforeEach(() => {
		;(globalThis as any).localStorage = new MemoryStorage()
		;(globalThis as any).sessionStorage = new MemoryStorage()
		// Pre-accept terms so checkAndShowTermsDialog is a no-op.
		localStorage.setItem(TERMS_ACCEPTED_KEY, 'true')
		loginCalls.length = 0
		authActions.loginWithPrivateKey = originalLogin
	})

	test('decryptAsync round-trips a NIP-49 ncryptsec produced by the app', async () => {
		// logN 18 matches encryptAndSavePrivateKey's default.
		const ncryptsec = encrypt(hexToBytes(PRIVATE_KEY_HEX), PASSWORD, 18, 1)
		const decrypted = await decryptAsync(ncryptsec, PASSWORD)
		const hex = Array.from(decrypted)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
		expect(hex).toBe(PRIVATE_KEY_HEX)
	})

	test('decryptAndLogin caches the unlocked key in sessionStorage (not localStorage)', async () => {
		const ncryptsec = encrypt(hexToBytes(PRIVATE_KEY_HEX), PASSWORD, 16, 1)
		localStorage.setItem(NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY, `pubkey:${ncryptsec}`)
		trackLogins()

		await authActions.decryptAndLogin(PASSWORD)

		expect(loginCalls).toEqual([PRIVATE_KEY_HEX])
		expect(sessionStorage.getItem(NOSTR_SESSION_PRIVATE_KEY)).toBe(PRIVATE_KEY_HEX)
		// The plaintext key must NEVER touch localStorage.
		expect(localStorage.getItem(NOSTR_SESSION_PRIVATE_KEY)).toBeNull()
	})

	test('refresh reuses the cached key without re-deriving or re-prompting', async () => {
		const ncryptsec = encrypt(hexToBytes(PRIVATE_KEY_HEX), PASSWORD, 16, 1)
		localStorage.setItem(NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY, `pubkey:${ncryptsec}`)
		localStorage.setItem(NOSTR_AUTO_LOGIN, 'true')
		// Simulate a prior in-session unlock.
		sessionStorage.setItem(NOSTR_SESSION_PRIVATE_KEY, PRIVATE_KEY_HEX)
		trackLogins()

		await authActions.getAuthFromLocalStorageAndLogin()

		// Logged in straight from cache, and no password dialog was requested.
		expect(loginCalls).toEqual([PRIVATE_KEY_HEX])
		expect(authStore.state.needsDecryptionPassword).toBe(false)
	})

	test('without a cached key, refresh asks for the passphrase', async () => {
		const ncryptsec = encrypt(hexToBytes(PRIVATE_KEY_HEX), PASSWORD, 16, 1)
		localStorage.setItem(NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY, `pubkey:${ncryptsec}`)
		localStorage.setItem(NOSTR_AUTO_LOGIN, 'true')
		// No session key present (cold start / new tab).

		await authActions.getAuthFromLocalStorageAndLogin()

		expect(authStore.state.needsDecryptionPassword).toBe(true)
	})

	test('logout clears the cached session key', async () => {
		sessionStorage.setItem(NOSTR_SESSION_PRIVATE_KEY, PRIVATE_KEY_HEX)
		authActions.logout()
		expect(sessionStorage.getItem(NOSTR_SESSION_PRIVATE_KEY)).toBeNull()
	})
})
