import { NDKNip07Signer, NDKNip46Signer, NDKPrivateKeySigner, NDKUser, NDKEvent } from '@nostr-dev-kit/ndk'
import { Store } from '@tanstack/store'
import { ndkActions } from './ndk'
import { cartActions } from './cart'
import { fetchProductsByPubkey } from '@/queries/products'
import { hasAcceptedTerms, TERMS_ACCEPTED_KEY } from '@/components/dialogs/TermsConditionsDialog'
import { uiActions } from './ui'
import { getPublicKey, nip19 } from 'nostr-tools'
import { encrypt } from 'nostr-tools/nip49'
import { hexToBytes } from 'nostr-tools/utils'
import { decryptInWorker } from '@/lib/crypto/nip49Async'

export const NOSTR_CONNECT_KEY = 'nostr_connect_url'
export const NOSTR_LOCAL_SIGNER_KEY = 'nostr_local_signer_key'
export const NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY = 'nostr_local_encrypted_signer_key'
export const NOSTR_AUTO_LOGIN = 'nostr_auto_login'
export const NOSTR_USER_PUBKEY = 'nostr_user_pubkey'
// Pubkey of a wallet-verified (view only) "Sign in with Goblin" session. The
// wallet proved control of the key by signing a one-time challenge, but the
// key itself never left the wallet, so no signer material is stored.
export const NOSTR_GOBLIN_PUBKEY = 'nostr_goblin_pubkey'
// Decrypted private key cached for the lifetime of the browser session (tab).
// Lives in sessionStorage so a page refresh reuses it instead of re-running the
// expensive NIP-49 scrypt derivation, while a new tab / cold start still
// requires the passphrase. Never written to localStorage.
export const NOSTR_SESSION_PRIVATE_KEY = 'nostr_session_private_key'

const cacheSessionPrivateKey = (privateKeyHex: string) => {
	if (typeof sessionStorage === 'undefined') return
	try {
		sessionStorage.setItem(NOSTR_SESSION_PRIVATE_KEY, privateKeyHex)
	} catch {
		// sessionStorage unavailable (private mode / quota) — fall back to re-derivation on refresh.
	}
}

const getSessionPrivateKey = (): string | null => {
	if (typeof sessionStorage === 'undefined') return null
	try {
		return sessionStorage.getItem(NOSTR_SESSION_PRIVATE_KEY)
	} catch {
		return null
	}
}

const clearSessionPrivateKey = () => {
	if (typeof sessionStorage === 'undefined') return
	try {
		sessionStorage.removeItem(NOSTR_SESSION_PRIVATE_KEY)
	} catch {
		// ignore
	}
}

interface AuthState {
	user: NDKUser | null
	isAuthenticated: boolean
	// True only when the session holds a real client-side signer (extension,
	// private key, NIP-46). A wallet-verified Goblin session is authenticated
	// but CANNOT sign: it stays false and signing surfaces must re-prompt.
	canSign: boolean
	needsDecryptionPassword: boolean
	isAuthenticating: boolean
	needsMigration: boolean
}

const initialState: AuthState = {
	user: null,
	isAuthenticated: false,
	canSign: false,
	needsDecryptionPassword: false,
	isAuthenticating: false,
	needsMigration: false,
}

export const authStore = new Store<AuthState>(initialState)

