import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import type { PaymentInvoiceData } from '@/lib/types/invoice'
import { PaymentContent, type PaymentCompletionSource } from './PaymentContent'

interface PaymentDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	invoices: PaymentInvoiceData[]
	currentIndex?: number
	onPaymentComplete?: (invoiceId: string, proof: string, source: PaymentCompletionSource) => void
	title?: string
	showNavigation?: boolean
	/** Mode controls how skipped invoices are treated */
	mode?: 'checkout' | 'order'
}

export function PaymentDialog({
	open,
	onOpenChange,
	invoices,
	currentIndex = 0,
	onPaymentComplete,
	title = 'Pay with Goblin',
	showNavigation = true,
	mode = 'order',
}: PaymentDialogProps) {
	if (!invoices.length) return null

	const currentInvoice = invoices[currentIndex] || invoices[0]

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center justify-between">{title}</DialogTitle>
					<DialogDescription>
						Complete payment for {currentInvoice.description}.{invoices.length > 1 && ` Payment ${currentIndex + 1} of ${invoices.length}.`}
					</DialogDescription>
				</DialogHeader>

				<PaymentContent
					invoices={invoices}
					currentIndex={currentIndex}
					onPaymentComplete={onPaymentComplete}
					showNavigation={showNavigation}
					mode={mode}
				/>
			</DialogContent>
		</Dialog>
	)
}
