/**
 * Browser-side HTTP-auth builders for a Goblin trust session (spec section 5.7).
 *
 * Kinds 27235 (NIP-98) and 24242 (Blossom upload auth) are NOT relay events: the
 * signed event must come back TO THE BROWSER so it can build an `Authorization`
 * header. The session channel is browser-facing by construction, so these are
 * handled by the ordinary silent sign path (both kinds are low tier) and then
 * base64-wrapped here. This is the honest advantage over v1's server-callback:
 * image uploads and name-registration HTTP calls work.
 *
 * Both builders take an NDKSigner, so they work with the GoblinAuthorizeSigner
 * (routing through the wallet) or any other signer, and pin created_at
 * client-side exactly as NDK would.
 */

import { NDKUser, type NDKSigner } from '@nostr-dev-kit/ndk'
import { getEventHash } from 'nostr-tools'
import type { Event } from 'nostr-tools'

export const NIP98_HTTP_AUTH_KIND = 27235
export const BLOSSOM_AUTH_KIND = 24242

/** Base64 of a UTF-8 string, browser and Bun safe. */
function base64Utf8(value: string): string {
	if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(value)))
	return Buffer.from(value, 'utf-8').toString('base64')
}

async function signComposed(
	signer: NDKSigner,
	template: { kind: number; tags: string[][]; content: string },
	createdAt: number,
): Promise<Event> {
	const user = await signer.user()
	const composed = {
		pubkey: user.pubkey,
		created_at: createdAt,
		kind: template.kind,
		tags: template.tags,
		content: template.content,
	}
	const sig = await signer.sign(composed as Parameters<NDKSigner['sign']>[0])
	return { ...composed, id: getEventHash(composed), sig }
}

/** The `Authorization: Nostr <base64 event>` header value both schemes use. */
export function toNostrAuthHeader(signedEvent: Event): string {
	return `Nostr ${base64Utf8(JSON.stringify(signedEvent))}`
}

/**
 * Build a NIP-98 (kind 27235) HTTP-auth event and its Authorization header for a
 * request to `url` with the given method. `payloadSha256` is the hex hash of the
 * request body when there is one (NIP-98's optional `payload` tag).
 */
export async function buildNip98Auth(params: {
	signer: NDKSigner
	url: string
	method: string
	payloadSha256?: string
	createdAt?: number
}): Promise<{ event: Event; header: string }> {
	const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000)
	const tags: string[][] = [
		['u', params.url],
		['method', params.method.toUpperCase()],
	]
	if (params.payloadSha256) tags.push(['payload', params.payloadSha256])
	const event = await signComposed(params.signer, { kind: NIP98_HTTP_AUTH_KIND, tags, content: '' }, createdAt)
	return { event, header: toNostrAuthHeader(event) }
}

/**
 * Build a Blossom (kind 24242) upload-authorization event and its Authorization
 * header. `verb` is the Blossom action (e.g. "upload"), `sha256` the hex hash of
 * the blob, `expirationSeconds` the NIP-40-style validity window.
 */
export async function buildBlossomAuth(params: {
	signer: NDKSigner
	verb: string
	sha256: string
	description?: string
	expirationSeconds?: number
	createdAt?: number
}): Promise<{ event: Event; header: string }> {
	const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000)
	const expiration = createdAt + (params.expirationSeconds ?? 300)
	const tags: string[][] = [
		['t', params.verb],
		['x', params.sha256],
		['expiration', String(expiration)],
	]
	const event = await signComposed(
		params.signer,
		{ kind: BLOSSOM_AUTH_KIND, tags, content: params.description ?? `${params.verb} ${params.sha256}` },
		createdAt,
	)
	return { event, header: toNostrAuthHeader(event) }
}

/** Convenience for callers that only have a hex pubkey (kept parallel to nip59). */
export function userFromPubkey(pubkey: string): NDKUser {
	return new NDKUser({ pubkey })
}
