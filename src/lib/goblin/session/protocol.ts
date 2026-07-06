/**
 * Goblin "Authorize Sessions" (Authorize v2) - browser-side protocol primitives.
 *
 * This is the wire seam shared with the Goblin wallet. Everything here is pure
 * and unit-testable without a running relay or GUI: the trust URI shape, the
 * NIP-44 envelope encode/decode, the client-pinned event stripping, and the
 * low-tier kind set the site is allowed to request. The live relay client lives
 * in GoblinSessionChannel.ts; the NDK signer in GoblinAuthorizeSigner.ts.
 *
 * SPEC: docs-notes/goblin-authorize-sessions-spec.md, sections 5.1-5.9.
 */

import { finalizeEvent, getPublicKey, nip44 } from 'nostr-tools'
import type { Event } from 'nostr-tools'

/**
 * The stored, addressed, NIP-44-encrypted channel event kind (spec section 12,
 * open question 1 recommendation). Direction and type live in the plaintext,
 * with a NIP-40 `expiration` tag on the envelope so a request sent while the
 * wallet is backgrounded waits on the relay instead of being dropped.
 */
export const GOBLIN_SESSION_CHANNEL_KIND = 24140

/** NIP-42 login kind. Never signed via a session, ever (spec section 5.5 ceiling). */
export const GOBLIN_LOGIN_EVENT_KIND = 22242

/** Accepted |ts - now| and |created_at - now| skew, seconds (spec 5.4, reused from login). */
export const CREATED_AT_SKEW_SECONDS = 300

/** How long a channel request envelope stays valid on the relay (NIP-40), seconds. */
export const REQUEST_EXPIRATION_SECONDS = 120

/**
 * The LOW-tier kinds magick asks to sign silently under a trust grant (spec
 * section 5.5, "the magick low-tier working set from finding B"). Kind 17
 * (payment receipt / value-granting registration) and every other money-tier
 * kind are DELIBERATELY absent: they belong to the wallet's per-action money
 * prompt, never the silent set. Kind 22242 (login) is never here either.
 */
export const MAGICK_LOW_TIER_KINDS: readonly number[] = [
	0, // profile metadata
	1, // text post
	5, // delete (NIP-09)
	7, // reaction
	13, // seal (NIP-17)
	14, // order DM (rumor)
	16, // order DM (event)
	1059, // gift wrap (NIP-59)
	1111, // comment (NIP-22)
	10000, // mute list
	30000, // follow / people set
	30003, // bookmark set
	30078, // app data (cart)
	30402, // listing (NIP-99 / Gamma)
	30405, // collection
	30406, // shipping option
	31990, // handler advertisement (NIP-89)
	24242, // Blossom upload auth (HTTP-auth, returned to browser)
	27235, // NIP-98 HTTP auth (returned to browser)
]

/** The typed refusal codes the wallet returns on the channel (spec section 7). */
export type GoblinSessionErrorCode =
	| 'user_declined'
	| 'kind_not_in_session'
	| 'identity_mismatch'
	| 'stale_request'
	| 'too_large'
	| 'session_paused'
	| 'session_ended'
	| 'timed_out'

/** The event the client composed, minus id and sig (spec section 5.4). */
export interface UnsignedComposedEvent {
	pubkey: string
	created_at: number
	kind: number
	tags: string[][]
	content: string
}

/** Sign request payload (site -> wallet), spec section 5.4. */
export interface SignRequestPayload {
	type: 'sign'
	id: string
	ts: number
	event: UnsignedComposedEvent
}

/** Sign response payload (wallet -> site), spec section 5.4. */
export type SignResultPayload =
	| { type: 'sign_result'; id: string; ok: true; event: Event }
	| { type: 'sign_result'; id: string; ok: false; error: GoblinSessionErrorCode }

/**
 * NIP-44 encrypt request (site -> wallet), seam extension (coordinator ruling):
 * the wallet encrypts `plaintext` from the session identity to `peer_pubkey`.
 * The wallet inspects the plaintext (a kind 14/16 order message can commit a
 * payment) and MAY answer only after its money-tier password prompt, so an
 * encrypt, like a sign, can sit in the "confirm in your wallet" state.
 */
export interface EncryptRequestPayload {
	type: 'encrypt'
	id: string
	ts: number
	peer_pubkey: string
	plaintext: string
}

export type EncryptResultPayload =
	| { type: 'encrypt_result'; id: string; ok: true; ciphertext: string }
	| { type: 'encrypt_result'; id: string; ok: false; error: GoblinSessionErrorCode }

/** NIP-44 decrypt request (site -> wallet): `ciphertext` from `peer_pubkey` to the identity. */
export interface DecryptRequestPayload {
	type: 'decrypt'
	id: string
	ts: number
	peer_pubkey: string
	ciphertext: string
}

export type DecryptResultPayload =
	| { type: 'decrypt_result'; id: string; ok: true; plaintext: string }
	| { type: 'decrypt_result'; id: string; ok: false; error: GoblinSessionErrorCode }

/** Channel opened by the wallet after the trust grant (spec section 5.2 step 3). */
export interface SessionOpenPayload {
	type: 'session-open'
	id: string
	/** The chosen signing identity. The wallet session pubkey IS the envelope pubkey. */
	identity_pubkey: string
}

/** Either side tears the session down (spec section 6, items 1 and 2). */
export interface SessionEndPayload {
	type: 'session-end'
	id: string
	reason: 'logout' | 'revoked' | 'expired'
}

