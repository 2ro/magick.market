import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { QRCode } from '@/components/ui/qr-code'
import {
	buyerToPubkeyHex,
	grinStringToNanogrinString,
	nanogrinStringToGrinString,
	offerNip05,
	validateExpiration,
} from '@/lib/nameTransfer'
import { authStore } from '@/lib/stores/auth'
import { useCreateTransferOffer, useHeldName, useIncomingOffers, useSubmitTransfer, type IncomingOffer } from '@/queries/nameTransfer'
import { useDashboardTitle } from '@/routes/_dashboard-layout'
import { createFileRoute } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_dashboard-layout/dashboard/products/products/sell-name')({
	component: SellNameComponent,
})

/** The NIP-05 domain names are served under: this instance's own host. */
const NAME_DOMAIN = typeof window !== 'undefined' ? window.location.host : 'magick.market'

const OFFERS_STORAGE_KEY = 'mm-name-sale-offers'

interface StoredOffer {
	offerId: string
	nip05: string
	priceNanogrin: string
	buyerPubkeyHex: string
	payUrl: string
	expiration: number
}

function loadStoredOffers(): StoredOffer[] {
	try {
		const raw = localStorage.getItem(OFFERS_STORAGE_KEY)
		if (!raw) return []
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

function saveStoredOffers(offers: StoredOffer[]) {
	try {
		localStorage.setItem(OFFERS_STORAGE_KEY, JSON.stringify(offers))
	} catch {
		// storage unavailable; Nostr remains the source of truth for the buyer
	}
}

function copyToClipboard(value: string, label: string) {
	void navigator.clipboard
		?.writeText(value)
		.then(() => toast.success(`${label} copied`))
		.catch(() => toast.error('Could not copy to clipboard'))
}

/** Short note: the buyer pays a marketplace GoblinPay invoice, not a raw address. */
function GoblinPayNote() {
	return (
		<p className="text-muted-foreground text-xs leading-relaxed">
			The buyer pays a Goblin invoice, the same way names are bought here. You never paste a grin address. The name moves to the buyer only
			after the payment confirms on chain.
		</p>
	)
}

// =============================================================================
// Seller
// =============================================================================

function SellPanel({ heldName, sellerPubkey }: { heldName: string; sellerPubkey: string }) {
	const nip05 = offerNip05({ name: heldName, domain: NAME_DOMAIN })
	const [priceGrin, setPriceGrin] = useState('')
	const [buyer, setBuyer] = useState('')
	const [validityDays, setValidityDays] = useState('7')
	const [offers, setOffers] = useState<StoredOffer[]>(() => loadStoredOffers().filter((o) => o.nip05 === nip05))

	const createOffer = useCreateTransferOffer()

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		try {
			const buyerPubkeyHex = buyerToPubkeyHex(buyer)
			const priceNanogrin = grinStringToNanogrinString(priceGrin)
			if (priceNanogrin === '0') throw new Error('Enter a price greater than zero')
			const days = Math.min(30, Math.max(1, Math.floor(Number(validityDays) || 0)))
			const expiration = validateExpiration(Math.floor(Date.now() / 1000) + days * 86400)

			const result = await createOffer.mutateAsync({
				name: heldName,
				domain: NAME_DOMAIN,
				buyerPubkeyHex,
				priceNanogrin,
				expiration,
				sellerPubkey,
			})

			const stored: StoredOffer = {
				offerId: result.offerId,
				nip05,
				priceNanogrin,
				buyerPubkeyHex,
				payUrl: result.payUrl,
				expiration,
			}
			const next = [stored, ...loadStoredOffers().filter((o) => o.offerId !== result.offerId)]
			saveStoredOffers(next)
			setOffers(next.filter((o) => o.nip05 === nip05))
			setPriceGrin('')
			setBuyer('')
			toast.success(`Offer created for ${nip05}`)
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not create the offer')
		}
	}

	return (
		<Card className="space-y-4 p-4">
			<div>
				<h2 className="font-semibold text-lg">Sell your name</h2>
				<p className="text-muted-foreground text-sm">
					Reassign <span className="font-medium">{nip05}</span> to a buyer you name. You keep your keys; only the name record moves.
				</p>
			</div>

			<form onSubmit={handleSubmit} className="space-y-4">
				<div className="space-y-1">
					<Label>Name</Label>
					<Input value={nip05} readOnly className="bg-muted" />
				</div>

				<div className="space-y-1">
					<Label htmlFor="price">Price (GRIN)</Label>
					<Input
						id="price"
						inputMode="decimal"
						placeholder="e.g. 12.5"
						value={priceGrin}
						onChange={(e) => setPriceGrin(e.target.value)}
						required
					/>
				</div>

				<div className="space-y-1">
					<Label htmlFor="buyer">Buyer npub</Label>
					<Input id="buyer" placeholder="npub1..." value={buyer} onChange={(e) => setBuyer(e.target.value)} required />
					<p className="text-muted-foreground text-xs">Offers are targeted: only this key can pay for and claim the name.</p>
				</div>

				<div className="space-y-1">
					<Label htmlFor="validity">Offer valid for (days)</Label>
					<Input
						id="validity"
						type="number"
						min={1}
						max={30}
						value={validityDays}
						onChange={(e) => setValidityDays(e.target.value)}
						className="w-32"
					/>
				</div>

				<Button type="submit" disabled={createOffer.isPending}>
					{createOffer.isPending ? 'Creating offer...' : 'Create sale offer'}
				</Button>
			</form>

			<GoblinPayNote />

			{offers.length > 0 && (
				<div className="space-y-3 pt-2 border-t">
					<h3 className="font-medium text-sm">Your offers</h3>
					{offers.map((o) => (
						<div key={o.offerId} className="space-y-1 bg-muted/40 p-3 rounded-md text-sm">
							<div className="flex justify-between gap-2">
								<span className="font-medium">{o.nip05}</span>
								<span className="text-muted-foreground">{nanogrinStringToGrinString(o.priceNanogrin)} GRIN</span>
							</div>
							<p className="text-muted-foreground text-xs break-all">Buyer: {o.buyerPubkeyHex}</p>
							<p className="text-muted-foreground text-xs">Expires: {new Date(o.expiration * 1000).toLocaleString()}</p>
							<div className="flex flex-wrap gap-2 pt-1">
								<Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard(o.payUrl, 'Payment link')}>
									Copy buyer payment link
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => {
										const next = loadStoredOffers().filter((x) => x.offerId !== o.offerId)
										saveStoredOffers(next)
										setOffers(next.filter((x) => x.nip05 === nip05))
									}}
								>
									Remove from list
								</Button>
							</div>
						</div>
					))}
				</div>
			)}
		</Card>
	)
}

