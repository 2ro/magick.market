import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { ndkActions } from '@/lib/stores/ndk'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { QRCode } from '@/components/ui/qr-code'
import { toast } from 'sonner'
import { useDashboardTitle } from '@/routes/_dashboard-layout'
import { useConfigQuery } from '@/queries/config'
import { useNip05Settings, getNip05ForPubkey, getExpiredNip05ForPubkey } from '@/queries/nip05'
import { nip05Actions } from '@/lib/stores/nip05'
import { NIP05_PRICING, NIP05_GRIN_RECIPIENT_PUBKEY } from '@/server/Nip05Manager'
import { formatGrinAmount } from '@/lib/grin'
import { AlertCircle, CheckCircle2, Clock, Copy, Coins, RefreshCw, AtSign, ExternalLink, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export const Route = createFileRoute('/_dashboard-layout/dashboard/account/nostr-address')({
	component: NostrAddressComponent,
})

function NostrAddressComponent() {
	useDashboardTitle('Nostr Address (NIP-05)')
	const ndk = ndkActions.getNDK()
	const pubkey = ndk?.activeUser?.pubkey

	const { data: config } = useConfigQuery()
	const { data: nip05Settings, isLoading } = useNip05Settings(config?.appPublicKey)

	const [username, setUsername] = useState('')
	const [isChecking, setIsChecking] = useState(false)

	// Get current user's NIP-05 address
	const currentNip05 = useMemo(() => {
		if (!pubkey || !nip05Settings) return null
		return getNip05ForPubkey(nip05Settings, pubkey)
	}, [pubkey, nip05Settings])

	// Get expired entries for renewal
	const expiredNip05s = useMemo(() => {
		if (!pubkey || !nip05Settings) return []
		return getExpiredNip05ForPubkey(nip05Settings, pubkey)
	}, [pubkey, nip05Settings])

	const domain = typeof window !== 'undefined' ? window.location.hostname : ''

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

	useEffect(() => {
		if (!username) {
			setIsChecking(false)
			setValidationState({ isValid: false, isAvailable: null, message: '' })
			return
		}

		const normalized = username.toLowerCase()

		if (!nip05Actions.isValidUsername(normalized)) {
			setIsChecking(false)
			setValidationState({
				isValid: false,
				isAvailable: null,
				message: 'Must be 1-30 characters, alphanumeric with hyphens, underscores, or dots',
			})
			return
		}

		// Check reserved
		if (nip05Actions.isReservedName(normalized)) {
			setIsChecking(false)
			setValidationState({
				isValid: false,
				isAvailable: false,
				message: 'This username is reserved and cannot be used',
			})
			return
		}

		// Check availability
		setIsChecking(true)
		const timer = setTimeout(() => {
			const available = nip05Actions.isUsernameAvailable(normalized)
			setValidationState({
				isValid: true,
				isAvailable: available,
				message: available ? 'This username is available!' : 'This username is already taken',
			})
			setIsChecking(false)
		}, 300)

		return () => {
			clearTimeout(timer)
			setIsChecking(false)
		}
	}, [username])

	// Format expiration date
	const formatExpiration = (timestamp: number) => {
		const date = new Date(timestamp * 1000)
		const now = new Date()
		const msLeft = date.getTime() - now.getTime()

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

	const copyNip05Address = () => {
		if (!currentNip05) return
		const address = `${currentNip05.username}@${domain}`
		navigator.clipboard.writeText(address)
		toast.success('Nostr address copied to clipboard!')
	}

	// Live purchase state: mint a REAL GoblinPay invoice, deep-link the wallet,
	// poll status, and auto-claim the name once the payment confirms on-chain.
	type PurchaseStatus = 'creating' | 'waiting' | 'confirming' | 'confirmed' | 'granting' | 'error'
	const [paymentState, setPaymentState] = useState<{
		isOpen: boolean
		invoiceId: string
		payUrl: string
		username: string
		tierKey: string
		amountNanogrin: number
		status: PurchaseStatus
		confirmations: number
		confirmationsRequired: number
		error: string
	}>({
		isOpen: false,
		invoiceId: '',
		payUrl: '',
		username: '',
		tierKey: '',
		amountNanogrin: 0,
		status: 'creating',
		confirmations: 0,
		confirmationsRequired: 10,
		error: '',
	})

	// Guards a single auto-claim per confirmed invoice.
	const claimedInvoiceRef = useRef<string>('')

	const closePaymentDialog = () => setPaymentState((s) => ({ ...s, isOpen: false }))

	const handleOpenInGoblin = useCallback(() => {
		if (!paymentState.payUrl) return
		window.location.href = paymentState.payUrl
	}, [paymentState.payUrl])

	const copyPaymentValue = useCallback(async (value: string) => {
		try {
			await navigator.clipboard.writeText(value)
			toast.success('Copied to clipboard')
		} catch {
			toast.error('Could not copy to clipboard')
		}
	}, [])

	// Ask the server to mint a real GoblinPay invoice for this name+tier, then
	// open the pay dialog. The funds go wallet-to-wallet to the marketplace till.
	const handlePurchase = async (tierKey: string) => {
		const tier = NIP05_PRICING[tierKey]
		if (!pubkey) {
			toast.error('Please connect your Nostr account')
			return
		}
		if (!tier) return
		if (!validationState.isValid || validationState.isAvailable === false) {
			toast.error('Please choose a valid and available username')
			return
		}

		const name = username.toLowerCase()
		claimedInvoiceRef.current = ''
		setPaymentState({
			isOpen: true,
			invoiceId: '',
			payUrl: '',
			username: name,
			tierKey,
			amountNanogrin: tier.nanogrin,
			status: 'creating',
			confirmations: 0,
			confirmationsRequired: 10,
			error: '',
		})

		try {
			const res = await fetch('/api/nip05/invoice', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, tier: tierKey, pubkey }),
			})
			const data = await res.json()
			if (!res.ok) {
				setPaymentState((s) => ({ ...s, status: 'error', error: data?.error || 'Could not create an invoice' }))
				return
			}
			setPaymentState((s) => ({ ...s, invoiceId: data.invoice_id, payUrl: data.pay_url, status: 'waiting' }))
		} catch (error) {
			console.error('Failed to create NIP-05 invoice:', error)
			setPaymentState((s) => ({ ...s, status: 'error', error: 'Could not reach the payment service' }))
		}
	}

	// Sign the buyer's pubkey-ownership authorization (kind 17, carrying the
	// invoice id) and submit it. The server grants the name only if GoblinPay
	// reports the invoice confirmed on-chain. Runs once, when status hits confirmed.
	const autoClaim = useCallback(async () => {
		const { invoiceId, username: name, tierKey } = paymentState
		if (!invoiceId || claimedInvoiceRef.current === invoiceId) return
		claimedInvoiceRef.current = invoiceId

		const ndk = ndkActions.getNDK()
		const signer = ndkActions.getSigner()
		if (!ndk || !signer) {
			setPaymentState((s) => ({ ...s, status: 'error', error: 'No signer available' }))
			return
		}

		setPaymentState((s) => ({ ...s, status: 'granting' }))
		try {
			const tier = NIP05_PRICING[tierKey]
			const event = new NDKEvent(ndk)
			event.kind = 17
			event.content = `NIP-05 Address: ${name} (${tier?.label ?? ''})`
			event.tags = [
				['p', NIP05_GRIN_RECIPIENT_PUBKEY],
				['subject', 'nip05-receipt'],
				['nip05', name],
				['invoice', invoiceId],
			]
			event.created_at = Math.floor(Date.now() / 1000)
			await event.sign(signer)
			await ndkActions.publishEvent(event)

			const res = await fetch('/api/nip05/claim', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ event: event.rawEvent() }),
			})
			const data = await res.json()
			if (!res.ok) {
				setPaymentState((s) => ({ ...s, status: 'error', error: data?.error || 'The name could not be granted' }))
				return
			}
			toast.success(`@${data.username} registered!`)
			setPaymentState((s) => ({ ...s, isOpen: false }))
		} catch (error) {
			console.error('Failed to claim NIP-05 name:', error)
			setPaymentState((s) => ({ ...s, status: 'error', error: 'Failed to publish the claim' }))
		}
	}, [paymentState.invoiceId, paymentState.username, paymentState.tierKey])

	// Poll invoice status while the dialog is open and the payment is unresolved.
	// open -> waiting; paid -> confirming (n of 10); confirmed -> claim.
	useEffect(() => {
		const { isOpen, invoiceId, status } = paymentState
		if (!isOpen || !invoiceId) return
		if (status === 'confirmed' || status === 'granting' || status === 'error') return

		let cancelled = false
		const poll = async () => {
			try {
				const res = await fetch(`/api/nip05/invoice/${encodeURIComponent(invoiceId)}/status`)
				if (!res.ok || cancelled) return
				const data = await res.json()
				if (cancelled) return
				if (data.status === 'confirmed') {
					setPaymentState((s) => ({
						...s,
						status: 'confirmed',
						confirmations: data.confirmations ?? s.confirmations,
						confirmationsRequired: data.confirmations_required ?? s.confirmationsRequired,
					}))
				} else if (data.status === 'paid') {
					setPaymentState((s) => ({
						...s,
						status: 'confirming',
						confirmations: data.confirmations ?? 0,
						confirmationsRequired: data.confirmations_required ?? s.confirmationsRequired,
					}))
				} else {
					setPaymentState((s) => ({ ...s, status: 'waiting' }))
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
	}, [paymentState.isOpen, paymentState.invoiceId, paymentState.status])

	// Fire the claim exactly once when the payment reaches confirmed.
	useEffect(() => {
		if (paymentState.isOpen && paymentState.status === 'confirmed') {
			autoClaim()
		}
	}, [paymentState.isOpen, paymentState.status, autoClaim])

	if (!pubkey) {
		return (
			<div className="space-y-6 p-4 lg:p-8">
				<h1 className="text-2xl font-bold">Nostr Address (NIP-05)</h1>
				<p className="text-muted-foreground">Please connect your Nostr account to manage your Nostr address.</p>
			</div>
		)
	}

	return (
		<div>
			<div className="hidden lg:flex sticky top-0 z-10 bg-white border-b py-4 px-4 lg:px-6 items-center justify-between">
				<h1 className="text-2xl font-bold">Nostr Address (NIP-05)</h1>
			</div>

			<div className="space-y-6 p-4 lg:p-8">
				{isLoading ? (
					<div className="flex items-center justify-center p-8">
						<div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full"></div>
					</div>
				) : (
					<>
						{/* Current NIP-05 Address Status */}
						{currentNip05 ? (
							<Card>
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<CheckCircle2 className="h-5 w-5 text-green-500" />
										Your Nostr Address
									</CardTitle>
									<CardDescription>Your NIP-05 address is active and ready to use</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4">
									<div className="flex items-center gap-2 p-4 bg-muted rounded-lg">
										<AtSign className="h-5 w-5 text-muted-foreground" />
										<code className="text-lg font-mono flex-1">
											{currentNip05.username}@{domain}
										</code>
										<Button variant="ghost" size="icon" onClick={copyNip05Address}>
											<Copy className="h-4 w-4" />
										</Button>
									</div>

									<div className="flex items-center gap-2">
										<Clock className="h-4 w-4 text-muted-foreground" />
										<span className="text-sm text-muted-foreground">Expires: {formatExpiration(currentNip05.validUntil).date}</span>
										{formatExpiration(currentNip05.validUntil).isExpiringSoon && (
											<Badge variant="destructive" className="text-xs">
												{formatExpiration(currentNip05.validUntil).timeLeft} left
											</Badge>
										)}
									</div>

									<p className="text-sm text-muted-foreground">
										Set this as your NIP-05 address in your Nostr profile to verify your identity.
									</p>
								</CardContent>
							</Card>
						) : (
							<Card>
								<CardHeader>
									<CardTitle>No Nostr Address</CardTitle>
									<CardDescription>Register a NIP-05 address to verify your identity on Nostr</CardDescription>
								</CardHeader>
							</Card>
						)}

						{/* Expired NIP-05 Addresses */}
						{expiredNip05s.length > 0 && (
							<Card>
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<Clock className="h-5 w-5 text-orange-500" />
										Expired Nostr Addresses
									</CardTitle>
									<CardDescription>These addresses have expired. Renew them to keep your identity verified.</CardDescription>
								</CardHeader>
								<CardContent className="space-y-3">
									{expiredNip05s.map((expired) => (
										<div
											key={expired.username}
											className="flex items-center justify-between p-3 bg-muted/50 rounded-lg border border-orange-200"
										>
											<div className="flex items-center gap-3">
												<code className="font-mono text-sm">
													{expired.username}@{domain}
												</code>
												<Badge variant="outline" className="text-xs text-orange-600 border-orange-300">
													Expired {new Date(expired.validUntil * 1000).toLocaleDateString()}
												</Badge>
											</div>
											<Button
												variant="outline"
												size="sm"
												className="flex items-center gap-2"
												onClick={() => {
													setUsername(expired.username)
													document.getElementById('nip05-register-section')?.scrollIntoView({ behavior: 'smooth' })
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

						{/* Register New NIP-05 Address */}
						<Card id="nip05-register-section">
							<CardHeader>
								<CardTitle>{currentNip05 ? 'Change or Extend' : 'Register'} Nostr Address</CardTitle>
								<CardDescription>
									Choose a username for your NIP-05 address. This will be your verifiable identity on Nostr.
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-6">
								<div className="space-y-2">
									<Label htmlFor="nip05Username">Username</Label>
									<div className="flex items-center gap-2">
										<Input
											id="nip05Username"
											value={username}
											onChange={(e) => setUsername(e.target.value.toLowerCase())}
											placeholder="your-name"
											className="flex-1"
										/>
										<span className="text-muted-foreground">@{domain}</span>
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
										{Object.entries(NIP05_PRICING).map(([key, tier]) => (
											<button
												key={key}
												type="button"
												disabled={!validationState.isValid || validationState.isAvailable === false}
												className={`w-full flex items-center gap-4 p-4 border rounded-lg transition-all hover:border-yellow-500 hover:bg-yellow-500/5 disabled:opacity-50 disabled:cursor-not-allowed`}
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
								{paymentState.username}@{domain} — {NIP05_PRICING[paymentState.tierKey]?.label}
							</div>
						</div>

						{paymentState.status === 'creating' && (
							<div className="flex flex-col items-center gap-2 py-8 text-gray-600">
								<Loader2 className="w-6 h-6 animate-spin" />
								<span className="text-sm">Creating your invoice…</span>
							</div>
						)}

						{paymentState.status === 'error' && (
							<div className="flex flex-col items-center gap-3 py-6">
								<AlertCircle className="w-6 h-6 text-red-500" />
								<p className="text-sm text-red-600 text-center">{paymentState.error || 'Something went wrong'}</p>
								<Button variant="outline" onClick={closePaymentDialog}>
									Close
								</Button>
							</div>
						)}

						{(paymentState.status === 'waiting' ||
							paymentState.status === 'confirming' ||
							paymentState.status === 'confirmed' ||
							paymentState.status === 'granting') && (
							<>
								{paymentState.status === 'waiting' ? (
									<>
										<div className="flex justify-center">
											<QRCode value={paymentState.payUrl} size={220} level="M" />
										</div>

										<div className="flex justify-center">
											<Button onClick={handleOpenInGoblin} size="lg" className="btn-black px-8">
												<ExternalLink className="w-4 h-4 mr-2" />
												Open in Goblin
											</Button>
										</div>

										<button
											type="button"
											onClick={() => copyPaymentValue(paymentState.payUrl)}
											className="w-full flex items-center justify-between gap-2 rounded-lg border bg-gray-50 px-3 py-2 text-left hover:bg-gray-100"
										>
											<div className="min-w-0">
												<div className="text-xs text-gray-500">Payment link</div>
												<div className="text-sm font-mono truncate">{paymentState.payUrl}</div>
											</div>
											<Copy className="w-4 h-4 shrink-0 text-gray-500" />
										</button>

										<div className="flex items-center justify-center gap-2 text-sm text-gray-600">
											<Loader2 className="w-4 h-4 animate-spin" />
											Waiting for payment…
										</div>
									</>
								) : (
									<div className="flex flex-col items-center gap-3 py-6">
										{paymentState.status === 'granting' ? (
											<>
												<Loader2 className="w-6 h-6 animate-spin text-green-600" />
												<p className="text-sm font-medium text-green-700">Payment confirmed — activating your name…</p>
											</>
										) : paymentState.status === 'confirmed' ? (
											<>
												<CheckCircle2 className="w-6 h-6 text-green-600" />
												<p className="text-sm font-medium text-green-700">Payment confirmed</p>
											</>
										) : (
											<>
												<Loader2 className="w-6 h-6 animate-spin text-yellow-600" />
												<p className="text-sm font-medium">Payment received — confirming on-chain</p>
												<p className="text-sm text-gray-600">
													{paymentState.confirmations} of {paymentState.confirmationsRequired} confirmations
												</p>
											</>
										)}
									</div>
								)}

								<p className="text-xs text-gray-500 text-center border-t pt-4">
									Your payment goes wallet-to-wallet to the marketplace till wallet. The name activates automatically after 10 network
									confirmations, typically a few minutes. You can keep this open or come back.
								</p>
							</>
						)}
					</div>
				</DialogContent>
			</Dialog>
		</div>
	)
}
