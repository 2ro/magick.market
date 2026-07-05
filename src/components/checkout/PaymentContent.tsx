import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { QRCode } from '@/components/ui/qr-code'
import { Textarea } from '@/components/ui/textarea'
import { formatGrinAmount, looksLikeGrinPaymentProof } from '@/lib/grin'
import type { PaymentInvoiceData } from '@/lib/types/invoice'
import { usePaymentReceiptSubscription } from '@/queries/payment'
import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

export type PaymentCompletionSource = 'receipt' | 'proof-import'

interface PaymentContentProps {
	invoices: PaymentInvoiceData[]
	currentIndex?: number
	/**
	 * Called when an invoice is confirmed paid.
	 * - source 'receipt': a kind 17 receipt for the invoice number arrived over Nostr
	 *   (the seller-receipt confirmation path) - no further publishing needed.
	 * - source 'proof-import': the buyer pasted the receiver-signed Grin payment
	 *   proof from Goblin - the caller should publish it as a kind 17 receipt.
	 */
	onPaymentComplete?: (invoiceId: string, proof: string, source: PaymentCompletionSource) => void
	onSkipPayment?: (invoiceId: string) => void
	showNavigation?: boolean
	onNavigate?: (index: number) => void
	/**
	 * Mode controls how "skipped" status is treated:
	 * - 'checkout': skipped invoices show as completed (used during checkout flow)
	 * - 'order': skipped invoices can be re-attempted (used in order details)
	 */
	mode?: 'checkout' | 'order'
}

function CopyRow({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false)

	const copy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(value)
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			toast.error('Could not copy to clipboard')
		}
	}, [value])

	return (
		<button
			type="button"
			onClick={copy}
			className="w-full flex items-center justify-between gap-2 rounded-lg border bg-gray-50 px-3 py-2 text-left hover:bg-gray-100"
		>
			<div className="min-w-0">
				<div className="text-xs text-gray-500">{label}</div>
				<div className="text-sm font-mono truncate">{value}</div>
			</div>
			{copied ? <Check className="w-4 h-4 shrink-0 text-green-600" /> : <Copy className="w-4 h-4 shrink-0 text-gray-500" />}
		</button>
	)
}

