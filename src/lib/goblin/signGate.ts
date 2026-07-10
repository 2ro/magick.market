import { authActions, authStore } from '@/lib/stores/auth'
import { uiActions, uiStore } from '@/lib/stores/ui'

/**
 * Thrown when a signing operation needed a signer, the re-authorization prompt was
 * shown, and the user dismissed it without granting one. Callers treat this as a
 * benign cancel (no error toast) rather than a real failure.
 */
export class SigningCancelledError extends Error {
	// Structural brand: without a member Error lacks, this class would be
	// structurally identical to Error, and the `error is SigningCancelledError`
	// predicate below would narrow its false branch to `never` at every call site.
	readonly isSigningCancelledError = true as const

	constructor(message = 'Signing was cancelled') {
		super(message)
		this.name = 'SigningCancelledError'
	}
}

/** True for a cancel raised by {@link ensureCanSign} (matched by name to survive bundling). */
export const isSigningCancelled = (error: unknown): error is SigningCancelledError =>
	error instanceof SigningCancelledError || (error instanceof Error && error.name === 'SigningCancelledError')

/**
 * Gate for every client-side signing operation.
 *
 * Resolves immediately when the current session can sign. Otherwise — a
 * wallet-verified view-only Goblin session, an expired session window, or a
 * wallet-ended session — it opens the login dialog so the user can re-authorize
 * with their wallet (the owner's "bring me back to the wallet if we need to sign
 * something" expectation; on mobile the Goblin tab deep-links to the wallet app)
 * and resolves the instant a signer becomes available. Because the caller's
 * in-flight async action simply awaits this promise, it resumes exactly where it
 * left off after re-auth — no form state is lost and the action is retried
 * automatically, with no separate pending-action queue.
 *
 * Rejects with {@link SigningCancelledError} if the user closes the dialog without
 * granting a signer, so callers can suppress the generic error toast for a cancel.
 */
export function ensureCanSign(): Promise<void> {
	if (authActions.canSignNow()) return Promise.resolve()

	return new Promise<void>((resolve, reject) => {
		let settled = false
		const finish = (run: () => void) => {
			if (settled) return
			settled = true
			authSub.unsubscribe()
			uiSub.unsubscribe()
			run()
		}

		// A signer became available (wallet trust re-established, or the user logged
		// in with a key/extension): resume the pending action.
		const authSub = authStore.subscribe(() => {
			if (authActions.canSignNow()) finish(resolve)
		})

		// The login dialog was closed while still unable to sign: the user cancelled.
		// Subscribing before openDialog means the open transition itself is ignored
		// (dialogs.login is true then), and only a later close resolves the cancel.
		const uiSub = uiStore.subscribe(() => {
			if (!uiStore.state.dialogs.login && !authActions.canSignNow()) {
				finish(() => reject(new SigningCancelledError()))
			}
		})

		uiActions.openDialog('login')
	})
}
