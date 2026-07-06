import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { QRCode } from '@/components/ui/qr-code'
import { Textarea } from '@/components/ui/textarea'
import { NAME_AUTHORITY_URL } from '@/lib/constants'
import { toGoblinDeeplink } from '@/lib/grin'
import { AuthorityError } from '@/lib/nameAuthority'
import {
	buildTransferPayUri,
	buyerToPubkeyHex,
	claimErrorMessage,
	grinStringToNanogrinString,
	isRetryableClaimError,
	lodgeErrorMessage,
	nanogrinStringToGrinString,
	offerAuthorityBase,
	offerNip05,
	parsePaymentProofJson,
	validateExpiration,
	validateProofAddress,
	type TransferOfferView,
} from '@/lib/nameTransfer'
import { authStore } from '@/lib/stores/auth'
import { useHeldName, useIncomingOffers, useLodgeOffer, useRevokeOffer, useSubmitClaim, useTransferOffer } from '@/queries/nameTransfer'
import { useDashboardTitle } from '@/routes/_dashboard-layout'
import { createFileRoute } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'
import { useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_dashboard-layout/dashboard/products/products/sell-name')({
	component: SellNameComponent,
})

/** Domain of the default authority, derived from NAME_AUTHORITY_URL (e.g. "goblin.st"). */
const AUTHORITY_DOMAIN = (() => {
	try {
		return new URL(NAME_AUTHORITY_URL).host
	} catch {
		return 'goblin.st'
	}
})()

const OFFERS_STORAGE_KEY = 'mm-name-sale-offers'

interface StoredOffer {
	offerId: string
	base: string
	nip05: string
	priceNanogrin: string
	buyerPubkeyHex: string
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
		// storage unavailable; the authority read remains the source of truth
	}
}

function copyToClipboard(value: string, label: string) {
	void navigator.clipboard
		?.writeText(value)
		.then(() => toast.success(`${label} copied`))
		.catch(() => toast.error('Could not copy to clipboard'))
}

/** Short, plain non-custodial note shown on both sides. */
function NonCustodialNote() {
	return (
		<p className="text-muted-foreground text-xs leading-relaxed">
			magick never touches the money. The payment goes directly from the buyer's wallet to the seller's wallet. magick only helps create,
			publish, and read offers and submit the claim to the name authority.
		</p>
	)
}

// =============================================================================
// Seller
// =============================================================================

function SellPanel({ heldName, sellerPubkey }: { heldName: string; sellerPubkey: string }) {
	const nip05 = `${heldName}@${AUTHORITY_DOMAIN}`
	const [priceGrin, setPriceGrin] = useState('')
	const [buyer, setBuyer] = useState('')
	const [proofAddress, setProofAddress] = useState('')
	const [validityDays, setValidityDays] = useState('7')
	const [offers, setOffers] = useState<StoredOffer[]>(() => loadStoredOffers().filter((o) => o.nip05 === nip05))

	const lodge = useLodgeOffer()

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		try {
			const buyerPubkeyHex = buyerToPubkeyHex(buyer)
			const priceNanogrin = grinStringToNanogrinString(priceGrin)
			if (priceNanogrin === '0') throw new Error('Enter a price greater than zero')
			const address = validateProofAddress(proofAddress)
			const days = Math.min(30, Math.max(1, Math.floor(Number(validityDays) || 0)))
			const expiration = validateExpiration(Math.floor(Date.now() / 1000) + days * 86400)

			const result = await lodge.mutateAsync({
				name: heldName,
				domain: AUTHORITY_DOMAIN,
				buyerPubkeyHex,
				priceNanogrin,
				proofAddress: address,
				expiration,
				base: NAME_AUTHORITY_URL,
			})

			const stored: StoredOffer = {
				offerId: result.offerId,
				base: result.base,
				nip05,
				priceNanogrin,
				buyerPubkeyHex,
				expiration,
			}
			const next = [stored, ...loadStoredOffers().filter((o) => o.offerId !== result.offerId)]
			saveStoredOffers(next)
			setOffers(next.filter((o) => o.nip05 === nip05))
			setPriceGrin('')
			setBuyer('')
			setProofAddress('')
			toast.success(`Offer lodged for ${nip05}`)
		} catch (err) {
			if (err instanceof AuthorityError) toast.error(lodgeErrorMessage(err.status, err.errorCode))
			else toast.error(err instanceof Error ? err.message : 'Could not lodge the offer')
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
					<p className="text-muted-foreground text-xs">Offers are targeted: only this key can claim the name.</p>
				</div>

				<div className="space-y-1">
					<Label htmlFor="proof">One-time proof address</Label>
					<Input id="proof" placeholder="grin1..." value={proofAddress} onChange={(e) => setProofAddress(e.target.value)} required />
					<p className="text-muted-foreground text-xs">
						Paste a fresh grin1 slatepack address generated in your Goblin wallet for this sale only. Never reuse an address from another
						sale or your default receive address.
					</p>
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

				<Button type="submit" disabled={lodge.isPending}>
					{lodge.isPending ? 'Lodging offer...' : 'Create sale offer'}
				</Button>
			</form>

			<NonCustodialNote />

			{offers.length > 0 && (
				<div className="space-y-3 pt-2 border-t">
					<h3 className="font-medium text-sm">Your offers</h3>
					{offers.map((o) => (
						<SellerOfferRow
							key={o.offerId}
							offer={o}
							onRevoked={() => {
								const next = loadStoredOffers().filter((x) => x.offerId !== o.offerId)
								saveStoredOffers(next)
								setOffers(next.filter((x) => x.nip05 === nip05))
							}}
						/>
					))}
				</div>
			)}
		</Card>
	)
}

