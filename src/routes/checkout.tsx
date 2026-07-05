import { CartSummary } from '@/components/CartSummary'
import { CheckoutProgress } from '@/components/checkout/CheckoutProgress'
import { OrderFinalizeComponent } from '@/components/checkout/OrderFinalizeComponent'
import { PaymentContent, type PaymentCompletionSource } from '@/components/checkout/PaymentContent'
import { PaymentSummary } from '@/components/checkout/PaymentSummary'
import { ShippingAddressForm, type CheckoutFormData } from '@/components/checkout/ShippingAddressForm'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
	isValidDigitalDeliveryContact,
	resolveCheckoutDeliveryRequirements,
	type CheckoutDeliveryRequirements,
} from '@/lib/checkout/deliveryRequirements'
import { formatGrinAmount } from '@/lib/grin'
import { authStore } from '@/lib/stores/auth'
import { cartActions, cartStore } from '@/lib/stores/cart'
import { encodeOrderCode, mintGuestOrderSigner, saveGuestOrder } from '@/lib/stores/guestOrders'
import { ndkActions } from '@/lib/stores/ndk'
import { persistInvoicesLocally, updatePersistedInvoiceLocally } from '@/lib/utils/invoiceStorage'
import { publishOrderWithDependencies, type CreatedOrderInfo } from '@/publish/orders'
import { getShippingEvent, getShippingService } from '@/queries/shipping'
import type { PaymentInvoiceData } from '@/lib/types/invoice'
import { useGenerateInvoiceMutation, resolveV4VGrinAddress } from '@/queries/payment'
import { buildGoblinPayUri, deriveProofAddress } from '@/lib/grin'
import { configActions } from '@/lib/stores/config'
import { isSelfPurchase, SELF_PURCHASE_MESSAGE } from '@/lib/checkout/selfPurchase'
import type { NDKSigner } from '@nostr-dev-kit/ndk'
import { useAutoAnimate } from '@formkit/auto-animate/react'
import { useForm } from '@tanstack/react-form'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'
import { Check, ChevronLeft, ChevronRight, Copy, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/checkout')({
	component: RouteComponent,
})

type CheckoutStep = 'shipping' | 'summary' | 'payment' | 'complete'

const EMPTY_DELIVERY_REQUIREMENTS: CheckoutDeliveryRequirements = resolveCheckoutDeliveryRequirements({
	products: [],
	servicesByShippingRef: {},
})

function OrderCodeCard({ orderCodes }: { orderCodes: string[] }) {
	const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

	if (orderCodes.length === 0) return null

	const copyCode = async (code: string, index: number) => {
		try {
			await navigator.clipboard.writeText(code)
			setCopiedIndex(index)
			setTimeout(() => setCopiedIndex(null), 1500)
		} catch {
			toast.error('Could not copy to clipboard')
		}
	}

	return (
		<div className="mb-6 p-4 rounded-lg border bg-amber-50 border-amber-200 space-y-3">
			<h3 className="font-semibold text-amber-900">
				Your order {orderCodes.length > 1 ? 'codes' : 'code'} — save {orderCodes.length > 1 ? 'them' : 'it'}
			</h3>
			<p className="text-sm text-amber-800">
				No account was created. This code is the only way to track your order from another device: it re-derives your one-time order key. It
				is also saved in this browser under &quot;Your orders on this device&quot;.
			</p>
			{orderCodes.map((code, i) => (
				<button
					key={code}
					type="button"
					onClick={() => copyCode(code, i)}
					className="w-full flex items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-left hover:bg-gray-50"
				>
					<span className="text-xs font-mono truncate">{code}</span>
					{copiedIndex === i ? <Check className="w-4 h-4 shrink-0 text-green-600" /> : <Copy className="w-4 h-4 shrink-0 text-gray-500" />}
				</button>
			))}
		</div>
	)
}

