import { scryptAsync } from '@noble/hashes/scrypt.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { bech32 } from '@scure/base'

/**
 * Async NIP-49 (ncryptsec) decryption.
 *
 * Mirrors `nostr-tools/nip49`'s `decrypt` but uses `@noble/hashes`' `scryptAsync`
 * so it can be awaited. Output is byte-for-byte identical to nostr-tools, so
 * blobs produced by the app's existing `encrypt` path decrypt unchanged.
 *
 * Note: `scryptAsync` only yields to the microtask queue (noble's `nextTick` is
 * an empty async fn), so on the main thread it still blocks rendering. This is
 * the in-thread fallback; `decryptInWorker` is the responsive path — it runs
 * this same logic inside a Web Worker.
 */
export async function decryptAsync(ncryptsec: string, password: string): Promise<Uint8Array> {
	const { prefix, words } = bech32.decode(ncryptsec, 5000)
	if (prefix !== 'ncryptsec') {
		throw new Error(`invalid prefix ${prefix}, expected 'ncryptsec'`)
	}
	const b = new Uint8Array(bech32.fromWords(words))
	const version = b[0]
	if (version !== 2) {
		throw new Error(`invalid version ${version}, expected 0x02`)
	}
	const logn = b[1]
	const n = 2 ** logn
	const salt = b.slice(2, 2 + 16)
	const nonce = b.slice(2 + 16, 2 + 16 + 24)
	const ksb = b[2 + 16 + 24]
	const aad = Uint8Array.from([ksb])
	const ciphertext = b.slice(2 + 16 + 24 + 1)
	const key = await scryptAsync(password.normalize('NFKC'), salt, { N: n, r: 8, p: 1, dkLen: 32 })
	const xc2p1 = xchacha20poly1305(key, nonce, aad)
	return xc2p1.decrypt(ciphertext)
}

// Self-contained worker bundle, built from ./nip49.worker.ts into public/ at
// build time (see the `build:worker` script) and served at the site root. We
// load it by absolute URL rather than `new URL('./nip49.worker.ts', import.meta.url)`
// because Bun's bundler rewrites import.meta.url to a file:// source path, which
// the browser refuses to load cross-origin.
export const NIP49_WORKER_URL = '/nip49.worker.js'

/**
 * Decrypt a NIP-49 ncryptsec off the main thread via a Web Worker.
 *
 * The scrypt KDF is CPU-heavy (~0.5-3s at logN 18) and, even via
 * `scryptAsync`, only yields to the microtask queue — so on the main thread it
 * still blocks rendering and freezes the UI. Running it in a worker keeps the
 * page responsive (spinner animates, no "page unresponsive"). Falls back to the
 * in-thread `decryptAsync` when workers are unavailable (SSR, tests) or fail to
 * load, so behaviour degrades gracefully rather than breaking login.
 */
export function decryptInWorker(ncryptsec: string, password: string): Promise<Uint8Array> {
	if (typeof Worker === 'undefined' || typeof document === 'undefined') {
		return decryptAsync(ncryptsec, password)
	}

	return new Promise<Uint8Array>((resolve, reject) => {
		let worker: Worker
		try {
			worker = new Worker(NIP49_WORKER_URL, { type: 'module' })
		} catch {
			decryptAsync(ncryptsec, password).then(resolve, reject)
			return
		}

		let settled = false
		const done = (fn: () => void) => {
			if (settled) return
			settled = true
			worker.terminate()
			fn()
		}

		worker.onmessage = (event: MessageEvent<{ ok: boolean; key?: Uint8Array; error?: string }>) => {
			const { ok, key, error } = event.data
			if (ok && key) done(() => resolve(new Uint8Array(key)))
			else done(() => reject(new Error(error || 'decrypt failed')))
		}

		// If the worker itself fails to load/run, fall back to in-thread decryption
		// rather than failing the login outright.
		worker.onerror = () => done(() => decryptAsync(ncryptsec, password).then(resolve, reject))

		worker.postMessage({ ncryptsec, password })
	})
}