// =============================================================================
// Buyer
// =============================================================================

function BuyPanel({ buyerPubkey }: { buyerPubkey: string }) {
	const { data: offers, isLoading } = useIncomingOffers(buyerPubkey)

	return (
		<Card className="space-y-4 p-4">
			<div>
				<h2 className="font-semibold text-lg">Buy a name</h2>
				<p className="text-muted-foreground text-sm">
					Offers sent to your key appear here. Pay the Goblin invoice; the name is yours once it confirms.
				</p>
			</div>

			{isLoading && <p className="text-muted-foreground text-sm">Looking for offers sent to your key...</p>}
			{!isLoading && (!offers || offers.length === 0) && (
				<p className="text-muted-foreground text-sm">No incoming offers yet. Ask a seller to send you an offer for their name.</p>
			)}

			<div className="space-y-4">
				{offers?.map((offer) => (
					<IncomingOfferCard key={offer.view.offerId} offer={offer} />
				))}
			</div>

			<GoblinPayNote />
		</Card>
	)
}

type BuyStatus = 'live' | 'waiting' | 'confirming' | 'confirmed' | 'granting' | 'done' | 'error'

function IncomingOfferCard({ offer }: { offer: IncomingOffer }) {
	const view = offer.view
	const nip05 = offerNip05(view)
	const priceGrin = nanogrinStringToGrinString(view.priceNanogrin)
	const submit = useSubmitTransfer()

	const [status, setStatus] = useState<BuyStatus>('live')
	const [confirmations, setConfirmations] = useState({ n: 0, required: 10 })
	const [message, setMessage] = useState<string | null>(null)
	const claimedRef = useRef(false)

	const expired = view.expiration <= Math.floor(Date.now() / 1000)

	const openInGoblin = () => {
		if (view.payUrl) window.location.href = view.payUrl
	}

	const doClaim = useCallback(async () => {
		if (claimedRef.current) return
		claimedRef.current = true
		setStatus('granting')
		try {
			const result = await submit.mutateAsync({ offer })
			setStatus('done')
			setMessage(`${result.name}@${view.domain} now resolves to your key.`)
			toast.success(`You now own ${result.name}@${view.domain}`)
		} catch (err) {
			claimedRef.current = false
			setStatus('error')
			const msg = err instanceof Error ? err.message : 'Could not complete the transfer'
			setMessage(msg)
			toast.error(msg)
		}
	}, [offer, submit, view.domain])

	// Poll the invoice while the buyer is paying, then auto-claim on confirmation.
	useEffect(() => {
		if (status === 'live' || status === 'confirmed' || status === 'done' || status === 'granting' || status === 'error') return
		let cancelled = false
		const poll = async () => {
			try {
				const res = await fetch(`/api/transfer/invoice/${encodeURIComponent(view.invoiceId)}/status`)
				if (!res.ok || cancelled) return
				const data = await res.json()
				if (cancelled) return
				if (data.status === 'confirmed') {
					setConfirmations({ n: data.confirmations ?? 10, required: data.confirmations_required ?? 10 })
					setStatus('confirmed')
				} else if (data.status === 'paid') {
					setConfirmations({ n: data.confirmations ?? 0, required: data.confirmations_required ?? 10 })
					setStatus('confirming')
				} else {
					setStatus('waiting')
				}
			} catch {
				// transient; keep polling
			}
		}
		poll()
		const timer = setInterval(poll, 5000)
		return () => {
			cancelled = true
			clearInterval(timer)
		}
	}, [status, view.invoiceId])

	// Fire the claim once when the invoice reaches confirmed.
	useEffect(() => {
		if (status === 'confirmed') void doClaim()
	}, [status, doClaim])

	return (
		<div className="space-y-3 p-3 border rounded-md">
			<div className="flex justify-between gap-2">
				<div>
					<p className="font-medium">{nip05}</p>
					<p className="text-muted-foreground text-xs break-all">Seller: {view.sellerPubkeyHex}</p>
				</div>
				<div className="text-right">
					<p className="font-semibold">{priceGrin} GRIN</p>
				</div>
			</div>
			<p className="text-muted-foreground text-xs">Expires: {new Date(view.expiration * 1000).toLocaleString()}</p>

			{expired ? (
				<p className="text-muted-foreground text-sm">This offer has expired.</p>
			) : status === 'done' ? (
				<p className="text-sm text-green-700">{message}</p>
			) : (
				<>
					{(status === 'live' || status === 'waiting' || status === 'confirming' || status === 'error') && (
						<div className="space-y-2">
							<p className="text-sm">
								Pay <span className="font-medium">{priceGrin} GRIN</span> with your Goblin wallet.
							</p>
							<div className="flex flex-col items-center gap-2">
								<QRCode value={view.payUrl} size={180} />
								<div className="flex flex-wrap justify-center gap-2">
									<Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard(view.payUrl, 'Payment link')}>
										Copy pay link
									</Button>
									<Button type="button" size="sm" onClick={openInGoblin}>
										Open in Goblin
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => {
											setMessage(null)
											setStatus('waiting')
										}}
									>
										I have paid
									</Button>
								</div>
							</div>
						</div>
					)}

					{status === 'confirming' && (
						<p className="text-sm text-yellow-700">
							Payment received, confirming on chain ({confirmations.n} of {confirmations.required}).
						</p>
					)}
					{(status === 'confirmed' || status === 'granting') && (
						<p className="text-sm text-green-700">Payment confirmed, transferring the name...</p>
					)}
					{status === 'error' && message && <p className="text-sm text-red-600">{message}</p>}
				</>
			)}
		</div>
	)
}

// =============================================================================
// Route component
// =============================================================================

function SellNameComponent() {
	useDashboardTitle('Names')
	const { user, isAuthenticated } = useStore(authStore)
	const pubkey = user?.pubkey
	const { data: heldName, isLoading } = useHeldName(pubkey)

	if (!isAuthenticated || !pubkey) {
		return <div className="p-6 text-center">Please log in to buy or sell a name.</div>
	}

	return (
		<div className="space-y-6 p-4 lg:p-6">
			<div>
				<h1 className="font-bold text-2xl">Names</h1>
				<p className="text-muted-foreground text-sm">
					Buy or sell a NIP-05 name. The buyer pays a Goblin invoice; no grin address is entered.
				</p>
			</div>

			{isLoading && <p className="text-muted-foreground text-sm">Checking whether you hold a name...</p>}
			{heldName?.name && <SellPanel heldName={heldName.name} sellerPubkey={pubkey} />}

			<BuyPanel buyerPubkey={pubkey} />
		</div>
	)
}
