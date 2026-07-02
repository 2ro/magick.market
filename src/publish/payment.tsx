import { configStore } from '@/lib/stores/config'
import { ndkActions } from '@/lib/stores/ndk'
import type { PublishPaymentDetailParams } from '@/queries/payment'
import { publishPaymentDetail } from '@/queries/payment'
import { paymentDetailsKeys } from '@/queries/queryKeyFactory'
import { NDKEvent, type NDKSigner } from '@nostr-dev-kit/ndk'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

/**
 * Mutation hook for publishing payment details with query invalidation
 * This wraps the query function with additional functionality
 */
export const usePublishPaymentDetailMutation = () => {
	const queryClient = useQueryClient()
	const ndk = ndkActions.getNDK()
	const signer = ndkActions.getSigner()

	return useMutation({
		mutationFn: async (params: PublishPaymentDetailParams) => {
			if (!ndk) throw new Error('NDK not initialized')
			if (!signer) throw new Error('No signer available')

			// Get app pubkey if not provided
			if (!params.appPubkey) {
				const appPubkey = configStore.state.config.appPublicKey
				if (!appPubkey) {
					throw new Error('App public key is required')
				}
				params.appPubkey = appPubkey
			}

			return publishPaymentDetail(params)
		},

		onSuccess: async (eventId, params) => {
			// Get current user pubkey
			let userPubkey = ''
			if (signer) {
				const user = await signer.user()
				if (user && user.pubkey) {
					userPubkey = user.pubkey
				}
			}

			// Invalidate relevant queries
			if (userPubkey) {
				queryClient.invalidateQueries({ queryKey: paymentDetailsKeys.byPubkey(userPubkey) })
			}

			if (params.coordinates) {
				const coordinatesArray = Array.isArray(params.coordinates) ? params.coordinates : [params.coordinates]
				coordinatesArray.forEach((coord) => {
					queryClient.invalidateQueries({ queryKey: paymentDetailsKeys.byProductOrCollection(coord) })
				})
			}

			toast.success('Payment details published successfully')
			return eventId
		},

		onError: (error) => {
			console.error('Failed to publish payment details:', error)
			toast.error(`Failed to publish payment details: ${error instanceof Error ? error.message : String(error)}`)
		},
	})
}

/**
 * Helper mutation for saving a seller's GRIN payment detail:
 * a Goblin nprofile (Grin-over-Nostr) or a Grin slatepack address.
 */
export const useGrinPaymentDetailMutation = () => {
	const publishPaymentDetailMutation = usePublishPaymentDetailMutation()

	return useMutation({
		mutationFn: async (params: { goblinAddress: string; coordinates?: string; appPubkey?: string }) => {
			return publishPaymentDetailMutation.mutateAsync({
				paymentMethod: 'grin',
				paymentDetail: params.goblinAddress,
				coordinates: params.coordinates,
				appPubkey: params.appPubkey,
			})
		},

		onSuccess: (eventId) => {
			toast.success('Goblin payment address saved')
			return eventId
		},

		onError: (error) => {
			console.error('Failed to save Goblin payment address:', error)
			toast.error('Failed to save Goblin payment address')
		},
	})
}

/**
 * Parameters for publishing a payment receipt
 */
export interface PublishPaymentReceiptParams {
	invoice: {
		orderId: string
		recipientPubkey?: string
		/** Amount in integer nanogrin. */
		amount: number
		description?: string
		/** The opaque invoice number (memo) bridging payment to order. */
		id: string
	}
	/** The receiver-signed Grin payment proof pasted/imported from Goblin. */
	proof: string
	/** Optional signer override (the guest buyer's ephemeral key). */
	signer?: NDKSigner
}

/**
 * Publishes a payment receipt (Kind 17) to the Nostr network.
 * This is the buyer-proof confirmation path: the buyer imports the
 * receiver-signed Grin payment proof from Goblin and the market publishes it
 * as a kind 17 receipt carrying the grin_proof. The seller-receipt path
 * (seller's Goblin publishing its own receipt) uses the same event shape.
 */
export const publishPaymentReceipt = async (params: PublishPaymentReceiptParams): Promise<string> => {
	const { invoice, proof } = params

	const ndk = ndkActions.getNDK()
	if (!ndk) throw new Error('NDK not initialized')

	const signer = params.signer || ndkActions.getSigner()
	if (!signer) throw new Error('No signer available')

	// Create the payment receipt event (Kind 17)
	const event = new NDKEvent(ndk)
	event.kind = 17 // Payment Receipt Kind
	event.content = invoice.description || 'Payment confirmation'

	event.tags = [
		['p', invoice.recipientPubkey || ''], // Merchant's pubkey
		['subject', 'order-receipt'],
		['order', invoice.orderId],
		['payment-request', invoice.id], // Invoice number (bridges payment to order)
		['payment', 'grin', invoice.id, proof], // Payment proof: grin_proof keyed by invoice number
		['amount', invoice.amount.toString()], // nanogrin
	]
	event.created_at = Math.floor(Date.now() / 1000)

	try {
		await event.sign(signer)
		await ndkActions.publishEvent(event)

		console.log(`✅ Payment receipt published for order ${invoice.orderId}`)
		return event.id
	} catch (error) {
		console.error('❌ Failed to publish payment receipt:', error)
		throw new Error(`Failed to publish payment receipt: ${error instanceof Error ? error.message : 'Unknown error'}`)
	}
}
