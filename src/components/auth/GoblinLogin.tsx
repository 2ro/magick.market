import { Button } from '@/components/ui/button'
import { QRCode } from '@/components/ui/qr-code'
import { authActions } from '@/lib/stores/auth'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

const POLL_INTERVAL_MS = 2000
// Mirrors the server's 5-minute challenge TTL: stop polling once it lapses.
const CHALLENGE_TTL_MS = 5 * 60 * 1000

type GoblinLoginPhase = 'loading' | 'waiting' | 'ok' | 'expired' | 'error'

interface GoblinLoginProps {
	onError?: (error: string) => void
	onSuccess?: () => void
}

/**
 * "Sign in with Goblin" tab: requests a one-time challenge from the server and
 * offers two paths sharing that same challenge and status poll. Same-device: a
 * button that deeplinks straight into the Goblin app via the goblin:login URI.
 * Cross-device: a button that reveals a QR code (collapsed by default) to scan
 * with the wallet on another device. On success the session becomes
 * wallet-verified (view only): the pubkey is known but no client-side signer
 * exists.
 */
export function GoblinLogin({ onError, onSuccess }: GoblinLoginProps) {
	const [phase, setPhase] = useState<GoblinLoginPhase>('loading')
	const [loginUri, setLoginUri] = useState('')
	const [showQr, setShowQr] = useState(false)
	const [attempt, setAttempt] = useState(0)

	useEffect(() => {
		let cancelled = false
		let timer: ReturnType<typeof setTimeout> | undefined

		const start = async () => {
			setPhase('loading')
			setLoginUri('')
			setShowQr(false)
			try {
				const res = await fetch('/api/v1/login/challenge', { method: 'POST' })
				if (!res.ok) throw new Error('Could not request a login challenge')
				const { c } = (await res.json()) as { c: string }
				if (cancelled) return

				const callbackUrl = encodeURIComponent(`${window.location.origin}/api/v1/login/callback`)
				setLoginUri(`goblin:login?c=${c}&d=${window.location.host}&cb=${callbackUrl}`)
				setPhase('waiting')

				const deadline = Date.now() + CHALLENGE_TTL_MS
				const poll = async () => {
					if (cancelled) return
					if (Date.now() > deadline) {
						setPhase('expired')
						return
					}
					try {
						const statusRes = await fetch(`/api/v1/login/status?c=${c}`)
						if (statusRes.status === 404) {
							if (!cancelled) setPhase('expired')
							return
						}
						if (statusRes.ok) {
							const data = (await statusRes.json()) as { status: string; pubkey?: string }
							if (data.status === 'ok' && data.pubkey) {
								if (cancelled) return
								authActions.loginWithGoblinPubkey(data.pubkey)
								setPhase('ok')
								return
							}
						}
					} catch {
						// Transient network error: keep polling until the deadline.
					}
					timer = setTimeout(poll, POLL_INTERVAL_MS)
				}
				timer = setTimeout(poll, POLL_INTERVAL_MS)
			} catch (error) {
				if (cancelled) return
				setPhase('error')
				onError?.(error instanceof Error ? error.message : 'Goblin login failed')
			}
		}

		void start()

		return () => {
			cancelled = true
			if (timer) clearTimeout(timer)
		}
		// Re-running on `attempt` mints a fresh challenge after expiry/failure.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [attempt])

	if (phase === 'ok') {
		return (
			<div className="space-y-4 py-4 w-full max-w-full overflow-hidden" data-testid="goblin-login-success">
				<p className="text-sm font-medium">Signed in with your Goblin wallet. Publishing actions will ask for your key.</p>
				<Button onClick={() => onSuccess?.()} className="w-full" data-testid="goblin-login-continue">
					Continue
				</Button>
			</div>
		)
	}

	if (phase === 'expired' || phase === 'error') {
		return (
			<div className="space-y-4 py-4 w-full max-w-full overflow-hidden">
				<p className="text-sm text-muted-foreground" data-testid="goblin-login-expired">
					{phase === 'expired' ? 'This login challenge has expired.' : 'Could not reach the login service.'}
				</p>
				<Button onClick={() => setAttempt((n) => n + 1)} className="w-full" data-testid="goblin-login-retry">
					Try Again
				</Button>
			</div>
		)
	}

	return (
		<div className="space-y-4 py-4 w-full max-w-full overflow-hidden">
			<p className="text-sm text-muted-foreground">Sign a one-time challenge with your Goblin wallet. Your key never leaves your wallet.</p>
			{phase === 'loading' || !loginUri ? (
				<div className="flex justify-center py-8">
					<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
				</div>
			) : (
				<>
					<Button asChild className="w-full" data-testid="goblin-login-deeplink">
						<a href={loginUri}>Log in with Goblin</a>
					</Button>
					<Button variant="outline" className="w-full" onClick={() => setShowQr((visible) => !visible)} data-testid="goblin-login-show-qr">
						{showQr ? 'Hide QR code' : 'Scan from another device'}
					</Button>
					{showQr && (
						<div className="space-y-2">
							<p className="text-center text-xs text-muted-foreground">Scan with your Goblin wallet to sign the challenge.</p>
							<div className="flex justify-center" data-testid="goblin-login-qr">
								<QRCode value={loginUri} size={200} logo showBorder={false} />
							</div>
						</div>
					)}
					<p className="flex items-center justify-center gap-2 text-xs text-muted-foreground" data-testid="goblin-login-waiting">
						<Loader2 className="h-3 w-3 animate-spin" />
						Waiting for your wallet...
					</p>
				</>
			)}
		</div>
	)
}
