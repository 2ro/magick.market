import { formatGrinAmount } from '@/lib/grin'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { PaymentInvoiceData } from '@/lib/types/invoice'
import { cn, copyToClipboard } from '@/lib/utils'
import { CheckCircle, Copy, CreditCard, RefreshCw, Wallet } from 'lucide-react'
import { getStatusColor } from '../orderDetailHelpers'
import type { InvoiceWithSource } from '../useOrderInvoices'

interface InvoiceCardProps {
	invoice: InvoiceWithSource
	index: number
	totalInvoices: number
	isBuyer: boolean
	isGenerating: boolean
	onPay: (invoice: PaymentInvoiceData) => void
	onGenerateNew: (invoice: PaymentInvoiceData) => void
}

export function InvoiceCard({ invoice, index, totalInvoices, isBuyer, isGenerating, onPay, onGenerateNew }: InvoiceCardProps) {
	const isPaid = invoice.status === 'paid'
	const needsPayment = !isPaid

	const validLocalCopy = invoice.localCopies.find((copy) => copy.status !== 'paid' && copy.payUri)
	const invoiceToUse = validLocalCopy || invoice
	const hasPayUri = !!invoiceToUse.payUri

	return (
		<Card className={cn('p-4', isPaid ? 'bg-green-50' : 'bg-card')}>
			{/* Header row */}
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-3 min-w-0">
					{totalInvoices > 1 && (
						<div
							className={cn(
								'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold',
								isPaid ? 'bg-green-200 text-green-800' : 'bg-gray-200 text-gray-600',
							)}
						>
							{index + 1}
						</div>
					)}
					{isPaid ? (
						<CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
					) : (
						<CreditCard className="w-5 h-5 text-gray-400 flex-shrink-0" />
					)}
					<div className="min-w-0">
						<h4 className="font-medium truncate">Merchant Payment</h4>
						<p className="text-sm text-muted-foreground">
							{formatGrinAmount(invoice.amount)}
							<span className="ml-2 text-gray-400 font-mono">· {invoice.id}</span>
						</p>
					</div>
				</div>
				<Badge className={cn('flex-shrink-0', getStatusColor(isPaid ? 'paid' : 'pending'))} variant="outline">
					{isPaid ? 'Paid' : 'Pending'}
				</Badge>
			</div>

			{/* Payment actions for buyers */}
			{isBuyer && needsPayment && (
				<div className="mt-4 pt-4 border-t border-muted space-y-3">
					<div className="flex flex-wrap gap-2">
						{hasPayUri && (
							<Button size="sm" className="flex-1 min-w-[140px]" onClick={() => onPay(invoiceToUse)}>
								<Wallet className="w-4 h-4 mr-2" />
								Pay {formatGrinAmount(invoice.amount)} with Goblin
							</Button>
						)}

						{!hasPayUri && (
							<Button size="sm" className="flex-1 min-w-[140px]" onClick={() => onGenerateNew(invoice)} disabled={isGenerating}>
								{isGenerating ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
								Prepare Payment
							</Button>
						)}

						{hasPayUri && (
							<Button variant="ghost" size="sm" onClick={() => copyToClipboard(invoiceToUse.payUri || '')} title="Copy Goblin payment link">
								<Copy className="w-4 h-4" />
							</Button>
						)}
					</div>
				</div>
			)}

			{/* Paid confirmation with copy options */}
			{isPaid && (
				<div className="mt-3 pt-3 border-t border-green-200 space-y-2">
					<div className="flex items-center gap-2 text-sm text-green-700">
						<CheckCircle className="w-4 h-4" />
						<span>Payment completed</span>
					</div>
					<div className="flex flex-wrap gap-2">
						{(invoice.proof || invoiceToUse.proof) && (
							<Button
								variant="ghost"
								size="sm"
								className="text-gray-600 hover:text-gray-900 h-auto py-1"
								onClick={() => copyToClipboard(invoice.proof || invoiceToUse.proof || '')}
							>
								<Copy className="w-3 h-3 mr-1" />
								Copy payment proof
							</Button>
						)}
					</div>
				</div>
			)}
		</Card>
	)
}
