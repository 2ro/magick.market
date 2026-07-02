import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { formatGrinAmount } from '@/lib/grin'
import { decodeOrderCode, getGuestOrders, type GuestOrderRecord } from '@/lib/stores/guestOrders'
import { ndkActions } from '@/lib/stores/ndk'
import { NDKPrivateKeySigner, type NDKEvent } from '@nostr-dev-kit/ndk'
import { createFileRoute } from '@tanstack/react-router'
import { Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/track')({
	component: TrackOrderPage,
})

interface TrackedOrderState {
	orderId: string
	invoiceNumber: string
	pubkey: string
	sellerPubkey?: string
	amountNanogrin?: number
	statusUpdates: Array<{ status: string; content: string; createdAt: number; tracking?: string }>
	paid: boolean
	loading: boolean
}

/**
 * Anonymous order tracking (M3): no account required. The buyer pastes the
 * order code from checkout (or picks one saved on this device); the code
 * re-derives the one-time order key, and we read the seller's kind 16 status
 * updates addressed to that ephemeral npub plus kind 17 payment receipts for
 * the order.
 */
function TrackOrderPage() {
	const [codeDraft, setCodeDraft] = useState('')
	const [tracked, setTracked] = useState<TrackedOrderState | null>(null)
	const [deviceOrders, setDeviceOrders] = useState<GuestOrderRecord[]>([])

	useEffect(() => {
		setDeviceOrders(getGuestOrders())
	}, [])

	const loadOrder = useCallback(
		async (params: { sk: string; orderId: string; invoiceNumber: string; sellerPubkey?: string; amountNanogrin?: number }) => {
			const ndk = ndkActions.getNDK()
			if (!ndk) {
				toast.error('Not connected yet - try again in a moment')
				return
			}

			let pubkey: string
			try {
				const signer = new NDKPrivateKeySigner(params.sk)
				pubkey = (await signer.user()).pubkey
			} catch {
				toast.error('Invalid order code')
				return
			}

			setTracked({
				orderId: params.orderId,
				invoiceNumber: params.invoiceNumber,
				pubkey,
				sellerPubkey: params.sellerPubkey,
				amountNanogrin: params.amountNanogrin,
				statusUpdates: [],
				paid: false,
				loading: true,
			})

			try {
				// Status updates (kind 16) are addressed to the ephemeral guest npub.
				const statusEvents = await ndk.fetchEvents({ kinds: [16 as number], '#p': [pubkey] })
				const updates: TrackedOrderState['statusUpdates'] = []
				for (const event of Array.from(statusEvents) as NDKEvent[]) {
					const orderTag = event.tags.find((tag) => tag[0] === 'order')?.[1]
					if (orderTag !== params.orderId) continue
					const status = event.tags.find((tag) => tag[0] === 'status')?.[1]
					if (!status) continue
					updates.push({
						status,
						content: event.content || '',
						createdAt: event.created_at || 0,
						tracking: event.tags.find((tag) => tag[0] === 'tracking')?.[1],
					})
				}
				updates.sort((a, b) => b.createdAt - a.createdAt)

				// Payment receipts (kind 17) matching the invoice number mark the order paid.
				const receiptEvents = await ndk.fetchEvents({ kinds: [17 as number], '#order': [params.orderId] })
				let paid = false
				for (const event of Array.from(receiptEvents) as NDKEvent[]) {
					const paymentRequestTag = event.tags.find((tag) => tag[0] === 'payment-request')?.[1]
					const paymentTag = event.tags.find((tag) => tag[0] === 'payment')
					if (paymentRequestTag === params.invoiceNumber || paymentTag?.[2] === params.invoiceNumber) {
						paid = true
						break
					}
				}

				setTracked((prev) =>
					prev && prev.orderId === params.orderId
						? {
								...prev,
								statusUpdates: updates,
								paid,
								loading: false,
							}
						: prev,
				)
			} catch (error) {
				console.error('Failed to load order status:', error)
				setTracked((prev) => (prev && prev.orderId === params.orderId ? { ...prev, loading: false } : prev))
				toast.error('Could not load order status from relays')
			}
		},
		[],
	)

	const handleTrackByCode = useCallback(() => {
		const code = decodeOrderCode(codeDraft)
		if (!code) {
			toast.error('That order code could not be read. Paste the full code from checkout.')
			return
		}
		loadOrder({ sk: code.sk, orderId: code.orderId, invoiceNumber: code.invoiceNumber, sellerPubkey: code.sellerPubkey })
	}, [codeDraft, loadOrder])

	return (
		<div className="max-w-2xl mx-auto px-4 py-10 space-y-6 flex-grow w-full">
			<div>
				<h1 className="text-2xl font-bold mb-2">Track your order</h1>
				<p className="text-sm text-gray-600">
					No account needed. Paste the order code you saved at checkout, or pick an order placed on this device.
				</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Order code</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<Textarea
						value={codeDraft}
						onChange={(e) => setCodeDraft(e.target.value)}
						placeholder="mmorder1..."
						rows={3}
						className="font-mono text-xs"
					/>
					<Button onClick={handleTrackByCode} disabled={!codeDraft.trim()} className="btn-black">
						Track order
					</Button>
				</CardContent>
			</Card>

			{deviceOrders.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Your orders on this device</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2">
						{deviceOrders.map((order) => (
							<button
								key={order.orderId}
								type="button"
								onClick={() =>
									loadOrder({
										sk: order.secretKeyHex,
										orderId: order.orderId,
										invoiceNumber: order.invoiceNumber,
										sellerPubkey: order.sellerPubkey,
										amountNanogrin: order.amountNanogrin,
									})
								}
								className="w-full flex items-center justify-between gap-2 rounded-lg border bg-gray-50 px-3 py-2 text-left hover:bg-gray-100"
							>
								<div className="min-w-0">
									<div className="text-sm font-medium truncate">Invoice {order.invoiceNumber}</div>
									<div className="text-xs text-gray-500">
										{new Date(order.createdAt).toLocaleString()} · {formatGrinAmount(order.amountNanogrin)}
									</div>
								</div>
								<span className="text-xs text-gray-500 shrink-0">View</span>
							</button>
						))}
					</CardContent>
				</Card>
			)}

			{tracked && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center justify-between text-base">
							<span>Order status</span>
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									loadOrder({
										sk: '',
										orderId: tracked.orderId,
										invoiceNumber: tracked.invoiceNumber,
									})
								}
								className="hidden"
							>
								<RefreshCw className="w-4 h-4" />
							</Button>
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
							<div>
								<div className="text-xs text-gray-500">Invoice number</div>
								<div className="font-mono">{tracked.invoiceNumber}</div>
							</div>
							<div>
								<div className="text-xs text-gray-500">Payment</div>
								{tracked.loading ? (
									<div className="flex items-center gap-2 text-gray-600">
										<Loader2 className="w-3 h-3 animate-spin" /> Checking...
									</div>
								) : tracked.paid ? (
									<span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
										Paid
									</span>
								) : (
									<span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
										Settling privately over Nostr
									</span>
								)}
							</div>
							{typeof tracked.amountNanogrin === 'number' && (
								<div>
									<div className="text-xs text-gray-500">Amount</div>
									<div>{formatGrinAmount(tracked.amountNanogrin)}</div>
								</div>
							)}
						</div>

						<div>
							<div className="text-xs text-gray-500 mb-2">Seller updates</div>
							{tracked.loading ? (
								<div className="flex items-center gap-2 text-sm text-gray-600">
									<Loader2 className="w-4 h-4 animate-spin" /> Loading updates...
								</div>
							) : tracked.statusUpdates.length === 0 ? (
								<p className="text-sm text-gray-600">No updates from the seller yet. Check back later.</p>
							) : (
								<ul className="space-y-2">
									{tracked.statusUpdates.map((update, i) => (
										<li key={i} className="rounded-lg border bg-gray-50 px-3 py-2">
											<div className="flex items-center justify-between">
												<span className="text-sm font-medium capitalize">{update.status}</span>
												<span className="text-xs text-gray-500">{new Date(update.createdAt * 1000).toLocaleString()}</span>
											</div>
											{update.content && <p className="text-xs text-gray-600 mt-1">{update.content}</p>}
											{update.tracking && <p className="text-xs font-mono text-gray-600 mt-1">Tracking: {update.tracking}</p>}
										</li>
									))}
								</ul>
							)}
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	)
}
