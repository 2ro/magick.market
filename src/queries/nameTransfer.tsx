/**
 * React Query hooks for the NIP-05 name-transfer marketplace.
 *
 * The resale is settled through the SAME GoblinPay rail as a first-time name
 * purchase: the seller mints a marketplace invoice and signs it into a kind-3402
 * offer; the buyer pays that invoice and the marketplace reassigns the name once
 * it confirms on-chain. No raw grin address is ever entered.
 *
 * Reads: held-name detection (this instance's own registry) and the buyer's
 * incoming kind-3402 offers from Nostr. Writes: create-offer (seller) and
 * submit-transfer (buyer).
 */
import { buildTransferOfferEvent, extractOffer, type TransferOfferView } from '@/lib/nameTransfer'
import { ndkActions } from '@/lib/stores/ndk'
import { NIP05_GRIN_RECIPIENT_PUBKEY } from '@/server/Nip05Manager'
import { NDKEvent, type NDKFilter, type NostrEvent } from '@nostr-dev-kit/ndk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { nameTransferKeys } from './queryKeyFactory'
import { TRANSFER_OFFER_KIND } from '@/lib/schemas/nameTransfer'

const FIVE_MINUTES = 5 * 60 * 1000

export interface HeldName {
	name: string
	pubkey: string
}

/**
 * Which NIP-05 name (if any) this pubkey holds in this instance's own registry.
 * Used for seller-side detection and the buyer's pre-check. 404 -> null.
 */
export function useHeldName(pubkey: string | undefined) {
	return useQuery({
		queryKey: nameTransferKeys.heldName(pubkey ?? ''),
		enabled: !!pubkey,
		staleTime: FIVE_MINUTES,
		queryFn: async (): Promise<HeldName | null> => {
			const res = await fetch(`/api/nip05/by-pubkey/${encodeURIComponent(pubkey as string)}`)
			if (res.status === 404) return null
			if (!res.ok) throw new Error('Could not check held name')
			return (await res.json()) as HeldName
		},
	})
}

export interface IncomingOffer {
	view: TransferOfferView
	/** The raw signed kind-3402 offer event, replayed to the claim endpoint. */
	rawEvent: NostrEvent
}

/**
 * The buyer's incoming sale offers: kind-3402 events on Nostr with `#p` equal to
 * my pubkey, each paired with its raw signed event for the claim.
 */
export function useIncomingOffers(pubkey: string | undefined) {
	return useQuery({
		queryKey: nameTransferKeys.incomingOffers(pubkey ?? ''),
		enabled: !!pubkey,
		staleTime: 60 * 1000,
		queryFn: async (): Promise<IncomingOffer[]> => {
			const filter = { kinds: [TRANSFER_OFFER_KIND], '#p': [pubkey as string] } as unknown as NDKFilter
			const events = await ndkActions.fetchEventsWithTimeout(filter)
			const offers: IncomingOffer[] = []
			for (const event of Array.from(events)) {
				const raw = event.rawEvent() as NostrEvent
				const view = extractOffer(raw as never)
				if (view) offers.push({ view, rawEvent: raw })
			}
			// Newest first.
			return offers.sort((a, b) => b.view.expiration - a.view.expiration)
		},
	})
}

export interface CreateTransferOfferInput {
	name: string
	domain: string
	buyerPubkeyHex: string
	/** Integer-nanogrin price string. */
	priceNanogrin: string
	expiration: number
	sellerPubkey: string
}

/**
 * Seller flow: mint a GoblinPay transfer invoice for the listed price, sign it
 * into a kind-3402 offer, and publish the offer to the app relays so the targeted
 * buyer can discover and pay it.
 */
export function useCreateTransferOffer() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (input: CreateTransferOfferInput) => {
			const ndk = ndkActions.getNDK()
			const signer = ndkActions.getSigner()
			if (!ndk) throw new Error('NDK not initialized')
			if (!signer) throw new Error('You must be signed in to sell a name')

			const res = await fetch('/api/transfer/invoice', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: input.name,
					sellerPubkey: input.sellerPubkey,
					buyerPubkey: input.buyerPubkeyHex,
					priceNanogrin: Number(input.priceNanogrin),
				}),
			})
			const data = await res.json()
			if (!res.ok) throw new Error(data?.error || 'Could not create a transfer invoice')

			const template = buildTransferOfferEvent({
				name: input.name,
				domain: input.domain,
				buyerPubkeyHex: input.buyerPubkeyHex,
				priceNanogrin: input.priceNanogrin,
				invoiceId: data.invoice_id,
				payUrl: data.pay_url,
				expiration: input.expiration,
			})

			const event = new NDKEvent(ndk)
			event.kind = template.kind
			event.content = template.content
			event.tags = template.tags
			await event.sign(signer)
			await ndkActions.publishEvent(event)

			return { offerId: event.id, invoiceId: data.invoice_id as string, payUrl: data.pay_url as string }
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: nameTransferKeys.all })
		},
	})
}

/**
 * Buyer flow: after the invoice confirms, sign a kind-17 receipt echoing the
 * offer's name + invoice and submit it with the seller's raw offer event. The
 * marketplace reassigns the name only if GoblinPay reports the invoice confirmed.
 */
export function useSubmitTransfer() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async ({ offer }: { offer: IncomingOffer }) => {
			const ndk = ndkActions.getNDK()
			const signer = ndkActions.getSigner()
			if (!ndk) throw new Error('NDK not initialized')
			if (!signer) throw new Error('You must be signed in to claim a name')

			const receipt = new NDKEvent(ndk)
			receipt.kind = 17
			receipt.content = `Name transfer: ${offer.view.name}`
			receipt.tags = [
				['p', NIP05_GRIN_RECIPIENT_PUBKEY],
				['subject', 'nip05-receipt'],
				['nip05', offer.view.name],
				['invoice', offer.view.invoiceId],
			]
			receipt.created_at = Math.floor(Date.now() / 1000)
			await receipt.sign(signer)
			await ndkActions.publishEvent(receipt)

			const res = await fetch('/api/transfer/claim', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ offer: offer.rawEvent, event: receipt.rawEvent() }),
			})
			const data = await res.json()
			if (!res.ok) throw new Error(data?.error || 'The name could not be transferred')
			return data as { name: string; pubkey: string; validUntil: number }
		},
		onSuccess: async () => {
			const buyer = (await ndkActions.getUser())?.pubkey
			if (buyer) queryClient.invalidateQueries({ queryKey: nameTransferKeys.heldName(buyer) })
			queryClient.invalidateQueries({ queryKey: nameTransferKeys.all })
		},
	})
}
