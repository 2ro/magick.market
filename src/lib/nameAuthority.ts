/**
 * Thin fetch client over the Goblin name authority (goblin-nip05d) transfer API
 * (name-transfer-spec section 6). Every write is NIP-98 signed by the acting key
 * over the EXACT absolute URL it fetches. Reads are public and CORS `*`.
 *
 * The client never verifies proofs or decides "paid": it relays the authority's
 * status and error code so the UI can map a human message.
 */
import type { NDKSigner } from '@nostr-dev-kit/ndk'
import { buildNip98AuthHeader } from './nip98'
import {
	AuthorityErrorSchema,
	ByPubkeyResponseSchema,
	ClaimResponseSchema,
	LodgeOfferResponseSchema,
	OfferReadResponseSchema,
	RevokeOfferResponseSchema,
	type ByPubkeyResponse,
	type ClaimResponse,
	type LodgeOfferResponse,
	type OfferReadResponse,
	type PaymentProof,
	type RevokeOfferResponse,
} from './schemas/nameTransfer'

/** Strip any trailing slash so path joins produce a single, canonical URL. */
function normalizeBase(base: string): string {
	return base.replace(/\/+$/, '')
}

/**
 * A failed authority call, carrying the HTTP status and the authority's error
 * code string (from `{"error": "..."}`) so callers can map a human message via
 * lodgeErrorMessage / claimErrorMessage.
 */
export class AuthorityError extends Error {
	status: number
	errorCode?: string
	constructor(status: number, errorCode?: string) {
		super(errorCode ? `authority ${status}: ${errorCode}` : `authority ${status}`)
		this.name = 'AuthorityError'
		this.status = status
		this.errorCode = errorCode
	}
}

/** Parse the authority's `{"error": "..."}` body, tolerating an empty/non-JSON body. */
async function readErrorCode(res: Response): Promise<string | undefined> {
	try {
		const json = await res.json()
		const parsed = AuthorityErrorSchema.safeParse(json)
		return parsed.success ? parsed.data.error : undefined
	} catch {
		return undefined
	}
}

/**
 * Seller-side detection (spec section 5, check 11 reuse): does this pubkey hold a
 * name on the authority? 200 -> the record; 404 -> null; anything else throws.
 */
export async function getNameByPubkey(base: string, pubkeyHex: string): Promise<ByPubkeyResponse | null> {
	const url = `${normalizeBase(base)}/api/v1/by-pubkey/${pubkeyHex}`
	const res = await fetch(url, { headers: { accept: 'application/json' } })
	if (res.status === 404) return null
	if (!res.ok) throw new AuthorityError(res.status, await readErrorCode(res))
	return ByPubkeyResponseSchema.parse(await res.json())
}

/**
 * Lodge a signed kind-3402 offer (seller NIP-98). Body: `{"offer": <event>}`.
 * `signedOfferEvent` is the raw event JSON object (id + sig present).
 */
export async function lodgeOffer(base: string, signedOfferEvent: unknown, signer: NDKSigner, ndk?: unknown): Promise<LodgeOfferResponse> {
	const url = `${normalizeBase(base)}/api/v1/transfer/offer`
	const body = JSON.stringify({ offer: signedOfferEvent })
	const authorization = await buildNip98AuthHeader({ signer, ndk, url, method: 'POST', body })
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization },
		body,
	})
	if (!res.ok) throw new AuthorityError(res.status, await readErrorCode(res))
	return LodgeOfferResponseSchema.parse(await res.json())
}

/** Public read of an offer's authoritative status (spec section 6). 404 -> null. */
export async function getOffer(base: string, offerId: string): Promise<OfferReadResponse | null> {
	const url = `${normalizeBase(base)}/api/v1/transfer/offer/${offerId}`
	const res = await fetch(url, { headers: { accept: 'application/json' } })
	if (res.status === 404) return null
	if (!res.ok) throw new AuthorityError(res.status, await readErrorCode(res))
	return OfferReadResponseSchema.parse(await res.json())
}

/** Revoke a live offer (seller NIP-98 DELETE; the `u` tag path includes the offer id). */
export async function revokeOffer(base: string, offerId: string, signer: NDKSigner, ndk?: unknown): Promise<RevokeOfferResponse> {
	const url = `${normalizeBase(base)}/api/v1/transfer/offer/${offerId}`
	const authorization = await buildNip98AuthHeader({ signer, ndk, url, method: 'DELETE' })
	const res = await fetch(url, { method: 'DELETE', headers: { authorization } })
	if (!res.ok) throw new AuthorityError(res.status, await readErrorCode(res))
	return RevokeOfferResponseSchema.parse(await res.json())
}

/**
 * Submit a buyer claim (buyer NIP-98, payload hash mandatory). Body:
 * `{offer_id, proof}`. Returns the new record on 201/200 (idempotent retry).
 */
export async function submitClaim(
	base: string,
	offerId: string,
	proof: PaymentProof,
	signer: NDKSigner,
	ndk?: unknown,
): Promise<ClaimResponse> {
	const url = `${normalizeBase(base)}/api/v1/transfer/claim`
	const body = JSON.stringify({ offer_id: offerId, proof })
	const authorization = await buildNip98AuthHeader({ signer, ndk, url, method: 'POST', body })
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization },
		body,
	})
	if (!res.ok) throw new AuthorityError(res.status, await readErrorCode(res))
	return ClaimResponseSchema.parse(await res.json())
}