function SellerOfferRow({ offer, onRevoked }: { offer: StoredOffer; onRevoked: () => void }) {
	const { data, isLoading } = useTransferOffer(offer.offerId, offer.base, 30000)
	const revoke = useRevokeOffer()
	const status = data?.status
	const priceGrin = nanogrinStringToGrinString(offer.priceNanogrin)

	const handleRevoke = async () => {
		try {
			await revoke.mutateAsync({ base: offer.base, offerId: offer.offerId })
			toast.success('Offer revoked')
			onRevoked()
		} catch (err) {
			if (err instanceof AuthorityError) toast.error(lodgeErrorMessage(err.status, err.errorCode))
			else toast.error(err instanceof Error ? err.message : 'Could not revoke the offer')
		}
	}

	return (
		<div className="space-y-1 bg-muted/40 p-3 rounded-md text-sm">
			<div className="flex justify-between gap-2">
				<span className="font-medium">{offer.nip05}</span>
				<span className="text-muted-foreground">{priceGrin} GRIN</span>
			</div>
			<p className="text-muted-foreground text-xs break-all">Buyer: {offer.buyerPubkeyHex}</p>
			<p className="text-muted-foreground text-xs">Expires: {new Date(offer.expiration * 1000).toLocaleString()}</p>
			<p className="text-xs">
				Status: <span className="font-medium">{isLoading ? 'checking...' : (status ?? 'unknown')}</span>
			</p>
			{status === 'live' && (
				<Button variant="destructive" size="sm" onClick={handleRevoke} disabled={revoke.isPending}>
					{revoke.isPending ? 'Revoking...' : 'Revoke'}
				</Button>
			)}
		</div>
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
				<p className="text-muted-foreground text-sm">Offers sent to your key appear here. Pay the seller directly, then claim the name.</p>
			</div>

			{isLoading && <p className="text-muted-foreground text-sm">Looking for offers sent to your key...</p>}
			{!isLoading && (!offers || offers.length === 0) && (
				<p className="text-muted-foreground text-sm">No incoming offers yet. Ask a seller to send you an offer for their name.</p>
			)}

			<div className="space-y-4">
				{offers?.map((offer) => (
					<IncomingOfferCard key={offer.offerId} offer={offer} buyerPubkey={buyerPubkey} />
				))}
			</div>

			<NonCustodialNote />
		</Card>
	)
}