export const authActions = {
	getAuthFromLocalStorageAndLogin: async () => {
		try {
			// Check for migration (unencrypted private key) first
			if (authActions.getNeedsMigration()) {
				authStore.setState((state) => ({
					...state,
					needsMigration: true,
				}))

				return
			}

			// Only trigger auth check if auto-login is enabled

			const autoLogin = localStorage.getItem(NOSTR_AUTO_LOGIN)
			if (autoLogin !== 'true') return

			authStore.setState((state) => ({ ...state, isAuthenticating: true }))

			// Signer / Bunker URL

			const privateKeySigner = localStorage.getItem(NOSTR_LOCAL_SIGNER_KEY)
			const bunkerUrl = localStorage.getItem(NOSTR_CONNECT_KEY)

			if (privateKeySigner && bunkerUrl) {
				await authActions.loginWithNip46(bunkerUrl, new NDKPrivateKeySigner(privateKeySigner))
				authActions.checkAndShowTermsDialog()
				return
			}

			// Private key decryption

			const privateKey = localStorage.getItem(NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY)

			if (privateKey) {
				// Fast path: reuse the key unlocked earlier this session so a refresh
				// doesn't re-prompt or re-run scrypt. Cleared when the tab closes.
				const sessionKey = getSessionPrivateKey()
				if (sessionKey) {
					await authActions.loginWithPrivateKey(sessionKey)
					authActions.checkAndShowTermsDialog()
					return
				}
				authStore.setState((state) => ({ ...state, needsDecryptionPassword: true }))
				return
			}

			// Wallet-verified Goblin session (view only): restore from the stored
			// pubkey. No signer exists client-side, so this never prompts.

			const goblinPubkey = localStorage.getItem(NOSTR_GOBLIN_PUBKEY)

			if (goblinPubkey) {
				authActions.loginWithGoblinPubkey(goblinPubkey)
				authActions.checkAndShowTermsDialog()
				return
			}

			// Else, login with extension

			await authActions.loginWithExtension()
			authActions.checkAndShowTermsDialog()
		} catch (error) {
			console.error('Authentication failed:', error)
		} finally {
			authStore.setState((state) => ({ ...state, isAuthenticating: false }))
		}
	},
	decryptAndLogin: async (password: string) => {
		try {
			authStore.setState((state) => ({ ...state, isAuthenticating: true }))
			const encryptedPrivateKey = localStorage.getItem(NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY)
			if (!encryptedPrivateKey) {
				throw new Error('No encrypted key found')
			}

			// Extract the ncryptsec part (format: "pubkey:ncryptsec...")
			const [, encryptedKey] = encryptedPrivateKey.split(':')

			// Decrypt off the hot path: scryptAsync yields to the event loop so the
			// KDF no longer freezes the UI while the "Unlocking…" state is shown.
			const decryptedBytes = await decryptInWorker(encryptedKey, password)

			// Convert Uint8Array to hex string
			const privateKeyHex = Array.from(decryptedBytes)
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('')

			// Login with the decrypted key
			await authActions.loginWithPrivateKey(privateKeyHex)
			// Cache for the session so a refresh skips the expensive derivation.
			cacheSessionPrivateKey(privateKeyHex)
			authStore.setState((state) => ({ ...state, needsDecryptionPassword: false }))
			authActions.checkAndShowTermsDialog()
		} catch (error) {
			throw error
		} finally {
			authStore.setState((state) => ({ ...state, isAuthenticating: false }))
		}
	},

	encryptAndSavePrivateKey: async (privateKey: string, password: string, logN: number = 18) => {
		try {
			authStore.setState((state) => ({ ...state, isAuthenticating: true }))

			// Normalize the private key
			const normalizedKey = privateKey.startsWith('nsec1') ? privateKey : nip19.nsecEncode(hexToBytes(privateKey))

			const { data: secretKeyBytes } = nip19.decode(normalizedKey) as { data: Uint8Array }
			const pubkey = getPublicKey(secretKeyBytes)

			// Use nostr-tools encrypt function
			const encryptedKey = encrypt(secretKeyBytes, password, logN, 1)

			// Replace encrypted key with format: "pubkey:ncryptsec..."
			localStorage.setItem(NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY, `${pubkey}:${encryptedKey}`)

			return true
		} catch (error) {
			throw error
		} finally {
			authStore.setState((state) => ({ ...state, isAuthenticating: false }))
		}
	},

	checkAndShowTermsDialog: () => {
		if (!hasAcceptedTerms()) {
			uiActions.openDialog('terms')
		}
	},

	loginWithPrivateKey: async (privateKey: string) => {
		const ndk = ndkActions.getNDK()
		if (!ndk) throw new Error('NDK not initialized')

		try {
			authStore.setState((state) => ({ ...state, isAuthenticating: true }))
			const signer = new NDKPrivateKeySigner(privateKey)
			await signer.blockUntilReady()
			ndkActions.setSigner(signer)

			const user = await signer.user()

			// A signer-based login supersedes any wallet-verified Goblin session,
			// otherwise the stale pubkey would win on the next refresh.
			localStorage.removeItem(NOSTR_GOBLIN_PUBKEY)

			authStore.setState((state) => ({
				...state,
				user,
				isAuthenticated: true,
				canSign: true,
			}))

			void cartActions.reconcileRemoteCartForUser(user.pubkey, signer, ndk)

			return user
		} catch (error) {
			authStore.setState((state) => ({
				...state,
				isAuthenticated: false,
			}))
			throw error
		} finally {
			authStore.setState((state) => ({ ...state, isAuthenticating: false }))
		}
	},

	// "Sign in with Goblin": the wallet signed a one-time server challenge, so we
	// know the user controls this pubkey, but the key never left the wallet. This
	// creates a wallet-verified (view only) session: NO NDK signer is set, and
	// canSign stays false so signing surfaces re-prompt via the login dialog.
	loginWithGoblinPubkey: (pubkey: string): NDKUser => {
		const user = new NDKUser({ pubkey })
		const ndk = ndkActions.getNDK()
		if (ndk) user.ndk = ndk

		localStorage.setItem(NOSTR_GOBLIN_PUBKEY, pubkey)
		localStorage.setItem(NOSTR_USER_PUBKEY, pubkey)
		localStorage.setItem(NOSTR_AUTO_LOGIN, 'true')

		authStore.setState((state) => ({
			...state,
			user,
			isAuthenticated: true,
			canSign: false,
		}))

		return user
	},

	// Central "can this session sign client-side right now?" check. False for
	// wallet-verified Goblin sessions (and any session without a live signer).
	canSignNow: (): boolean => {
		return authStore.state.canSign && !!ndkActions.getSigner()
	},

	getAvailableNostrExtensions: (): string[] => {
		const extensions: string[] = []
		if (typeof window !== 'undefined') {
			if ((window as any).nostr) extensions.push('nostr')
			if ((window as any).nos2x) extensions.push('nos2x')
			if ((window as any).alby) extensions.push('alby')
		}
		return extensions
	},

	loginWithExtension: async () => {
		const ndk = ndkActions.getNDK()
		if (!ndk) throw new Error('NDK not initialized')

		// Check if extensions are available before attempting login
		const availableExtensions = authActions.getAvailableNostrExtensions()
		if (availableExtensions.length === 0) {
			throw new Error('No Nostr extension detected. Please install a Nostr browser extension (e.g., Alby, nos2x) before logging in.')
		}

		try {
			authStore.setState((state) => ({ ...state, isAuthenticating: true }))
			const signer = new NDKNip07Signer()
			await signer.blockUntilReady()
			ndkActions.setSigner(signer)

			const user = await signer.user()

			if (!user || !user.pubkey) {
				throw new Error('Failed to authenticate with Nostr extension. Please make sure your extension is unlocked and try again.')
			}

			// Store user pubkey and enable auto-login for persistence. A signer
			// login supersedes any wallet-verified Goblin session.
			localStorage.setItem(NOSTR_USER_PUBKEY, user.pubkey)
			localStorage.setItem(NOSTR_AUTO_LOGIN, 'true')
			localStorage.removeItem(NOSTR_GOBLIN_PUBKEY)

			authStore.setState((state) => ({
				...state,
				user,
				isAuthenticated: true,
				canSign: true,
			}))

			void cartActions.reconcileRemoteCartForUser(user.pubkey, signer, ndk)

			return user
		} catch (error) {
			authStore.setState((state) => ({
				...state,
				isAuthenticated: false,
			}))
			throw error
		} finally {
			authStore.setState((state) => ({ ...state, isAuthenticating: false }))
		}
	},

	loginWithNip46: async (bunkerUrl: string, localSigner: NDKPrivateKeySigner) => {
		const ndk = ndkActions.getNDK()
		if (!ndk) throw new Error('NDK not initialized')

		try {
			authStore.setState((state) => ({ ...state, isAuthenticating: true }))
			const signer = new NDKNip46Signer(ndk, bunkerUrl, localSigner)
			await signer.blockUntilReady()
			ndkActions.setSigner(signer)
			const user = await signer.user()

			// Wait until user is logged in successfully before saving the bunkerURL/private key.

			localStorage.setItem(NOSTR_LOCAL_SIGNER_KEY, localSigner.privateKey || '')
			localStorage.setItem(NOSTR_CONNECT_KEY, bunkerUrl)
			// A signer login supersedes any wallet-verified Goblin session.
			localStorage.removeItem(NOSTR_GOBLIN_PUBKEY)

			authStore.setState((state) => ({
				...state,
				user,
				isAuthenticated: true,
				canSign: true,
			}))

			void cartActions.reconcileRemoteCartForUser(user.pubkey, signer, ndk)

			return user
		} catch (error) {
			authStore.setState((state) => ({
				...state,
				isAuthenticated: false,
			}))
			throw error
		} finally {
			authStore.setState((state) => ({ ...state, isAuthenticating: false }))
		}
	},

	logout: () => {
		const ndk = ndkActions.getNDK()
		if (!ndk) return
		ndkActions.removeSigner()
		localStorage.removeItem(NOSTR_LOCAL_SIGNER_KEY)
		localStorage.removeItem(NOSTR_CONNECT_KEY)
		localStorage.removeItem(NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY)
		localStorage.removeItem(NOSTR_AUTO_LOGIN)
		localStorage.removeItem(NOSTR_GOBLIN_PUBKEY)
		clearSessionPrivateKey()
		// Clear cart when user logs out
		cartActions.clear({ publishRemote: false, reason: 'logout' })
		authStore.setState(() => initialState)
	},

	userHasProducts: async (): Promise<boolean> => {
		const state = authStore.state
		if (!state.user) return false

		try {
			const products = await fetchProductsByPubkey(state.user.pubkey)
			return products.length > 0
		} catch (error) {
			console.error('Failed to check user products:', error)
			return false
		}
	},

	getNeedsMigration: (): boolean => {
		const authData = localStorage.getItem(NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY)

		if (authData) {
			const privateKey = authData.split(':').at(1)

			// Validate if private key has been stored in raw format ("nsec...")
			try {
				if (privateKey?.startsWith('nsec') && nip19.decode(privateKey).type === 'nsec') {
					return true
				}
			} catch {
				// Silence decode errors since migration is not possible.
			}
		}

		return false
	},

	migrateToEncryptedKey: async (password: string) => {
		try {
			authStore.setState((state) => ({ ...state, isAuthenticating: true }))

			// Get the unencrypted private key
			const authData = localStorage.getItem(NOSTR_LOCAL_ENCRYPTED_SIGNER_KEY)
			const privateKey = authData?.split(':').at(1)

			if (!privateKey) {
				throw new Error('No private key found to migrate')
			}

			authActions.encryptAndSavePrivateKey(privateKey, password)

			// Update auth state
			authStore.setState((state) => ({
				...state,
				needsMigration: false,
				needsDecryptionPassword: false,
			}))

			// Continue with login using the unencrypted key (it will be wiped after)
			await authActions.loginWithPrivateKey(privateKey)
			// Cache for the session so a refresh skips the expensive derivation.
			cacheSessionPrivateKey(privateKey)
		} catch (error) {
			console.error('Migration failed:', error)
			throw error
		} finally {
			authStore.setState((state) => ({ ...state, isAuthenticating: false }))
		}
	},
}

export const useAuth = () => {
	return {
		...authStore.state,
		...authActions,
	}
}
