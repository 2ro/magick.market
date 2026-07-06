/**
 * React Query hooks for the NIP-05 name-transfer marketplace
 * (name-transfer-spec sections 3, 4, 5, 6, 9).
 *
 * Reads: held-name detection (by-pubkey), a polling-capable offer status read,
 * and the buyer's incoming kind-3402 offers from Nostr. Writes: lodge (seller),
 * revoke (seller), claim (buyer). magick never touches the money; these hooks
 * only build/publish/read offers and submit the claim to the authority.
 */
import { NAME_AUTHORITY_URL } from '@/lib/constants'
import { buildTransferOfferEvent, extractOffer, type TransferOfferView } from '@/lib/nameTransfer'
import { getNameByPubkey, getOffer, lodgeOffer, revokeOffer, submitClaim } from '@/lib/nameAuthority'
import { ndkActions } from '@/lib/stores/ndk'
import type { PaymentProof } from '@/lib/schemas/nameTransfer'
import { NDKEvent, type NDKFilter } from '@nostr-dev-kit/ndk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { nameTransferKeys } from './queryKeyFactory'
import { TRANSFER_OFFER_KIND } from '@/lib/schemas/nameTransfer'

const FIVE_MINUTES = 5 * 60 * 1000

/**
 * Does this pubkey currently hold a name on the authority? Used both for
 * seller-side detection (default authority) and the buyer's pre-payment
 * pre-check on the offer's own authority (pass its `base`).
 */
export function useHeldName(pubkey: string | undefined, base: string = NAME_AUTHORITY_URL) {
	return useQuery({
		queryKey: nameTransferKeys.heldName(`${base}|${pubkey ?? ''}`),
		queryFn: () => getNameByPubkey(base, pubkey as string),
		enabled: !!pubkey,
		staleTime: FIVE_MINUTES,
	})
}

/**
 * Authoritative status of a single offer (spec section 6 read). Polls while
 * `refetchIntervalMs` is set so a buyer sees revoke/expire/consume promptly.
 */
export function useTransferOffer(offerId: string | undefined, base: string, refetchIntervalMs?: number) {
	return useQuery({
		queryKey: nameTransferKeys.offer(base, offerId ?? ''),
		queryFn: () => getOffer(base, offerId as string),
		enabled: !!offerId && !!base,
		refetchInterval: refetchIntervalMs,
		staleTime: 0,
	})
}

/**
 * The buyer's incoming sale offers: kind-3402 events on Nostr with `#p` equal to
 * my pubkey. Rendered from Nostr; the component confirms authoritative status
 * per offer via useTransferOffer against the offer's own domain authority.
 */
export function useIncomingOffers(pubkey: string | undefined) {
	return useQuery({
		queryKey: nameTransferKeys.incomingOffers(pubkey ?? ''),
		enabled: !!pubkey,
		staleTime: 60 * 1000,
		queryFn: async (): Promise<TransferOfferView[]> => {
			const filter = { kinds: [TRANSFER_OFFER_KIND], '#p': [pubkey as string] } as unknown as NDKFilter
			const events = await ndkActions.fetchEventsWithTimeout(filter)
			const offers: TransferOfferView[] = []
			for (const event of Array.from(events)) {
				const view = extractOffer(event.rawEvent() as never)
				if (view) offers.push(view)
			}
			// Newest first.
			return offers.sort((a, b) => b.expiration - a.expiration)
		},
	})
}

export interface LodgeOfferInput {
	name: string
	domain: string
	buyerPubkeyHex: string
	priceNanogrin: string
	proofAddress: string
	expiration: number
	/** Authority base URL to lodge at (defaults to NAME_AUTHORITY_URL). */
	base?: string
}

/**
 * Seller flow: build + sign the kind-3402 offer, publish it to the app relays so
 * the buyer can see it on Nostr, then lodge it at the authority (spec section 9).
 */
export function useLodgeOffer() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (input: LodgeOfferInput) => {
			const ndk = ndkActions.getNDK()
			const signer = ndkActions.getSigner()
			if (!ndk) throw new Error('NDK not initialized')
			if (!signer) throw new Error('You must be signed in to sell a name')

			const base = input.base ?? NAME_AUTHORITY_URL
			const template = buildTransferOfferEvent({
				name: input.name,
				domain: input.domain,
				buyerPubkeyHex: input.buyerPubkeyHex,
				priceNanogrin: input.priceNanogrin,
				proofAddress: input.proofAddress,
				expiration: input.expiration,
			})

			const event = new NDKEvent(ndk)
			event.kind = template.kind
			event.content = template.content
			event.tags = template.tags
			await event.sign(signer)

			// Publish to the app relays so the targeted buyer can discover the offer.
			await ndkActions.publishEvent(event)

			// Lodge at the authority (pre-lodge is required before payment).
			const response = await lodgeOffer(base, event.rawEvent(), signer, ndk)
			return { offerId: event.id, base, response, offer: extractOffer(event.rawEvent() as never) }
		},
		onSuccess: async (result) => {
			const seller = (await ndkActions.getUser())?.pubkey
			if (seller) queryClient.invalidateQueries({ queryKey: nameTransferKeys.heldName(`${result.base}|${seller}`) })
			queryClient.invalidateQueries({ queryKey: nameTransferKeys.offer(result.base, result.offerId) })
		},
	})
}

/** Seller flow: revoke a live offer via the authority DELETE endpoint. */
export function useRevokeOffer() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async ({ base, offerId }: { base: string; offerId: string }) => {
			const ndk = ndkActions.getNDK()
			const signer = ndkActions.getSigner()
			if (!ndk) throw new Error('NDK not initialized')
			if (!signer) throw new Error('You must be signed in to revoke an offer')
			return revokeOffer(base, offerId, signer, ndk)
		},
		onSuccess: (_res, { base, offerId }) => {
			queryClient.invalidateQueries({ queryKey: nameTransferKeys.offer(base, offerId) })
			queryClient.invalidateQueries({ queryKey: nameTransferKeys.all })
		},
	})
}

/**
 * Buyer flow: submit the payment-proof claim to the authority. On success the
 * name resolves to the buyer, so refresh the buyer's held-name state.
 */
export function useSubmitClaim() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async ({ base, offerId, proof }: { base: string; offerId: string; proof: PaymentProof }) => {
			const ndk = ndkActions.getNDK()
			const signer = ndkActions.getSigner()
			if (!ndk) throw new Error('NDK not initialized')
			if (!signer) throw new Error('You must be signed in to claim a name')
			return submitClaim(base, offerId, proof, signer, ndk)
		},
		onSuccess: async (_res, { base, offerId }) => {
			const buyer = (await ndkActions.getUser())?.pubkey
			if (buyer) queryClient.invalidateQueries({ queryKey: nameTransferKeys.heldName(`${base}|${buyer}`) })
			queryClient.invalidateQueries({ queryKey: nameTransferKeys.offer(base, offerId) })
		},
	})
}
