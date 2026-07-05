import { getPersistedInvoicesForOrder, persistInvoicesLocally, updatePersistedInvoiceLocally } from '@/lib/utils/invoiceStorage'
import type { PaymentInvoiceData } from '@/lib/types/invoice'
import type { V4VDTO } from '@/lib/stores/cart'
import { buildGoblinPayUri, deriveProofAddress } from '@/lib/grin'
import { configActions } from '@/lib/stores/config'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useGenerateInvoiceMutation } from '@/queries/payment'
import type { PaymentCompletionSource } from '@/components/checkout/PaymentContent'
import { useQueryClient } from '@tanstack/react-query'
import { orderKeys } from '@/queries/queryKeyFactory'
import {
	extractPaymentMethods,
	getInvoiceNumber,
	getOrderId,
	getSellerPubkey,
	isPaymentCompleted,
	makeInvoiceKey,
} from './orderDetailHelpers'
import type { OrderWithRelatedEvents } from '@/queries/orders'

type InvoiceSource = 'request' | 'both'

export type InvoiceWithSource = PaymentInvoiceData & {
	source: InvoiceSource
	localCopies: PaymentInvoiceData[]
}

interface UseOrderInvoicesParams {
	order: OrderWithRelatedEvents
	sellerV4VShares: V4VDTO[]
	userPubkey?: string
}

