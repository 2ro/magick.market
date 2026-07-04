import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { encrypt } from 'nostr-tools/nip49'
import { hexToBytes } from 'nostr-tools/utils'
import { decryptAsync } from '@/lib/crypto/nip49Async'

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

// Stub the heavy Nostr/NDK graph so we can exercise the auth store in isolation.
const loginCalls: string[] = []
mock.module('@/lib/stores/ndk', () => ({
	ndkActions: { getNDK: () => ({}), setSigner: () => {}, removeSigner: () => {} },
}))
mock.module('@/lib/stores/cart', () => ({
	cartActions: { reconcileRemoteCartForUser: () => {}, clear: () => {} },
}))
mock.module('@/queries/products', () => ({ fetchProductsByPubkey: async () => [] }))
mock.module('@/lib/stores/ui', () => ({ uiActions: { openDialog: () => {} } }))
mock.module('@/components/dialogs/TermsConditionsDialog', () => ({
	hasAcceptedTerms: () => true,
	TERMS_ACCEPTED_KEY: 'terms',
}))

describe('auth session key cache', () => {
	beforeEach(() => {
		;(globalThis as any).localStorage = new MemoryStorage()
		;(globalThis as any).sessionStorage = new MemoryStorage()
		loginCalls.length = 0
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
		const auth = await import('@/lib/stores/auth')
		const ncryptsec = encrypt(hexToBytes(PRIVATE_KEY_HEX), PASSWORD, 16, 1)
		localStorage.setItem(auth.NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY, `pubkey:${ncryptsec}`)

		// Spy on loginWithPrivateKey to record how it's invoked.
		const original = auth.authActions.loginWithPrivateKey
		auth.authActions.loginWithPrivateKey = async (pk: string) => {
			loginCalls.push(pk)
			return original.call(auth.authActions, pk)
		}

		await auth.authActions.decryptAndLogin(PASSWORD)

		expect(loginCalls).toEqual([PRIVATE_KEY_HEX])
		expect(sessionStorage.getItem(auth.NOSTR_SESSION_PRIVATE_KEY)).toBe(PRIVATE_KEY_HEX)
		// The plaintext key must NEVER touch localStorage.
		expect(localStorage.getItem(auth.NOSTR_SESSION_PRIVATE_KEY)).toBeNull()

		auth.authActions.loginWithPrivateKey = original
	})

	test('refresh reuses the cached key without re-deriving or re-prompting', async () => {
		const auth = await import('@/lib/stores/auth')
		const ncryptsec = encrypt(hexToBytes(PRIVATE_KEY_HEX), PASSWORD, 16, 1)
		localStorage.setItem(auth.NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY, `pubkey:${ncryptsec}`)
		localStorage.setItem(auth.NOSTR_AUTO_LOGIN, 'true')
		// Simulate a prior in-session unlock.
		sessionStorage.setItem(auth.NOSTR_SESSION_PRIVATE_KEY, PRIVATE_KEY_HEX)

		const original = auth.authActions.loginWithPrivateKey
		auth.authActions.loginWithPrivateKey = async (pk: string) => {
			loginCalls.push(pk)
			return original.call(auth.authActions, pk)
		}

		await auth.authActions.getAuthFromLocalStorageAndLogin()

		// Logged in straight from cache, and no password dialog was requested.
		expect(loginCalls).toEqual([PRIVATE_KEY_HEX])
		expect(auth.authStore.state.needsDecryptionPassword).toBe(false)

		auth.authActions.loginWithPrivateKey = original
	})

	test('without a cached key, refresh asks for the passphrase', async () => {
		const auth = await import('@/lib/stores/auth')
		const ncryptsec = encrypt(hexToBytes(PRIVATE_KEY_HEX), PASSWORD, 16, 1)
		localStorage.setItem(auth.NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY, `pubkey:${ncryptsec}`)
		localStorage.setItem(auth.NOSTR_AUTO_LOGIN, 'true')
		// No session key present (cold start / new tab).

		await auth.authActions.getAuthFromLocalStorageAndLogin()

		expect(auth.authStore.state.needsDecryptionPassword).toBe(true)
	})

	test('logout clears the cached session key', async () => {
		const auth = await import('@/lib/stores/auth')
		sessionStorage.setItem(auth.NOSTR_SESSION_PRIVATE_KEY, PRIVATE_KEY_HEX)
		auth.authActions.logout()
		expect(sessionStorage.getItem(auth.NOSTR_SESSION_PRIVATE_KEY)).toBeNull()
	})
})