function RouteComponent() {
	const navigate = useNavigate()
	const { cart, totalInNanogrin, productsBySeller, sellerData } = useStore(cartStore)
	const { isAuthenticated } = useStore(authStore)
	const [currentStep, setCurrentStep] = useState<CheckoutStep>('shipping')
	const [currentInvoiceIndex, setCurrentInvoiceIndex] = useState(0)
	const [invoices, setInvoices] = useState<PaymentInvoiceData[]>([])
	const [shippingData, setShippingData] = useState<CheckoutFormData | null>(null)
	const [mobileOrderSummaryOpen, setMobileOrderSummaryOpen] = useState(false)
	const [isCreatingOrder, setIsCreatingOrder] = useState(false)
	const [deliveryRequirements, setDeliveryRequirements] = useState<CheckoutDeliveryRequirements>(EMPTY_DELIVERY_REQUIREMENTS)
	const [isDeliveryRequirementsLoading, setIsDeliveryRequirementsLoading] = useState(false)
	const [deliveryRequirementsError, setDeliveryRequirementsError] = useState<string | null>(null)
	const [createdOrders, setCreatedOrders] = useState<CreatedOrderInfo[]>([])
	const [orderCodes, setOrderCodes] = useState<string[]>([])

	// Anonymous guest buyer (M3): the one-off order key for this checkout.
	// Minted lazily when the order is created; never registered as a login.
	const guestSignerRef = useRef<ReturnType<typeof mintGuestOrderSigner> | null>(null)

	// Reset checkout state when component mounts or cart changes
	useEffect(() => {
		setCurrentStep('shipping')
		setCurrentInvoiceIndex(0)
		setInvoices([])
		setShippingData(null)
		setCreatedOrders([])
		setOrderCodes([])
		guestSignerRef.current = null
	}, [Object.keys(cart.products).join(',')]) // Reset when cart products change

	// Clear cart when component unmounts if checkout was completed
	useEffect(() => {
		return () => {
			if (currentStep === 'complete') {
				cartActions.clear()
			}
		}
	}, [currentStep])

	const hasCheckoutArtifacts = createdOrders.length > 0 || invoices.length > 0
	const isCartEditable = currentStep === 'shipping' && !hasCheckoutArtifacts
	// Use auto-animate with error handling to prevent DOM manipulation errors
	const [animationParent] = (() => {
		try {
			return useAutoAnimate()
		} catch (error) {
			console.warn('Auto-animate not available:', error)
			return [null]
		}
	})()
	const { mutateAsync: generateInvoice, isPending: isGeneratingInvoices } = useGenerateInvoiceMutation()

	const cartProducts = useMemo(() => Object.values(cart.products), [cart.products])

	const isCartEmpty = useMemo(() => {
		return cartProducts.length === 0
	}, [cartProducts])

	const hasAllShippingMethods = useMemo(() => {
		return cartProducts.every((product) => !!product.shippingMethodId)
	}, [cartProducts])

	useEffect(() => {
		let isCancelled = false

		const resolveDeliveryRequirements = async () => {
			if (cartProducts.length === 0) {
				setDeliveryRequirements(EMPTY_DELIVERY_REQUIREMENTS)
				setIsDeliveryRequirementsLoading(false)
				setDeliveryRequirementsError(null)
				return
			}

			if (!hasAllShippingMethods) {
				setDeliveryRequirements(
					resolveCheckoutDeliveryRequirements({
						products: cartProducts,
						servicesByShippingRef: {},
					}),
				)
				setIsDeliveryRequirementsLoading(false)
				setDeliveryRequirementsError(null)
				return
			}

			const shippingRefs = Array.from(new Set(cartProducts.map((product) => product.shippingMethodId?.trim()).filter(Boolean) as string[]))

			setIsDeliveryRequirementsLoading(true)
			setDeliveryRequirementsError(null)

			const servicesByShippingRef: Record<string, string | null> = {}

			try {
				await Promise.all(
					shippingRefs.map(async (shippingRef) => {
						const shippingEvent = await getShippingEvent(shippingRef)
						servicesByShippingRef[shippingRef] = shippingEvent ? getShippingService(shippingEvent)?.[1] || null : null
					}),
				)

				if (isCancelled) return

				setDeliveryRequirements(
					resolveCheckoutDeliveryRequirements({
						products: cartProducts,
						servicesByShippingRef,
					}),
				)
				setIsDeliveryRequirementsLoading(false)
			} catch (error) {
				console.error('Failed to resolve checkout delivery requirements:', error)
				if (isCancelled) return

				setDeliveryRequirements(
					resolveCheckoutDeliveryRequirements({
						products: cartProducts,
						servicesByShippingRef,
					}),
				)
				setDeliveryRequirementsError('Delivery requirements could not be verified. Please retry before continuing to payment.')
				setIsDeliveryRequirementsLoading(false)
			}
		}

		resolveDeliveryRequirements()

		return () => {
			isCancelled = true
		}
	}, [cartProducts, hasAllShippingMethods])

	const sellers = useMemo(() => {
		return Object.keys(productsBySeller)
	}, [productsBySeller])

	// One GRIN payment per seller order
	const invoiceStepCount = useMemo(() => {
		return invoices.length > 0 ? invoices.length : Math.max(1, sellers.length)
	}, [invoices.length, sellers.length])

	const totalSteps = useMemo(() => {
		// shipping + summary + (actual/expected payments) + complete
		return 2 + invoiceStepCount + 1
	}, [invoiceStepCount])

	const isInvoiceCompleteForFlow = (invoice: PaymentInvoiceData) => {
		return invoice.status === 'paid' || invoice.status === 'skipped' || invoice.status === 'expired'
	}

	// Ensure currentInvoiceIndex stays within bounds
	const safeInvoiceIndex = useMemo(() => {
		if (invoices.length === 0) return 0
		return Math.min(currentInvoiceIndex, invoices.length - 1)
	}, [currentInvoiceIndex, invoices.length])

	const currentStepNumber = useMemo(() => {
		switch (currentStep) {
			case 'shipping':
				return 1
			case 'summary':
				return 2
			case 'payment': {
				const paymentPosition = invoices.length > 0 ? safeInvoiceIndex : 0
				return 3 + paymentPosition
			}
			case 'complete':
				return totalSteps
			default:
				return 1
		}
	}, [currentStep, invoices.length, safeInvoiceIndex, totalSteps])

	const progress = useMemo(() => {
		return ((currentStepNumber - 1) / (totalSteps - 1)) * 100
	}, [currentStepNumber, totalSteps])

	const stepDescription = useMemo(() => {
		switch (currentStep) {
			case 'shipping':
				return 'Enter shipping address'
			case 'summary':
				return 'Review your order'
			case 'payment': {
				if (invoices.length === 0) {
					return 'Preparing Grin payment...'
				}
				const currentInvoice = invoices[safeInvoiceIndex]
				if (currentInvoice) {
					return `Payment ${safeInvoiceIndex + 1} of ${invoices.length}: ${currentInvoice.recipientName}`
				}
				return `Grin payments (${safeInvoiceIndex + 1} of ${invoices.length})`
			}
			case 'complete':
				return 'Order complete'
			default:
				return 'Checkout'
		}
	}, [currentStep, safeInvoiceIndex, invoices])

	// Build the GRIN payment requests when moving to payment step
	useEffect(() => {
		const hasAllOrders = createdOrders.length >= sellers.length && sellers.length > 0
		if (currentStep === 'payment' && invoices.length === 0 && sellers.length > 0 && !isGeneratingInvoices) {
			if (!hasAllOrders) {
				console.warn('Waiting for orders before preparing payments...')
				return
			}

			const generateInvoices = async () => {
				const newInvoices: PaymentInvoiceData[] = []

				try {
					for (const order of createdOrders) {
						const sellerProducts = productsBySeller[order.sellerPubkey] || []
						const sellerItems = sellerProducts.map((product) => ({
							productId: product.id,
							name: `Product ${product.id.substring(0, 8)}...`,
							amount: product.amount,
							price: Math.floor(order.amountNanogrin / Math.max(1, sellerProducts.length)),
						}))

						// Circular economy (V4V): the seller's own configured shares split
						// this order's total between the seller and their chosen recipients.
						// sellerData is populated during cart totals (cartActions.updateSellerData),
						// keyed by seller pubkey with product-only totals — apply the same
						// sellerAmount/recipientAmounts split to the order's full amount
						// (which already includes shipping, added entirely to the seller side).
						const shares = sellerData[order.sellerPubkey]?.shares
						const sellerAmount = shares ? shares.sellerAmount : order.amountNanogrin
						const recipientAmounts = shares?.recipientAmounts ?? []

						// The invoice number minted at order creation is the payment id
						// AND the Goblin pay-URI memo - the bridge between order and payment.
						const generated = await generateInvoice({
							sellerPubkey: order.sellerPubkey,
							amountNanogrin: sellerAmount,
							description: `Payment for ${sellerProducts.length} item${sellerProducts.length === 1 ? '' : 's'}`,
							invoiceId: order.invoiceNumber,
							items: sellerItems,
						})

						newInvoices.push({
							id: generated.id,
							orderId: order.orderId,
							recipientPubkey: generated.sellerPubkey,
							recipientName: generated.sellerName,
							amount: generated.amount,
							description: 'Merchant Payment',
							grinAddress: generated.grinAddress,
							payUri: generated.payUri,
							status: generated.status === 'failed' ? 'failed' : 'pending',
							type: 'merchant',
							createdAt: Date.now(),
						})

						for (const recipient of recipientAmounts) {
							if (recipient.amountNanogrin <= 0) continue

							const grinAddress = await resolveV4VGrinAddress(recipient.pubkey)
							const invoiceId = `${order.invoiceNumber}-v4v-${recipient.pubkey.slice(0, 8)}`

							if (!grinAddress) {
								// Skip this leg outright (visible as "Skipped" in the payment list)
								// rather than blocking the whole checkout: the recipient simply has
								// no Goblin payment address to receive their share.
								console.warn(`V4V recipient ${recipient.pubkey} has no Goblin payment address configured, skipping their share`)
								newInvoices.push({
									id: invoiceId,
									orderId: order.orderId,
									recipientPubkey: recipient.pubkey,
									recipientName: recipient.name || recipient.pubkey.slice(0, 12),
									amount: recipient.amountNanogrin,
									description: 'V4V Community Payment — skipped (recipient has no Goblin payment address)',
									grinAddress: null,
									payUri: null,
									status: 'skipped',
									type: 'v4v',
									createdAt: Date.now(),
								})
								continue
							}

							newInvoices.push({
								id: invoiceId,
								orderId: order.orderId,
								recipientPubkey: recipient.pubkey,
								recipientName: recipient.name || recipient.pubkey.slice(0, 12),
								amount: recipient.amountNanogrin,
								description: 'V4V Community Payment',
								grinAddress,
								payUri: buildGoblinPayUri({
									to: grinAddress,
									amountNanogrin: recipient.amountNanogrin,
									memo: invoiceId,
									proofAddress: deriveProofAddress(grinAddress) ?? undefined,
									order: deriveProofAddress(grinAddress) ? invoiceId : undefined,
									notify: deriveProofAddress(grinAddress) ? configActions.getWatcherNpub() : undefined,
								}),
								status: 'pending',
								type: 'v4v',
								createdAt: Date.now(),
							})
						}
					}

					console.log(`Prepared ${newInvoices.length} Grin payment request(s)`)
					setInvoices(newInvoices)
					persistInvoicesLocally(newInvoices)
				} catch (error) {
					console.error('Failed to prepare Grin payments:', error)
					setInvoices([])
				}
			}

			generateInvoices()
		}
	}, [currentStep, sellers, productsBySeller, invoices.length, isGeneratingInvoices, generateInvoice, createdOrders])

	const form = useForm({
		defaultValues: {
			name: '',
			email: '',
			phone: '',
			firstLineOfAddress: '',
			zipPostcode: '',
			city: '',
			country: '',
			additionalInformation: '',
		} as CheckoutFormData,
		onSubmit: async ({ value }) => {
			if (!hasAllShippingMethods) return
			if (isDeliveryRequirementsLoading || deliveryRequirementsError || !deliveryRequirements.isResolved) {
				toast.error('Delivery requirements must be verified before checkout can continue.')
				return
			}
			if (deliveryRequirements.needsDigitalDeliveryContact && !isValidDigitalDeliveryContact(value.email)) {
				toast.error('Enter a valid digital delivery contact before checkout can continue.')
				return
			}

			setShippingData(value)
			setCurrentStep('summary')
		},
	})

	const findNextPendingInvoiceIndex = (list: PaymentInvoiceData[], fromIndex: number) => {
		for (let i = fromIndex + 1; i < list.length; i++) {
			if (list[i].status === 'pending' || list[i].status === 'failed') {
				return i
			}
		}

		for (let i = 0; i <= fromIndex; i++) {
			if (list[i].status === 'pending' || list[i].status === 'failed') {
				return i
			}
		}

		return -1
	}

	const updateInvoiceStatus = (invoiceId: string, changes: Partial<PaymentInvoiceData>, options?: { skipAutoAdvance?: boolean }) => {
		let nextPendingIndex: number | null = null
		let allCompleted = false

		setInvoices((prevInvoices) => {
			const updated = prevInvoices.map((invoice) => (invoice.id === invoiceId ? { ...invoice, ...changes } : invoice))

			allCompleted = updated.length > 0 && updated.every(isInvoiceCompleteForFlow)

			if (!options?.skipAutoAdvance && !allCompleted) {
				const currentIndex = updated.findIndex((inv) => inv.id === invoiceId)
				nextPendingIndex = findNextPendingInvoiceIndex(updated, currentIndex === -1 ? safeInvoiceIndex : currentIndex)
			}

			return updated
		})

		if (allCompleted) {
			setCurrentStep('complete')
		} else if (!options?.skipAutoAdvance && nextPendingIndex !== null && nextPendingIndex !== -1) {
			// Small delay keeps UI transitions smooth
			setTimeout(() => setCurrentInvoiceIndex(nextPendingIndex!), 200)
		}
	}

	/**
	 * Proof-on-request confirmation (contract 4.5): the only event that flips an
	 * order to paid is the instance watcher's signed kind-17 confirmed receipt,
	 * surfaced by useOrderConfirmation. The buyer publishes nothing; here we just
	 * record the local paid marker.
	 */
	const handlePaymentComplete = async (invoiceId: string, proof: string, _source: PaymentCompletionSource) => {
		const invoice = invoices.find((inv) => inv.id === invoiceId)
		if (!invoice) return

		updatePersistedInvoiceLocally(invoice.orderId, invoice.id, {
			status: 'paid',
			proof,
		})

		updateInvoiceStatus(invoiceId, {
			status: 'paid' as const,
			proof,
		})
	}

	const handleSkipPayment = (invoiceId: string) => {
		console.log(`⏭️ Payment skipped for invoice ${invoiceId}`)

		const invoice = invoices.find((inv) => inv.id === invoiceId)

		if (invoice) {
			updatePersistedInvoiceLocally(invoice.orderId, invoice.id, {
				status: 'skipped',
			})
		}

		// Mark invoice as skipped to allow checkout to proceed
		updateInvoiceStatus(invoiceId, { status: 'skipped' })

		toast.info('Payment skipped - you can pay later using your order code')
	}

	// Safety net: if all invoices are done, move to completion even if a handler was missed
	useEffect(() => {
		if (currentStep === 'payment' && invoices.length > 0) {
			const allCompleted = invoices.every(isInvoiceCompleteForFlow)
			if (allCompleted) {
				setCurrentStep('complete')
			}
		}
	}, [currentStep, invoices])

	const goBackToShopping = () => {
		// Clear cart when leaving checkout after completion
		if (currentStep === 'complete') {
			cartActions.clear()
		}
		navigate({ to: '/' })
	}

	const goToOrders = () => {
		// Clear cart when viewing orders after completion
		if (currentStep === 'complete') {
			cartActions.clear()
		}
		if (isAuthenticated) {
			navigate({ to: '/dashboard/account/your-purchases' })
		} else {
			navigate({ to: '/track' })
		}
	}

	const goBackToPreviousStep = () => {
		if (currentStep === 'summary') {
			if (hasCheckoutArtifacts) {
				toast.info('Cart edits are locked after order creation.')
				return
			}
			setCurrentStep('shipping')
		} else if (currentStep === 'payment') {
			if (currentInvoiceIndex > 0) {
				setCurrentInvoiceIndex((prev) => prev - 1)
			} else {
				setCurrentStep('summary')
			}
		} else if (currentStep === 'complete') {
			setCurrentStep('payment')
			setCurrentInvoiceIndex(invoices.length - 1)
		}
	}

	const handleBackClick = () => {
		if (currentStep === 'shipping') {
			goBackToShopping()
		} else {
			goBackToPreviousStep()
		}
	}

	const canContinueToPayment =
		!!shippingData &&
		deliveryRequirements.isResolved &&
		!isDeliveryRequirementsLoading &&
		!deliveryRequirementsError &&
		(!deliveryRequirements.needsDigitalDeliveryContact || isValidDigitalDeliveryContact(shippingData.email))

	const handleContinueToPayment = async () => {
		if (!canContinueToPayment) {
			toast.error('Delivery requirements must be completed before payment can be requested.')
			return
		}

		// Self-purchase guard (definitive choke point): a Grin payment where
		// sender == receiver can never settle, so refuse before any order or
		// payment request is published. Guests always get a fresh key, so only a
		// logged-in buyer who is also a seller in the cart can trip this.
		if (isSelfPurchase(authStore.state.user?.pubkey, sellers)) {
			toast.error(SELF_PURCHASE_MESSAGE)
			return
		}

		if (shippingData && sellers.length > 0 && createdOrders.length === 0) {
			setIsCreatingOrder(true)
			try {
				// Anonymous guest buyer (M3): mint a fresh one-off order key when
				// nobody is logged in. The buyer never sees a login wall.
				let orderSigner: NDKSigner | undefined
				const existingSigner = ndkActions.getSigner()
				if (!isAuthenticated || !existingSigner) {
					guestSignerRef.current = guestSignerRef.current || mintGuestOrderSigner()
					orderSigner = guestSignerRef.current
				}

				const orders = await publishOrderWithDependencies({
					shippingData,
					sellers,
					productsBySeller,
					sellerData,
					signer: orderSigner,
				})
				setCreatedOrders(orders)

				// Auto-save guest order records + build the copyable order codes
				if (orderSigner && guestSignerRef.current) {
					const sk = guestSignerRef.current.privateKey || ''
					const guestUser = await guestSignerRef.current.user()
					const codes: string[] = []
					for (const order of orders) {
						saveGuestOrder({
							orderId: order.orderId,
							invoiceNumber: order.invoiceNumber,
							sellerPubkey: order.sellerPubkey,
							amountNanogrin: order.amountNanogrin,
							secretKeyHex: sk,
							pubkey: guestUser.pubkey,
							createdAt: Date.now(),
						})
						codes.push(
							encodeOrderCode({
								sk,
								orderId: order.orderId,
								invoiceNumber: order.invoiceNumber,
								sellerPubkey: order.sellerPubkey,
							}),
						)
					}
					setOrderCodes(codes)
				}

				console.log('\n🎉 Order creation process complete. Orders:', orders)
			} catch (error) {
				console.error('Failed to create orders:', error)
				toast.error(`Order creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
				setIsCreatingOrder(false)
				return
			}
		}

		// Move to payment step once orders exist
		setCurrentStep('payment')
		setIsCreatingOrder(false)
	}

	// Redirect to home if cart is empty (but allow complete step to show summary)
	if (isCartEmpty && currentStep !== 'complete') {
		return (
			<div className="min-h-screen bg-gray-50 flex items-center justify-center">
				<div className="max-w-md mx-auto text-center">
					<h1 className="text-2xl font-bold text-gray-900 mb-4">Your cart is empty</h1>
					<p className="text-gray-600 mb-6">Add some products to your cart before checking out.</p>
					<Button onClick={goBackToShopping} className="btn-black">
						Continue Shopping
					</Button>
				</div>
			</div>
		)
	}

	return (
		<div className="flex-grow flex flex-col">
			{/* Fixed Progress Bar */}
			<div className="sticky top-[8.5rem] lg:top-[5rem] z-20 bg-white border-b border-gray-200">
				<CheckoutProgress
					currentStepNumber={currentStepNumber}
					totalSteps={totalSteps}
					progress={progress}
					stepDescription={stepDescription}
					onBackClick={handleBackClick}
					showBackButton={currentStep !== 'complete'}
				/>
			</div>

			{/* Main Content */}
			<div className="px-4 py-8 flex flex-col lg:flex-row lg:gap-4 w-full lg:h-[calc(100vh-10rem)]">
				{/* Mobile Order Summary / Invoices (collapsible) */}
				<div className="lg:hidden mb-4">
					<Card>
						<CardHeader>
							<CardTitle
								className="flex items-center justify-between cursor-pointer"
								onClick={() => setMobileOrderSummaryOpen(!mobileOrderSummaryOpen)}
							>
								<span>{currentStep === 'payment' ? 'Payment Details' : 'Cart Summary'}</span>
								<ChevronRight className={`w-5 h-5 transition-transform ${mobileOrderSummaryOpen ? 'rotate-90' : ''}`} />
							</CardTitle>
						</CardHeader>
						{mobileOrderSummaryOpen && (
							<CardContent>
								{currentStep === 'payment' && isGeneratingInvoices ? (
									<div className="flex items-center justify-center py-8">
										<div className="text-center">
											<div className="animate-spin w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full mx-auto mb-4" />
											<p className="text-gray-600">Loading payment details...</p>
										</div>
									</div>
								) : currentStep === 'payment' && invoices.length > 0 ? (
									<PaymentSummary invoices={invoices} currentIndex={safeInvoiceIndex} onSelectInvoice={setCurrentInvoiceIndex} />
								) : (
									<div className="max-h-[50vh] overflow-y-auto">
										<CartSummary allowQuantityChanges={isCartEditable} allowShippingChanges={isCartEditable} showExpandedDetails={false} />
									</div>
								)}
							</CardContent>
						)}
					</Card>
				</div>
				{/* Main Content Area */}
				<Card className="flex-1 lg:w-1/2 flex flex-col lg:h-full shadow-md lg:order-2">
					<CardHeader>
						<div className="flex items-center justify-between">
							<CardTitle>
								{currentStep === 'shipping' ? 'Shipping Address' : currentStep === 'payment' ? 'Pay with Goblin' : 'Order Summary'}
							</CardTitle>
							{currentStep === 'payment' && invoices.length > 1 && (
								<div className="hidden lg:flex items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={() => setCurrentInvoiceIndex(Math.max(0, safeInvoiceIndex - 1))}
										disabled={safeInvoiceIndex === 0}
									>
										<ChevronLeft className="w-4 h-4" />
										Previous
									</Button>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setCurrentInvoiceIndex(Math.min(invoices.length - 1, safeInvoiceIndex + 1))}
										disabled={safeInvoiceIndex === invoices.length - 1}
									>
										Next
										<ChevronRight className="w-4 h-4" />
									</Button>
								</div>
							)}
						</div>
					</CardHeader>
					<CardContent className="p-6 pt-0 flex-1 lg:overflow-y-auto">
						<div ref={animationParent} className="lg:h-full lg:min-h-full">
							{currentStep === 'shipping' && (
								<div className="h-full">
									<ShippingAddressForm
										form={form}
										hasAllShippingMethods={hasAllShippingMethods}
										deliveryRequirements={deliveryRequirements}
										isDeliveryRequirementsLoading={isDeliveryRequirementsLoading}
										deliveryRequirementsError={deliveryRequirementsError}
									/>
								</div>
							)}

							{currentStep === 'summary' && (
								<div className="h-full flex flex-col">
									<div className="flex-1 overflow-y-auto">
										<OrderFinalizeComponent
											shippingData={shippingData}
											invoices={[]} // No invoices yet in summary step
											totalInNanogrin={totalInNanogrin}
											onNewOrder={goBackToShopping}
											deliveryRequirements={deliveryRequirements}
											// Note: onContinueToPayment moved to footer
										/>
									</div>
									<div className="flex-shrink-0 bg-white border-t pt-4">
										{!isAuthenticated && (
											<p className="text-xs text-gray-500 mb-3 text-center">
												No account needed. Your order is signed with a fresh one-time key and your address is encrypted to the seller alone.
												Paid in Grin, private by default.
											</p>
										)}
										<Button
											onClick={handleContinueToPayment}
											className="w-full btn-black"
											disabled={isCreatingOrder || !canContinueToPayment}
										>
											{isCreatingOrder ? (
												<>
													<Loader2 className="mr-2 h-4 w-4 animate-spin" />
													Creating Order...
												</>
											) : (
												'Continue to Payment'
											)}
										</Button>
									</div>
								</div>
							)}

							{/* Loading State for payment preparation */}
							{currentStep === 'payment' && isGeneratingInvoices && (
								<div className="h-full flex items-center justify-center">
									<div className="text-center">
										<div className="animate-spin w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full mx-auto mb-4" />
										<p className="text-gray-600">Preparing Grin payment...</p>
									</div>
								</div>
							)}

							{/* Error State - No payment requests prepared */}
							{currentStep === 'payment' && !isGeneratingInvoices && invoices.length === 0 && (
								<div className="text-center py-12">
									<div className="text-gray-600 mb-6">
										<h3 className="text-lg font-medium mb-2">Unable to prepare the Grin payment</h3>
										<p className="text-sm text-gray-500 max-w-md mx-auto">
											The seller&apos;s Goblin payment address could not be resolved. Your order was created — you can retry, or pay later
											using your order code.
										</p>
									</div>
									<div className="space-y-2">
										<Button
											onClick={() => {
												setInvoices([])
												// This will trigger the useEffect to regenerate payment requests
											}}
											variant="outline"
											className="mr-2"
										>
											Try Again
										</Button>
										<Button onClick={goBackToPreviousStep} variant="ghost">
											Go Back
										</Button>
									</div>
								</div>
							)}

							{/* Payment Interface - Only show when payment requests are ready */}
							{currentStep === 'payment' && !isGeneratingInvoices && invoices.length > 0 && (
								<div className="space-y-6">
									<PaymentContent
										invoices={invoices}
										currentIndex={safeInvoiceIndex}
										onPaymentComplete={handlePaymentComplete}
										onSkipPayment={handleSkipPayment}
										showNavigation={false} // We have our own navigation above
										onNavigate={setCurrentInvoiceIndex}
										mode="checkout"
									/>
								</div>
							)}

							{currentStep === 'complete' && (
								<div>
									<OrderCodeCard orderCodes={orderCodes} />
									<OrderFinalizeComponent
										shippingData={shippingData}
										invoices={invoices}
										totalInNanogrin={totalInNanogrin}
										onNewOrder={goBackToShopping}
										onViewOrders={goToOrders}
										deliveryRequirements={deliveryRequirements}
									/>
								</div>
							)}
						</div>
					</CardContent>
				</Card>

				{/* Right Sidebar */}
				<Card className="hidden lg:flex flex-1 lg:w-1/2 flex-col h-full shadow-md lg:order-1">
					<CardHeader>
						<CardTitle>{currentStep === 'payment' ? 'Payment Details' : 'Cart Summary'}</CardTitle>
					</CardHeader>
					<CardContent className="flex-1 overflow-y-auto pb-0">
						{currentStep === 'payment' && isGeneratingInvoices ? (
							<div className="flex items-center justify-center h-full">
								<div className="text-center">
									<div className="animate-spin w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full mx-auto mb-4" />
									<p className="text-gray-600">Loading payment details...</p>
								</div>
							</div>
						) : currentStep === 'payment' && invoices.length > 0 ? (
							<div className="pb-6">
								<PaymentSummary invoices={invoices} currentIndex={safeInvoiceIndex} onSelectInvoice={setCurrentInvoiceIndex} />
							</div>
						) : (
							<ScrollArea className="h-full">
								<CartSummary
									className="pb-6"
									allowQuantityChanges={isCartEditable}
									allowShippingChanges={isCartEditable}
									showExpandedDetails={false}
								/>
							</ScrollArea>
						)}
					</CardContent>
				</Card>
			</div>
		</div>
	)
}