export function useOrderInvoices({ order, sellerV4VShares, userPubkey }: UseOrderInvoicesParams) {
	const { mutateAsync: generateInvoice } = useGenerateInvoiceMutation()
	const queryClient = useQueryClient()
	const [generatingInvoices, setGeneratingInvoices] = useState<Set<string>>(new Set())
	const [localInvoices, setLocalInvoices] = useState<PaymentInvoiceData[]>([])

	const orderEvent = order.order
	const orderId = getOrderId(orderEvent)
	const sellerPubkey = getSellerPubkey(orderEvent)
	const buyerPubkey = orderEvent.pubkey
	const isBuyer = buyerPubkey === userPubkey

	// Refresh local invoices from storage
	const refreshLocalInvoices = useCallback(() => {
		if (!isBuyer || !orderId) return
		const stored = getPersistedInvoicesForOrder(orderId)
		setLocalInvoices(stored)
	}, [isBuyer, orderId])

	useEffect(() => {
		refreshLocalInvoices()
	}, [refreshLocalInvoices])

	// Build invoices from payment requests
	const invoicesFromPaymentRequests = useMemo(() => {
		const paymentReceipts = order.paymentReceipts || []

		if (!order.paymentRequests || order.paymentRequests.length === 0) {
			return []
		}

		const invoices: PaymentInvoiceData[] = []

		order.paymentRequests.forEach((paymentRequest) => {
			const amountTag = paymentRequest.tags.find((tag) => tag[0] === 'amount')
			const amount = amountTag?.[1] ? parseInt(amountTag[1], 10) : 0

			if (amount <= 0) return

			const paymentMethods = extractPaymentMethods(paymentRequest)
			const grinPayment = paymentMethods.find((p) => p.type === 'grin')
			const isCompleted = isPaymentCompleted(paymentRequest, paymentReceipts)

			const recipientPubkey = paymentRequest.tags.find((tag) => tag[0] === 'recipient')?.[1] || paymentRequest.pubkey

			// The invoice number bridges the Grin payment (memo) to the order.
			const invoiceNumber = getInvoiceNumber(paymentRequest) || paymentRequest.id

			const grinAddress = grinPayment?.details || null
			const proofAddress = deriveProofAddress(grinAddress) ?? undefined
			const payUri = grinAddress
				? buildGoblinPayUri({
						to: grinAddress,
						amountNanogrin: amount,
						memo: invoiceNumber,
						proofAddress,
						order: proofAddress ? invoiceNumber : undefined,
						notify: proofAddress ? configActions.getWatcherNpub() : undefined,
					})
				: null

			invoices.push({
				id: invoiceNumber,
				orderId: orderId,
				amount,
				description: 'Merchant Payment',
				recipientName: 'Merchant',
				status: isCompleted ? 'paid' : 'pending',
				createdAt: paymentRequest.created_at || Math.floor(Date.now() / 1000),
				grinAddress,
				payUri,
				recipientPubkey,
				type: 'merchant',
			})
		})

		return invoices
	}, [order.paymentRequests, order.paymentReceipts, orderId, sellerPubkey])

	// Map local invoices by key
	const localInvoicesByKey = useMemo(() => {
		const map: Record<string, PaymentInvoiceData[]> = {}

		localInvoices.forEach((invoice) => {
			if (invoice.orderId !== orderId) return
			const key = makeInvoiceKey(invoice)
			if (!map[key]) {
				map[key] = []
			}
			map[key].push(invoice)
		})

		Object.values(map).forEach((list) =>
			list.sort((a, b) => {
				const aTime = a.updatedAt || a.createdAt || 0
				const bTime = b.updatedAt || b.createdAt || 0
				return bTime - aTime
			}),
		)

		return map
	}, [localInvoices, orderId])

	// Enriched invoices combining request data with local storage
	const enrichedInvoices: InvoiceWithSource[] = useMemo(() => {
		return invoicesFromPaymentRequests.map((invoice) => {
			const key = makeInvoiceKey(invoice)
			const localCopies = localInvoicesByKey[key] || []
			const latestLocal = localCopies[0]

			return {
				...invoice,
				status: latestLocal?.status ?? invoice.status,
				grinAddress: latestLocal?.grinAddress || invoice.grinAddress,
				payUri: latestLocal?.payUri || invoice.payUri,
				proof: latestLocal?.proof || invoice.proof,
				source: latestLocal ? ('both' as const) : ('request' as const),
				localCopies,
			}
		})
	}, [invoicesFromPaymentRequests, localInvoicesByKey])

	// Rebuild the Grin payment request (e.g. after the seller updates their Goblin address)
	const handleGenerateNewInvoice = useCallback(
		async (invoice: PaymentInvoiceData) => {
			setGeneratingInvoices((prev) => new Set(prev).add(invoice.id))

			try {
				const recipientPubkey = invoice.recipientPubkey || sellerPubkey
				const newInvoiceData = await generateInvoice({
					sellerPubkey: recipientPubkey,
					amountNanogrin: invoice.amount,
					description: invoice.description || 'Payment',
					invoiceId: invoice.id,
					items: [],
				})

				const newPersistedInvoice: PaymentInvoiceData = {
					id: newInvoiceData.id,
					orderId,
					recipientPubkey,
					recipientName: invoice.recipientName,
					amount: invoice.amount,
					description: invoice.description,
					grinAddress: newInvoiceData.grinAddress,
					payUri: newInvoiceData.payUri,
					status: newInvoiceData.status === 'failed' ? 'expired' : (newInvoiceData.status as 'pending' | 'paid' | 'expired'),
					type: invoice.type,
					createdAt: Date.now(),
				}

				persistInvoicesLocally([newPersistedInvoice])
				refreshLocalInvoices()

				toast.success(`New payment request prepared for ${invoice.recipientName}`)
			} catch (error) {
				console.error('Failed to generate new invoice:', error)
				toast.error(`Failed to generate new invoice: ${error instanceof Error ? error.message : 'Unknown error'}`)
			} finally {
				setGeneratingInvoices((prev) => {
					const newSet = new Set(prev)
					newSet.delete(invoice.id)
					return newSet
				})
			}
		},
		[orderId, sellerPubkey, generateInvoice, refreshLocalInvoices],
	)

	// Handle payment completion (proof-on-request, contract 4.5): the watcher's
	// signed confirmed receipt is the only thing that flips an order to paid, so
	// there is nothing for the buyer to publish here. We only persist the local
	// paid marker and refresh.
	const handlePaymentComplete = useCallback(
		async (invoiceId: string, proof: string, _source: PaymentCompletionSource, _dialogInvoices: PaymentInvoiceData[]) => {
			toast.success('Payment confirmed')

			updatePersistedInvoiceLocally(orderId, invoiceId, {
				status: 'paid',
				proof,
			})
			refreshLocalInvoices()
			queryClient.invalidateQueries({ queryKey: orderKeys.details(orderId) })
		},
		[orderId, queryClient, refreshLocalInvoices],
	)

	// Handle payment failure
	const handlePaymentFailed = useCallback(
		(invoiceId: string, error: string) => {
			console.error(`Payment failed for invoice ${invoiceId}:`, error)
			toast.error(`Payment failed: ${error}`)
			updatePersistedInvoiceLocally(orderId, invoiceId, {
				status: 'expired',
			})
			refreshLocalInvoices()
		},
		[orderId, refreshLocalInvoices],
	)

	// Calculate payment statistics
	const paidInvoices = enrichedInvoices.filter((invoice) => invoice.status === 'paid')
	const incompleteInvoices = enrichedInvoices.filter((invoice) => invoice.status !== 'paid')
	const totalInvoices = enrichedInvoices.length
	const paymentProgress = totalInvoices > 0 ? (paidInvoices.length / totalInvoices) * 100 : 0

	return {
		enrichedInvoices,
		paidInvoices,
		incompleteInvoices,
		totalInvoices,
		paymentProgress,
		generatingInvoices,
		handleGenerateNewInvoice,
		handlePaymentComplete,
		handlePaymentFailed,
		refreshLocalInvoices,
	}
}