function IncomingOfferCard({ offer, buyerPubkey }: { offer: TransferOfferView; buyerPubkey: string }) {
	const base = offerAuthorityBase(offer)
	const nip05 = offerNip05(offer)
	const priceGrin = nanogrinStringToGrinString(offer.priceNanogrin)
	const payUri = buildTransferPayUri(offer)

	const { data: offerStatus } = useTransferOffer(offer.offerId, base, 30000)
	const { data: heldName } = useHeldName(buyerPubkey, base)
	const submitClaim = useSubmitClaim()

	const [proofText, setProofText] = useState('')
	const [result, setResult] = useState<string | null>(null)

	const status = offerStatus?.status
	const alreadyHoldsName = !!heldName

	const handleClaim = async (e: React.FormEvent) => {
		e.preventDefault()
		setResult(null)
		try {
			const proof = parsePaymentProofJson(proofText)
			const claim = await submitClaim.mutateAsync({ base, offerId: offer.offerId, proof })
			setResult(`${claim.nip05} now resolves to your key.`)
			toast.success(`You now own ${claim.nip05}`)
		} catch (err) {
			if (err instanceof AuthorityError) {
				const message = claimErrorMessage(err.status, err.errorCode)
				toast[isRetryableClaimError(err.status, err.errorCode) ? 'message' : 'error'](message)
				setResult(message)
			} else {
				const message = err instanceof Error ? err.message : 'Could not complete the claim'
				toast.error(message)
				setResult(message)
			}
		}
	}

	return (
		<div className="space-y-3 p-3 border rounded-md">
			<div className="flex justify-between gap-2">
				<div>
					<p className="font-medium">{nip05}</p>
					<p className="text-muted-foreground text-xs break-all">Seller: {offer.sellerPubkeyHex}</p>
				</div>
				<div className="text-right">
					<p className="font-semibold">{priceGrin} GRIN</p>
					<p className="text-muted-foreground text-xs">{status ? `Status: ${status}` : 'Status: checking...'}</p>
				</div>
			</div>
			<p className="text-muted-foreground text-xs">Expires: {new Date(offer.expiration * 1000).toLocaleString()}</p>

			{alreadyHoldsName && (
				<div className="bg-amber-50 p-2 border border-amber-300 rounded text-amber-900 text-xs">
					Your key already holds <span className="font-medium">{heldName?.name}</span> on {offer.domain}. Release it before you pay, or the
					claim will be rejected. The offer and your proof stay valid after you release.
				</div>
			)}

			{status === 'live' ? (
				<>
					<div className="space-y-2">
						<p className="text-sm">
							Pay the seller exactly <span className="font-medium">{priceGrin} GRIN</span> peer to peer from your Goblin wallet, with
							payment proof enabled.
						</p>
						<div className="flex flex-col items-center gap-2">
							<QRCode value={payUri} size={180} logo />
							<div className="flex flex-wrap justify-center gap-2">
								<Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard(payUri, 'Pay URI')}>
									Copy pay URI
								</Button>
								<Button type="button" variant="outline" size="sm" asChild>
									<a href={toGoblinDeeplink(payUri)}>Open in Goblin</a>
								</Button>
							</div>
						</div>
					</div>

					<form onSubmit={handleClaim} className="space-y-2">
						<Label htmlFor={`proof-${offer.offerId}`}>Payment proof</Label>
						<Textarea
							id={`proof-${offer.offerId}`}
							placeholder="Paste the six-field payment proof JSON exported by your wallet"
							value={proofText}
							onChange={(e) => setProofText(e.target.value)}
							rows={5}
						/>
						<Button type="submit" disabled={submitClaim.isPending}>
							{submitClaim.isPending ? 'Verifying payment on chain...' : 'Claim name'}
						</Button>
					</form>
				</>
			) : (
				<p className="text-muted-foreground text-sm">This offer is not live ({status ?? 'unknown'}), so it cannot be claimed.</p>
			)}

			{result && <p className="text-sm">{result}</p>}
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
				<p className="text-muted-foreground text-sm">Buy or sell a NIP-05 name. Payment is wallet to wallet; magick never holds funds.</p>
			</div>

			{isLoading && <p className="text-muted-foreground text-sm">Checking whether you hold a name...</p>}
			{heldName?.name && <SellPanel heldName={heldName.name} sellerPubkey={pubkey} />}

			<BuyPanel buyerPubkey={pubkey} />
		</div>
	)
}
