import { decryptAsync } from './nip49Async'

// Web Worker: runs the NIP-49 scrypt derivation off the main thread so unlocking
// an encrypted key never freezes the UI. Receives { ncryptsec, password }, posts
// back the decrypted secret-key bytes (or an error message).
//
// Typed via a minimal cast rather than `/// <reference lib="webworker" />` so we
// don't pull lib.webworker into the DOM-typed project (which conflicts with
// lib.dom). This file is bundled standalone by `bun run build:worker`.
const workerScope = self as unknown as {
	onmessage: ((event: MessageEvent<{ ncryptsec: string; password: string }>) => void) | null
	postMessage: (message: unknown) => void
}

workerScope.onmessage = async (event) => {
	const { ncryptsec, password } = event.data
	try {
		const key = await decryptAsync(ncryptsec, password)
		workerScope.postMessage({ ok: true, key })
	} catch (error) {
		workerScope.postMessage({ ok: false, error: error instanceof Error ? error.message : 'decrypt failed' })
	}
}
