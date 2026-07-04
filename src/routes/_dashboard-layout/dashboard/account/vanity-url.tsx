import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { ndkActions } from '@/lib/stores/ndk'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { QRCode } from '@/components/ui/qr-code'
import { toast } from 'sonner'
import { useDashboardTitle } from '@/routes/_dashboard-layout'
import { useConfigQuery } from '@/queries/config'
import { useVanitySettings, getVanityForPubkey, getExpiredVanityForPubkey } from '@/queries/vanity'
import { vanityActions } from '@/lib/stores/vanity'
import { VANITY_PRICING, VANITY_GRIN_RECIPIENT_NPUB, VANITY_GRIN_RECIPIENT_PUBKEY } from '@/server/VanityManager'
import { buildGoblinPayUri, formatGrinAmount, mintInvoiceNumber, looksLikeGrinPaymentProof } from '@/lib/grin'
import { AlertCircle, CheckCircle2, Clock, ExternalLink, Copy, Coins, RefreshCw, Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export const Route = createFileRoute('/_dashboard-layout/dashboard/account/vanity-url')({
	component: VanityUrlComponent,
})

function VanityUrlComponent() {
	useDashboardTitle('Vanity URL')
	const ndk = ndkActions.getNDK()
	const pubkey = ndk?.activeUser?.pubkey

	const { data: config } = useConfigQuery()
	const { data: vanitySettings, isLoading } = useVanitySettings(config?.appPublicKey)

	const [vanityName, setVanityName] = useState('')
	const [isChecking, setIsChecking] = useState(false)

	// Get current user's vanity URL
	const currentVanity = useMemo(() => {
		if (!pubkey || !vanitySettings) return null
		return getVanityForPubkey(vanitySettings, pubkey)
	}, [pubkey, vanitySettings])

	// Get expired vanity URLs for renewal
	const expiredVanities = useMemo(() => {
		if (!pubkey || !vanitySettings) return []
		return getExpiredVanityForPubkey(vanitySettings, pubkey)
	}, [pubkey, vanitySettings])

	// Validation state
	const [validationState, setValidationState] = useState<{
		isValid: boolean
		isAvailable: boolean | null
		message: string
	}>({
		isValid: false,
		isAvailable: null,
		message: '',
	})

	// Validate vanity name as user types
	useEffect(() => {
		if (!vanityName) {
			setIsChecking(false)
			setValidationState({ isValid: false, isAvailable: null, message: '' })
			return
		}

		const normalized = vanityName.toLowerCase()

		// Check format
		if (!vanityActions.isValidVanityName(normalized)) {
			setIsChecking(false)
			setValidationState({
				isValid: false,
				isAvailable: null,
				message: 'Must be 3-30 characters, alphanumeric with hyphens/underscores',
			})
			return
		}

		// Check reserved
		if (vanityActions.isReservedName(normalized)) {
			setIsChecking(false)
			setValidationState({
				isValid: false,
				isAvailable: false,
				message: 'This name is reserved and cannot be used',
			})
			return
		}

		// Check availability
		setIsChecking(true)
		const timer = setTimeout(() => {
			const available = vanityActions.isVanityAvailable(normalized)
			setValidationState({
				isValid: true,
				isAvailable: available,
				message: available ? 'This name is available!' : 'This name is already taken',
			})
			setIsChecking(false)
		}, 300)

		return () => {
			clearTimeout(timer)
			setIsChecking(false)
		}
	}, [vanityName])

	// Format expiration date
	const formatExpiration = (timestamp: number) => {
		const date = new Date(timestamp * 1000)
		const now = new Date()
		const msLeft = date.getTime() - now.getTime()

		// Check if expired
		if (msLeft <= 0) {
			return {
				date: date.toLocaleDateString(),
				timeLeft: 'Expired',
				daysLeft: 0,
				isExpired: true,
				isExpiringSoon: true,
			}
		}

		const secondsLeft = Math.floor(msLeft / 1000)
		const minutesLeft = Math.floor(msLeft / (1000 * 60))
		const hoursLeft = Math.floor(msLeft / (1000 * 60 * 60))
		const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24))

		let timeLeft: string
		if (secondsLeft < 60) {
			timeLeft = `${secondsLeft} seconds`
		} else if (minutesLeft < 60) {
			timeLeft = `${minutesLeft} minutes`
		} else if (hoursLeft < 24) {
			timeLeft = `${hoursLeft} hours`
		} else {
			timeLeft = `${daysLeft} days`
		}

		return {
			date: date.toLocaleDateString(),
			timeLeft,
			daysLeft,
			isExpired: false,
			isExpiringSoon: daysLeft <= 30,
		}
	}

	// Copy vanity URL to clipboard
	const copyVanityUrl = () => {
		if (!currentVanity) return
		const url = `${window.location.origin}/${currentVanity.vanityName}`
		navigator.clipboard.writeText(url)
		toast.success('Vanity URL copied to clipboard!')
	}

	// GRIN payment state for the purchase dialog
	const [paymentState, setPaymentState] = useState<{
		isOpen: boolean
		invoiceId: string
		vanityName: string
		tierKey: string
		amountNanogrin: number
		payUri: string
		submitting: boolean
		proofDraft: string
		showProofImport: boolean
	}>({
		isOpen: false,
		invoiceId: '',
		vanityName: '',
		tierKey: '',
		amountNanogrin: 0,
		payUri: '',
		submitting: false,
		proofDraft: '',
		showProofImport: false,
	})

	const handlePurchase = (tierKey: string) => {
		const tier = VANITY_PRICING[tierKey]
		if (!pubkey) {
			toast.error('Please connect your Nostr account')
			return
		}
		if (!tier) return
		if (!validationState.isValid || validationState.isAvailable === false) {
			toast.error('Please choose a valid and available vanity name')
			return
		}

		const invoiceId = mintInvoiceNumber()
		const payUri = buildGoblinPayUri({ to: VANITY_GRIN_RECIPIENT_NPUB, amountNanogrin: tier.nanogrin, memo: invoiceId })

		setPaymentState({
			isOpen: true,
			invoiceId,
			vanityName: vanityName.toLowerCase(),
			tierKey,
			amountNanogrin: tier.nanogrin,
			payUri,
			submitting: false,
			proofDraft: '',
			showProofImport: false,
		})
	}

	const closePaymentDialog = () => setPaymentState((s) => ({ ...s, isOpen: false }))

	const handleOpenInGoblin = useCallback(() => {
		if (!paymentState.payUri) return
		window.location.href = paymentState.payUri
	}, [paymentState.payUri])

	const copyPaymentValue = useCallback(async (value: string) => {
		try {
			await navigator.clipboard.writeText(value)
			toast.success('Copied to clipboard')
		} catch {
			toast.error('Could not copy to clipboard')
		}
	}, [])

	/**
	 * Submit a buyer-signed Grin payment receipt (kind 17) to the server for
	 * verification and registration. See handleGrinPurchase in
	 * src/server/VanityManager.ts for the server-side check.
	 */
	const submitClaim = useCallback(async (event: unknown) => {
		try {
			const res = await fetch('/api/vanity/claim', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ event }),
			})
			const data = await res.json()
			if (!res.ok) {
				toast.error(data?.error || 'Payment could not be verified')
				return false
			}
			toast.success(`/${data.vanityName} registered!`)
			setPaymentState((s) => ({ ...s, isOpen: false }))
			return true
		} catch (error) {
			console.error('Failed to submit vanity URL payment claim:', error)
			toast.error('Failed to verify payment')
			return false
		}
	}, [])

	/**
	 * Buyer pastes the receiver-signed Grin payment proof Goblin shows after the
	 * payment finalizes — the same "proof-import" shape checkout and the NIP-05
	 * page use (see src/publish/payment.tsx).
	 */
	const handleProofImport = async () => {
		const proof = paymentState.proofDraft.trim()
		if (!looksLikeGrinPaymentProof(proof)) {
			toast.error('That does not look like a Grin payment proof. Copy it from Goblin after the payment finalizes.')
			return
		}

		const ndk = ndkActions.getNDK()
		const signer = ndkActions.getSigner()
		if (!ndk || !signer) {
			toast.error('No signer available')
			return
		}

		setPaymentState((s) => ({ ...s, submitting: true }))
		try {
			const tier = VANITY_PRICING[paymentState.tierKey]
			const event = new NDKEvent(ndk)
			event.kind = 17
			event.content = `Vanity URL: ${paymentState.vanityName} (${tier?.label ?? ''})`
			event.tags = [
				['p', VANITY_GRIN_RECIPIENT_PUBKEY],
				['subject', 'vanity-receipt'],
				['vanity', paymentState.vanityName],
				['payment-request', paymentState.invoiceId],
				['payment', 'grin', paymentState.invoiceId, proof],
				['amount', paymentState.amountNanogrin.toString()],
			]
			event.created_at = Math.floor(Date.now() / 1000)
			await event.sign(signer)
			await ndkActions.publishEvent(event)
			await submitClaim(event.rawEvent())
		} catch (error) {
			console.error('Failed to publish vanity URL payment receipt:', error)
			toast.error('Failed to publish payment proof')
		} finally {
			setPaymentState((s) => ({ ...s, submitting: false }))
		}
	}

	if (!pubkey) {
		return (
			<div className="space-y-6 p-4 lg:p-8">
				<h1 className="text-2xl font-bold">Vanity URL</h1>
				<p className="text-muted-foreground">Please connect your Nostr account to manage your vanity URL.</p>
			</div>
		)
	}

	return (
		<div>
			<div className="hidden lg:flex sticky top-0 z-10 bg-white border-b py-4 px-4 lg:px-6 items-center justify-between">
				<h1 className="text-2xl font-bold">Vanity URL</h1>
			</div>

			<div className="space-y-6 p-4 lg:p-8">
				{isLoading ? (
					<div className="flex items-center justify-center p-8">
						<div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full"></div>
					</div>
				) : (
					<>
						{/* Current Vanity URL Status */}
						{currentVanity ? (
							<Card>
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<CheckCircle2 className="h-5 w-5 text-green-500" />
										Your Vanity URL
									</CardTitle>
									<CardDescription>Your custom vanity URL is active and ready to share</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									<div className="flex items-center gap-2 p-4 bg-muted rounded-lg">
										<code className="text-lg font-mono flex-1">
											{window.location.origin}/{currentVanity.vanityName}
										</code>
										<Button variant="ghost" size="icon" onClick={copyVanityUrl}>
											<Copy className="h-4 w-4" />
										</Button>
										<Button variant="ghost" size="icon" asChild>
											<a href={`/${currentVanity.vanityName}`} target="_blank" rel="noopener noreferrer">
												<ExternalLink className="h-4 w-4" />
											</a>
										</Button>
									</div>

									<div className="flex items-center gap-2">
										<Clock className="h-4 w-4 text-muted-foreground" />
										<span className="text-sm text-muted-foreground">Expires: {formatExpiration(currentVanity.validUntil).date}</span>
										{formatExpiration(currentVanity.validUntil).isExpiringSoon && (
											<Badge variant="destructive" className="text-xs">
												{formatExpiration(currentVanity.validUntil).timeLeft} left
											</Badge>
										)}
									</div>
								</CardContent>
							</Card>
						) : (
							<Card>
								<CardHeader>
									<CardTitle>No Vanity URL</CardTitle>
									<CardDescription>Register a custom vanity URL for your profile</CardDescription>
								</CardHeader>
							</Card>
						)}

						{/* Expired Vanity URLs */}
						{expiredVanities.length > 0 && (
							<Card>
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<Clock className="h-5 w-5 text-orange-500" />
										Expired Vanity URLs
									</CardTitle>
									<CardDescription>These vanity URLs have expired. Renew them to keep your custom links.</CardDescription>
								</CardHeader>
								<CardContent className="space-y-3">
									{expiredVanities.map((expired) => (
										<div
											key={expired.vanityName}
											className="flex items-center justify-between p-3 bg-muted/50 rounded-lg border border-orange-200"
										>
											<div className="flex items-center gap-3">
												<code className="font-mono text-sm">/{expired.vanityName}</code>
												<Badge variant="outline" className="text-xs text-orange-600 border-orange-300">
													Expired {new Date(expired.validUntil * 1000).toLocaleDateString()}
												</Badge>
											</div>
											<Button
												variant="outline"
												size="sm"
												className="flex items-center gap-2"
												onClick={() => {
													setVanityName(expired.vanityName)
													// Scroll to registration section
													document.getElementById('vanity-register-section')?.scrollIntoView({ behavior: 'smooth' })
												}}
											>
												<RefreshCw className="h-4 w-4" />
												Renew
											</Button>
										</div>
									))}
								</CardContent>
							</Card>
						)}

						{/* Register New Vanity URL */}
						<Card id="vanity-register-section">
							<CardHeader>
								<CardTitle>{currentVanity ? 'Change or Extend' : 'Register'} Vanity URL</CardTitle>
								<CardDescription>Choose a custom URL for your profile. This will be your shareable link.</CardDescription>
							</CardHeader>
							<CardContent className="space-y-6">
								<div className="space-y-2">
									<Label htmlFor="vanityName">Vanity Name</Label>
									<div className="flex items-center gap-2">
										<span className="text-muted-foreground">{window.location.host}/</span>
										<Input
											id="vanityName"
											value={vanityName}
											onChange={(e) => setVanityName(e.target.value.toLowerCase())}
											placeholder="your-name"
											className="flex-1"
										/>
									</div>
									{(validationState.message || isChecking) && (
										<p
											className={`text-sm flex items-center gap-1 ${
												validationState.isAvailable === true
													? 'text-green-600'
													: validationState.isAvailable === false
														? 'text-red-600'
														: 'text-muted-foreground'
											}`}
										>
											{validationState.isAvailable === true && <CheckCircle2 className="h-4 w-4" />}
											{validationState.isAvailable === false && <AlertCircle className="h-4 w-4" />}
											{isChecking ? 'Checking availability…' : validationState.message}
										</p>
									)}
								</div>

								{/* Pricing Tiers */}
								<div className="space-y-3">
									<Label>Select Duration</Label>
									<div className="space-y-2">
										{Object.entries(VANITY_PRICING).map(([key, tier]) => (
											<button
												key={key}
												type="button"
												disabled={!validationState.isValid || validationState.isAvailable === false}
												className={`w-full flex items-center gap-4 p-4 border rounded-lg transition-all hover:border-yellow-500 hover:bg-yellow-500/5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer`}
												onClick={() => handlePurchase(key)}
											>
												<div className="flex items-center justify-center w-10 h-10 rounded-full bg-yellow-500/10">
													<Coins className="h-5 w-5 text-yellow-500" />
												</div>
												<div className="flex-1 text-left">
													<p className="font-semibold">{tier.label}</p>
													<p className="text-sm text-muted-foreground">
														{tier.seconds ? `${tier.seconds} seconds` : `${tier.days} days`} validity
													</p>
												</div>
												<div className="text-right">
													<p className="font-bold text-lg text-yellow-500">{formatGrinAmount(tier.nanogrin)}</p>
												</div>
											</button>
										))}
									</div>
								</div>
							</CardContent>
						</Card>
					</>
				)}
			</div>

			{/* Grin payment dialog */}
			<Dialog open={paymentState.isOpen} onOpenChange={(open) => !open && closePaymentDialog()}>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>Pay with Goblin</DialogTitle>
					</DialogHeader>
					<div className="space-y-5">
						<div className="text-center space-y-1">
							<div className="text-3xl font-bold">{formatGrinAmount(paymentState.amountNanogrin)}</div>
							<div className="text-sm text-gray-600">
								/{paymentState.vanityName} — {VANITY_PRICING[paymentState.tierKey]?.label}
							</div>
						</div>

						<div className="flex justify-center">
							<QRCode value={paymentState.payUri} size={220} level="M" />
						</div>

						<div className="flex justify-center">
							<Button onClick={handleOpenInGoblin} size="lg" className="btn-black px-8">
								<ExternalLink className="w-4 h-4 mr-2" />
								Open in Goblin
							</Button>
						</div>

						<button
							type="button"
							onClick={() => copyPaymentValue(paymentState.payUri)}
							className="w-full flex items-center justify-between gap-2 rounded-lg border bg-gray-50 px-3 py-2 text-left hover:bg-gray-100"
						>
							<div className="min-w-0">
								<div className="text-xs text-gray-500">Payment link</div>
								<div className="text-sm font-mono truncate">{paymentState.payUri}</div>
							</div>
							<Copy className="w-4 h-4 shrink-0 text-gray-500" />
						</button>

						<p className="text-xs text-gray-500 text-center">
							Scan or open the link in your Goblin wallet. Grin payments are interactive — after it finalizes, Goblin shows you a
							receiver-signed payment proof.
						</p>

						<div className="border-t pt-4 space-y-3">
							{!paymentState.showProofImport ? (
								<Button variant="outline" className="w-full" onClick={() => setPaymentState((s) => ({ ...s, showProofImport: true }))}>
									<Check className="w-4 h-4 mr-2" />I paid — import proof from Goblin
								</Button>
							) : (
								<div className="space-y-2">
									<label className="text-sm font-medium">Paste the payment proof from Goblin</label>
									<Textarea
										value={paymentState.proofDraft}
										onChange={(e) => setPaymentState((s) => ({ ...s, proofDraft: e.target.value }))}
										placeholder="Paste the Grin payment proof here"
										rows={4}
										className="font-mono text-xs"
									/>
									<div className="flex gap-2">
										<Button
											onClick={handleProofImport}
											disabled={!paymentState.proofDraft.trim() || paymentState.submitting}
											className="flex-1 btn-black"
										>
											{paymentState.submitting ? 'Verifying…' : 'Submit proof'}
										</Button>
										<Button variant="ghost" onClick={() => setPaymentState((s) => ({ ...s, showProofImport: false }))}>
											Cancel
										</Button>
									</div>
								</div>
							)}
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	)
}