export function PaymentContent({
	invoices,
	currentIndex = 0,
	onPaymentComplete,
	onSkipPayment,
	showNavigation = true,
	onNavigate,
	mode = 'checkout',
}: PaymentContentProps) {
	// Clamp index to valid range
	const activeIndex = Math.min(Math.max(0, currentIndex), Math.max(0, invoices.length - 1))
	const currentInvoice = invoices[activeIndex]

	const [proofDraft, setProofDraft] = useState('')
	const [showProofImport, setShowProofImport] = useState(false)
	const completedInvoicesRef = useRef<Set<string>>(new Set())
	const sessionStartRef = useRef(Math.floor(Date.now() / 1000))

	// Reset proof draft when switching invoices
	useEffect(() => {
		setProofDraft('')
		setShowProofImport(false)
	}, [currentInvoice?.id])

	const isCompletedForProgress = (inv: PaymentInvoiceData) => inv.status === 'paid' || inv.status === 'skipped' || inv.status === 'expired'

	const completedCount = useMemo(() => {
		if (mode === 'order') {
			return invoices.filter((inv) => inv.status === 'paid').length
		}
		return invoices.filter(isCompletedForProgress).length
	}, [invoices, mode])

	const handleNavigate = useCallback(
		(newIndex: number) => {
			const clampedIndex = Math.min(Math.max(0, newIndex), invoices.length - 1)
			onNavigate?.(clampedIndex)
		},
		[invoices.length, onNavigate],
	)

	// Seller-receipt confirmation path (M5): watch kind 17 receipts for this
	// invoice number. When the seller's Goblin publishes a receipt, the order
	// flips to paid automatically - whichever path lands first wins.
	const receiptSubscriptionEnabled = !!currentInvoice && currentInvoice.status === 'pending'
	const { data: receiptProof } = usePaymentReceiptSubscription({
		orderId: currentInvoice?.orderId || '',
		invoiceId: currentInvoice?.id || '',
		sessionStartTime: sessionStartRef.current,
		enabled: receiptSubscriptionEnabled,
	})

	useEffect(() => {
		if (!receiptProof || !currentInvoice) return
		if (completedInvoicesRef.current.has(currentInvoice.id)) return
		completedInvoicesRef.current.add(currentInvoice.id)
		toast.success('Payment receipt received')
		onPaymentComplete?.(currentInvoice.id, receiptProof, 'receipt')
	}, [receiptProof, currentInvoice, onPaymentComplete])

	// Buyer-proof confirmation path (M5): paste the receiver-signed payment
	// proof Goblin shows after finalize.
	const handleProofImport = useCallback(() => {
		if (!currentInvoice) return
		const proof = proofDraft.trim()
		if (!looksLikeGrinPaymentProof(proof)) {
			toast.error('That does not look like a Grin payment proof. Copy it from Goblin after the payment finalizes.')
			return
		}
		if (completedInvoicesRef.current.has(currentInvoice.id)) return
		completedInvoicesRef.current.add(currentInvoice.id)
		onPaymentComplete?.(currentInvoice.id, proof, 'proof-import')
	}, [currentInvoice, proofDraft, onPaymentComplete])

	const handleSkipPayment = useCallback(() => {
		if (!currentInvoice) return
		onSkipPayment?.(currentInvoice.id)
	}, [currentInvoice, onSkipPayment])

	const handleOpenInGoblin = useCallback(() => {
		if (!currentInvoice?.payUri) return
		// Deeplink into the Goblin wallet; carries to/amount/memo.
		window.location.href = currentInvoice.payUri
	}, [currentInvoice])

	// Early return if no invoice
	if (!currentInvoice) {
		return <div className="text-sm text-muted-foreground p-4">No payment request to display</div>
	}

	// Check if current invoice is already completed
	// In 'order' mode, only 'paid' is considered completed (skipped can be re-attempted)
	const isCurrentCompleted = mode === 'order' ? currentInvoice.status === 'paid' : isCompletedForProgress(currentInvoice)
	const hasPayUri = !!currentInvoice.payUri

	return (
		<div className="space-y-6 lg:px-6 lg:pb-6">
			{/* Progress bar */}
			{invoices.length > 1 && (
				<div className="space-y-2">
					<div className="flex justify-between text-sm">
						<span>Payment Progress</span>
						<span>
							{completedCount} of {invoices.length} completed
						</span>
					</div>
					<Progress value={(completedCount / invoices.length) * 100} className="w-full" />
				</div>
			)}

			{/* Navigation header */}
			{showNavigation && invoices.length > 1 && (
				<div className="flex items-center justify-between">
					<h3 className="text-lg font-semibold">
						Payment {activeIndex + 1} of {invoices.length}
					</h3>
					<div className="flex items-center gap-2">
						<Button variant="ghost" size="sm" onClick={() => handleNavigate(activeIndex - 1)} disabled={activeIndex === 0}>
							<ChevronLeft className="w-4 h-4" />
						</Button>
						<span className="text-sm text-gray-500">
							{activeIndex + 1} / {invoices.length}
						</span>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => handleNavigate(activeIndex + 1)}
							disabled={activeIndex === invoices.length - 1}
						>
							<ChevronRight className="w-4 h-4" />
						</Button>
					</div>
				</div>
			)}

			{/* Show completed message if current invoice is done */}
			{isCurrentCompleted ? (
				<div className="text-center py-8">
					<div className="text-green-600 font-medium mb-2">
						{currentInvoice.status === 'paid'
							? '✓ Payment Complete'
							: currentInvoice.status === 'skipped'
								? '⏭️ Payment Skipped'
								: '⏰ Payment Request Expired'}
					</div>
					<p className="text-sm text-gray-600 mb-4">
						{currentInvoice.recipientName} - {formatGrinAmount(currentInvoice.amount)}
					</p>
					{activeIndex < invoices.length - 1 && (
						<Button onClick={() => handleNavigate(activeIndex + 1)} variant="outline">
							Next Payment <ChevronRight className="w-4 h-4 ml-1" />
						</Button>
					)}
				</div>
			) : !hasPayUri ? (
				/* Seller has no Goblin payment address configured */
				<div className="text-center py-8 space-y-4">
					<div className="text-amber-600 font-medium">Seller payment details unavailable</div>
					<p className="text-sm text-gray-600 max-w-md mx-auto">
						{currentInvoice.recipientName} has not published a Goblin payment address yet. Your order was created — you can pay later from
						your order page once the seller adds their payment details.
					</p>
					<Button onClick={handleSkipPayment} variant="outline">
						Continue without paying
					</Button>
				</div>
			) : (
				<div className="space-y-5">
					{/* Amount + invoice number */}
					<div className="text-center space-y-1">
						<div className="text-3xl font-bold">{formatGrinAmount(currentInvoice.amount)}</div>
						<div className="text-sm text-gray-600">to {currentInvoice.recipientName}</div>
					</div>

					{/* Big QR with the canonical nostr: Goblin pay-URI */}
					<div className="flex justify-center">
						<QRCode value={currentInvoice.payUri!} size={260} level="H" logo />
					</div>

					{/* Open in Goblin */}
					<div className="flex justify-center">
						<Button onClick={handleOpenInGoblin} size="lg" className="btn-black px-8">
							<ExternalLink className="w-4 h-4 mr-2" />
							Open in Goblin
						</Button>
					</div>

					{/* Invoice number + raw URI, copyable */}
					<div className="space-y-2">
						<CopyRow label="Invoice number (payment memo)" value={currentInvoice.id} />
						<CopyRow label="Payment link" value={currentInvoice.payUri!} />
					</div>

					{/* Live status */}
					<div className="flex items-center justify-center gap-2 text-sm text-gray-600">
						<div className="animate-spin w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full" />
						<span>Waiting for payment — settling privately over Nostr</span>
					</div>

					<p className="text-xs text-gray-500 text-center max-w-md mx-auto">
						No account needed. Scan or open the link in your Goblin wallet; the invoice number rides along as the payment memo so the seller
						can match your payment to this order. Grin payments are interactive — if the seller is offline, the payment settles when they
						come online.
					</p>

					{/* Buyer proof import (M5 second confirmation path) */}
					<div className="border-t pt-4 space-y-3">
						{!showProofImport ? (
							<Button variant="outline" className="w-full" onClick={() => setShowProofImport(true)}>
								I paid — import proof from Goblin
							</Button>
						) : (
							<div className="space-y-2">
								<label className="text-sm font-medium">Paste the payment proof from Goblin</label>
								<p className="text-xs text-gray-500">
									After the payment finalizes, Goblin shows a receiver-signed payment proof. Paste it here to mark the order paid — the
									seller&apos;s wallet verifies it.
								</p>
								<Textarea
									value={proofDraft}
									onChange={(e) => setProofDraft(e.target.value)}
									placeholder="Paste the Grin payment proof here"
									rows={4}
									className="font-mono text-xs"
								/>
								<div className="flex gap-2">
									<Button onClick={handleProofImport} disabled={!proofDraft.trim()} className="flex-1 btn-black">
										Submit proof
									</Button>
									<Button variant="ghost" onClick={() => setShowProofImport(false)}>
										Cancel
									</Button>
								</div>
							</div>
						)}

						{onSkipPayment && (
							<Button variant="ghost" className="w-full text-gray-500" onClick={handleSkipPayment}>
								Pay later
							</Button>
						)}
					</div>
				</div>
			)}
		</div>
	)
}

PaymentContent.displayName = 'PaymentContent'
