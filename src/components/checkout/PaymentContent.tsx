import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { QRCode } from '@/components/ui/qr-code'
import { formatGrinAmount, toGoblinDeeplink } from '@/lib/grin'
import { derivePaymentPanelDisplay } from '@/lib/grinWatcher'
import type { PaymentInvoiceData } from '@/lib/types/invoice'
import { useOrderConfirmation } from '@/queries/payment'
import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

/**
 * Confirmation always arrives as a receipt over Nostr now (proof-on-request):
 * the buyer never proves anything by hand. The single source is kept as a type
 * for call-site clarity.
 */
export type PaymentCompletionSource = 'receipt'

interface PaymentContentProps {
	invoices: PaymentInvoiceData[]
	currentIndex?: number
	/**
	 * Called when an invoice is confirmed paid by the instance watcher's signed
	 * kind-17 receipt (contract 4.5). The buyer takes no action; there is no
	 * proof to import.
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

	const completedInvoicesRef = useRef<Set<string>>(new Set())
	const sessionStartRef = useRef(Math.floor(Date.now() / 1000))

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

	// Proof-on-request confirmation (contract 4.5): watch kind-17 events for this
	// invoice number. The buyer's plain receipt flips the page to "payment
	// detected"; only the watcher-signed confirmed receipt at depth 10 flips it
	// to paid. The buyer does nothing by hand.
	const confirmationEnabled = !!currentInvoice && currentInvoice.status === 'pending'
	const confirmation = useOrderConfirmation({
		invoiceId: currentInvoice?.id || '',
		sessionStartTime: sessionStartRef.current,
		enabled: confirmationEnabled,
	})

	useEffect(() => {
		if (confirmation.state !== 'paid' || !currentInvoice) return
		if (completedInvoicesRef.current.has(currentInvoice.id)) return
		completedInvoicesRef.current.add(currentInvoice.id)
		toast.success('Payment confirmed')
		onPaymentComplete?.(currentInvoice.id, confirmation.proof || '', 'receipt')
	}, [confirmation.state, confirmation.proof, currentInvoice, onPaymentComplete])

	const handleSkipPayment = useCallback(() => {
		if (!currentInvoice) return
		onSkipPayment?.(currentInvoice.id)
	}, [currentInvoice, onSkipPayment])

	const handleOpenInGoblin = useCallback(() => {
		if (!currentInvoice?.payUri) return
		// Deeplink into the Goblin wallet on its own `goblin:` scheme (carries the
		// same recipient/amount/memo as the QR). A clickable `nostr:` link would be
		// routed by desktop OSes to a social client, not the wallet.
		window.location.href = toGoblinDeeplink(currentInvoice.payUri)
	}, [currentInvoice])

	// Early return if no invoice
	if (!currentInvoice) {
		return <div className="text-sm text-muted-foreground p-4">No payment request to display</div>
	}

	// One honest face for this invoice. The buyer's plain receipt (confirmation
	// state 'detected') flips the panel to the calm "sent" face: the QR and Open
	// in Goblin disappear and the copy tells them they can close the page. State
	// model is waiting -> sent/detected -> paid.
	const hasPayUri = !!currentInvoice.payUri
	const display = derivePaymentPanelDisplay({
		invoiceStatus: currentInvoice.status,
		mode,
		hasPayUri,
		confirmationState: confirmation.state,
	})

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
			{display === 'completed' ? (
				<div className="text-center py-8">
					<div className="text-green-600 font-medium mb-2">
						{currentInvoice.status === 'paid' || confirmation.state === 'paid'
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
			) : display === 'sent' ? (
				/* The buyer's plain receipt arrived: no more pay affordances, just a
				   calm confirmation. Nothing on this page needs their attention. */
				<div className="text-center py-8 space-y-3">
					<div className="flex justify-center">
						<div className="flex items-center justify-center w-14 h-14 rounded-full bg-green-100">
							<Check className="w-7 h-7 text-green-600" />
						</div>
					</div>
					<div className="text-green-700 font-medium">Your payment is sent. You can close this page.</div>
					<p className="text-sm text-gray-600">
						{currentInvoice.recipientName} - {formatGrinAmount(currentInvoice.amount)}
					</p>
					{activeIndex < invoices.length - 1 && (
						<Button onClick={() => handleNavigate(activeIndex + 1)} variant="outline">
							Next Payment <ChevronRight className="w-4 h-4 ml-1" />
						</Button>
					)}
				</div>
			) : display === 'no-address' ? (
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
						<QRCode value={currentInvoice.payUri!} size={260} level="M" />
					</div>

					{/* Open in Goblin */}
					<div className="flex justify-center">
						<Button onClick={handleOpenInGoblin} size="lg" className="btn-black px-8">
							<ExternalLink className="w-4 h-4 mr-2" />
							Open in Goblin
						</Button>
					</div>

					{/* Invoice number for reference. The payload rides in the QR and the
					    "Open in Goblin" deep link; there is no copyable pay-URI row to
					    paste by hand (the last-resort manual path lives inside the
					    encrypted order conversation, not here). */}
					<CopyRow label="Invoice number (payment memo)" value={currentInvoice.id} />

					{/* Live status. The buyer's receipt (state model waiting -> sent ->
					    paid) flips this whole panel to the calm "sent" face above, so
					    here we are always still waiting. */}
					<div className="flex items-center justify-center gap-2 text-sm text-gray-600">
						<div className="animate-spin w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full" />
						<span>Waiting for your payment</span>
					</div>

					<p className="text-xs text-gray-500 text-center max-w-md mx-auto">
						No account needed. Scan the QR or open the link in your Goblin wallet. Grin payments are interactive — if the seller&apos;s
						wallet is offline, your payment settles the moment it comes back online, and this order confirms then.
					</p>

					{onSkipPayment && (
						<div className="border-t pt-4">
							<Button variant="ghost" className="w-full text-gray-500" onClick={handleSkipPayment}>
								Pay later
							</Button>
						</div>
					)}
				</div>
			)}
		</div>
	)
}

PaymentContent.displayName = 'PaymentContent'
