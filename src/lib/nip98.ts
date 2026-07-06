/**
 * NIP-98 HTTP Auth header builder for the Goblin name authority (goblin-nip05d).
 *
 * The authority authenticates transfer writes with a NIP-98 event exactly as it
 * already authenticates registration (goblin-nip05d/src/auth.rs): a kind-27235
 * event, base64-encoded, sent as `Authorization: Nostr <base64>`. The authority
 * checks, per auth.rs:
 *  - kind == 27235
 *  - created_at within a 60s freshness window
 *  - a `u` tag equal to the exact absolute request URL (base + path, no trailing slash)
 *  - a `method` tag equal to the uppercase HTTP method
 *  - a `payload` tag equal to the lowercase hex sha256 of the exact request body
 *    bytes, REQUIRED whenever the body is non-empty
 *  - the event id is single-use (replay set)
 *
 * The event must be signed by the acting key (seller for lodge/revoke, buyer for
 * claim). NDK 3.0.3 ships no NIP-98 helper, so this hand-rolls the event and is
 * unit-tested for shape and payload-hash correctness.
 */
import type { NDKSigner } from '@nostr-dev-kit/ndk'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

/** Kind for NIP-98 HTTP Auth events. */
export const NIP98_KIND = 27235

/** Lowercase hex sha256 of a request body string (UTF-8 bytes). */
export function payloadHashHex(body: string): string {
	return bytesToHex(sha256(utf8ToBytes(body)))
}

/**
 * Build the unsigned tag set for a NIP-98 auth event. Exposed for unit tests.
 * `u` is the exact absolute URL that will be fetched; `method` is uppercased;
 * a `payload` tag is added only when a non-empty body is present.
 */
export function buildNip98Tags(url: string, method: string, body?: string): string[][] {
	const tags: string[][] = [
		['u', url],
		['method', method.toUpperCase()],
	]
	if (body && body.length > 0) {
		tags.push(['payload', payloadHashHex(body)])
	}
	return tags
}

export interface Nip98Params {
	/** Signer for the acting key (seller or buyer). */
	signer: NDKSigner
	/** NDK instance to attach the event to. */
	ndk?: unknown
	/** The exact absolute URL that will be fetched. */
	url: string
	/** HTTP method (case-insensitive; serialized uppercase). */
	method: string
	/** The exact request body string, when the request carries one. */
	body?: string
}

/**
 * Build the `Authorization: Nostr <base64 event>` header value: sign a fresh
 * kind-27235 event over the given url/method/payload and base64-encode its JSON.
 * The `u` tag is signed over the exact absolute URL the caller will fetch.
 */
export async function buildNip98AuthHeader({ signer, ndk, url, method, body }: Nip98Params): Promise<string> {
	const event = new NDKEvent(ndk as never)
	event.kind = NIP98_KIND
	event.content = ''
	event.created_at = Math.floor(Date.now() / 1000)
	event.tags = buildNip98Tags(url, method, body)

	await event.sign(signer)

	const raw = JSON.stringify(event.rawEvent())
	return `Nostr ${base64Encode(raw)}`
}

/** Base64-encode a UTF-8 string, working in both browser and Bun/node. */
export function base64Encode(input: string): string {
	if (typeof btoa === 'function') {
		// btoa needs a binary string; encode UTF-8 bytes to latin1 first.
		const bytes = utf8ToBytes(input)
		let binary = ''
		for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
		return btoa(binary)
	}
	// Bun / Node
	return Buffer.from(input, 'utf-8').toString('base64')
}