export type ChannelPayload =
	| SignRequestPayload
	| SignResultPayload
	| EncryptRequestPayload
	| EncryptResultPayload
	| DecryptRequestPayload
	| DecryptResultPayload
	| SessionOpenPayload
	| SessionEndPayload

/** The wallet -> site answer payloads correlated by request id. */
export type ChannelResultPayload = SignResultPayload | EncryptResultPayload | DecryptResultPayload

const HEX64_RE = /^[0-9a-f]{64}$/i

export function isHex64(value: unknown): value is string {
	return typeof value === 'string' && HEX64_RE.test(value)
}

/** Generate an ephemeral channel keypair. NEVER the user's identity key (spec 5.2 step 1). */
export function generateChannelKeypair(): { privateKey: Uint8Array; publicKey: string } {
	const privateKey = new Uint8Array(32)
	crypto.getRandomValues(privateKey)
	return { privateKey, publicKey: getPublicKey(privateKey) }
}

export function uuid(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function unixNow(): number {
	return Math.floor(Date.now() / 1000)
}

/**
 * Build the `goblin:trust` URI the site hands the wallet (spec section 5.9).
 * The login fields (c, d, cb) fold in the Build 150 login; sk/r/k add the
 * session parameters. `k` is the requested LOW-tier kind set; the wallet strips
 * any money-tier kind (and 22242) before storing it as the silent set.
 */
export function buildTrustUri(params: {
	challenge: string
	domain: string
	callbackUrl: string
	siteSessionPubkey: string
	relayHint: string
	kinds: readonly number[]
}): string {
	const { challenge, domain, callbackUrl, siteSessionPubkey, relayHint, kinds } = params
	const k = Array.from(new Set(kinds)).join(',')
	const query = [
		`c=${challenge}`,
		`d=${domain}`,
		`cb=${encodeURIComponent(callbackUrl)}`,
		`sk=${siteSessionPubkey}`,
		`r=${encodeURIComponent(relayHint)}`,
		`k=${k}`,
	].join('&')
	return `goblin:trust?${query}`
}

/**
 * Strip id and sig from an event NDK composed, keeping exactly the fields the
 * wallet needs to recompute the NIP-01 id and sign (spec section 5.4 finding A):
 * pubkey, created_at, kind, tags, content. The wallet owns id and sig; the
 * client owns created_at. We NEVER send a client id or sig.
 */
export function toUnsignedComposedEvent(event: {
	pubkey: string
	created_at: number
	kind: number
	tags: string[][]
	content: string
}): UnsignedComposedEvent {
	return {
		pubkey: event.pubkey,
		created_at: event.created_at,
		kind: event.kind,
		tags: event.tags,
		content: event.content,
	}
}

/** Derive the NIP-44 conversation key for this channel leg. */
export function conversationKey(myPrivateKey: Uint8Array, theirPublicKey: string): Uint8Array {
	return nip44.v2.utils.getConversationKey(myPrivateKey, theirPublicKey)
}

/**
 * Seal a payload into a signed, NIP-44-encrypted channel envelope addressed to
 * the recipient's session key. `senderPrivateKey` is an ephemeral channel key,
 * so the envelope is signed by a session key, never the identity key.
 */
export function sealEnvelope(params: {
	payload: ChannelPayload
	senderPrivateKey: Uint8Array
	recipientPublicKey: string
	convKey: Uint8Array
	expirationSeconds?: number
	createdAt?: number
}): Event {
	const { payload, senderPrivateKey, recipientPublicKey, convKey } = params
	const createdAt = params.createdAt ?? unixNow()
	const expiration = createdAt + (params.expirationSeconds ?? REQUEST_EXPIRATION_SECONDS)
	const content = nip44.v2.encrypt(JSON.stringify(payload), convKey)
	return finalizeEvent(
		{
			kind: GOBLIN_SESSION_CHANNEL_KIND,
			created_at: createdAt,
			tags: [
				['p', recipientPublicKey],
				['expiration', String(expiration)],
			],
			content,
		},
		senderPrivateKey,
	)
}

/**
 * Open a channel envelope: decrypt with the conversation key and parse the
 * plaintext payload. Returns null on any failure (fail closed, spec 5.8). The
 * caller must still bind the envelope to `site_session_pubkey`/wallet key and
 * enforce skew before acting.
 */
export function openEnvelope(event: Pick<Event, 'content'>, convKey: Uint8Array): ChannelPayload | null {
	try {
		const plaintext = nip44.v2.decrypt(event.content, convKey)
		const parsed = JSON.parse(plaintext) as unknown
		if (!parsed || typeof parsed !== 'object') return null
		const type = (parsed as { type?: unknown }).type
		if (
			type === 'sign' ||
			type === 'sign_result' ||
			type === 'encrypt' ||
			type === 'encrypt_result' ||
			type === 'decrypt' ||
			type === 'decrypt_result' ||
			type === 'session-open' ||
			type === 'session-end'
		) {
			return parsed as ChannelPayload
		}
		return null
	} catch {
		return null
	}
}

/** True if the two timestamps are within the accepted skew window (spec 5.4). */
export function withinSkew(ts: number, now: number = unixNow()): boolean {
	return Number.isFinite(ts) && Math.abs(ts - now) <= CREATED_AT_SKEW_SECONDS
}
