import { Button } from '@/components/ui/button'
import { QRCode } from '@/components/ui/qr-code'
import { withReturnFlag } from '@/lib/goblin/session/protocol'
import { authActions } from '@/lib/stores/auth'
import { goblinSessionActions, goblinSessionStore } from '@/lib/stores/goblinSession'
import { useStore } from '@tanstack/react-store'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

const POLL_INTERVAL_MS = 2000
// Mirrors the server's 5-minute challenge TTL: stop polling once it lapses.
const CHALLENGE_TTL_MS = 5 * 60 * 1000

type GoblinLoginPhase = 'loading' | 'waiting' | 'ok' | 'expired' | 'error'

// Two modes share one "Sign in with Goblin" surface (spec section 4.1):
//  - 'trust'  establishes a signing session ("Trust <domain>") so the site can
//             sign low-risk events for the session without a prompt each time.
//  - 'view'   the original wallet-verified, view-only login (no client signer).
type GoblinLoginMode = 'trust' | 'view'

interface GoblinLoginProps {
	onError?: (error: string) => void
	onSuccess?: () => void
}

/**
 * "Sign in with Goblin" tab. The primary path is a trust SESSION: the wallet
 * proves identity AND opens an encrypted signing channel, so publishing actions
 * are signed silently for low-risk kinds while money always re-prompts in the
 * wallet. A view-only fallback keeps the original behavior for users who prefer
 * to approve every signature out of band.
 */
export function GoblinLogin({ onError, onSuccess }: GoblinLoginProps) {
	const [mode, setMode] = useState<GoblinLoginMode>('trust')
	const [phase, setPhase] = useState<GoblinLoginPhase>('loading')
	const [loginUri, setLoginUri] = useState('')
	const [showQr, setShowQr] = useState(false)
	const [attempt, setAttempt] = useState(0)
	const session = useStore(goblinSessionStore)

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

				const callbackUrl = `${window.location.origin}/api/v1/login/callback`

				if (mode === 'trust') {
					// Fold login into the trust grant: open the channel, show the
					// goblin:trust URI, and complete when the wallet sends session-open.
					const { uri, ready } = goblinSessionActions.beginTrust({
						challenge: c,
						domain: window.location.host,
						callbackUrl,
					})
					setLoginUri(uri)
					setPhase('waiting')
					ready
						.then(({ identityPubkey }) => {
							if (cancelled) return
							const signer = goblinSessionActions.getSigner()
							if (!signer) throw new Error('Session opened without a signer')
							authActions.loginWithGoblinTrust(identityPubkey, signer)
							setPhase('ok')
						})
						.catch((error) => {
							if (cancelled) return
							setPhase('error')
							onError?.(error instanceof Error ? error.message : 'Goblin session failed')
						})
					return
				}

				// View-only mode: the original challenge + status-poll login.
				setLoginUri(`goblin:login?c=${c}&d=${window.location.host}&cb=${encodeURIComponent(callbackUrl)}`)
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
		// Re-running mints a fresh challenge after expiry/failure or a mode switch.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [attempt, mode])

	if (phase === 'ok') {
		return (
			<div className="space-y-4 py-4 w-full max-w-full overflow-hidden" data-testid="goblin-login-success">
				<p className="text-sm font-medium">
					{mode === 'trust'
						? 'Trusted for this session. Low-risk actions sign silently; buying or selling still asks your wallet.'
						: 'Signed in with your Goblin wallet. Publishing actions will ask for your key.'}
				</p>
				<Button onClick={() => onSuccess?.()} className="w-full" data-testid="goblin-login-continue">
					Continue
				</Button>
			</div>
		)
	}

	// A live session that the wallet revoked or that expired: degrade to a clear
	// re-login affordance rather than a silent hang (spec section 6 / 7).
	if (session.status === 'ended') {
		return (
			<div className="space-y-4 py-4 w-full max-w-full overflow-hidden">
				<p className="text-sm text-muted-foreground" data-testid="goblin-session-ended">
					Your Goblin session ended{session.endedReason === 'revoked' ? ' (you ended it in your wallet)' : ''}. Sign in again to keep going.
				</p>
				<Button
					onClick={() => {
						goblinSessionActions.reset()
						setAttempt((n) => n + 1)
					}}
					className="w-full"
					data-testid="goblin-session-relogin"
				>
					Trust this site again
				</Button>
			</div>
		)
	}

	if (phase === 'expired' || phase === 'error') {
		return (
			<div className="space-y-4 py-4 w-full max-w-full overflow-hidden">
				<p className="text-sm text-muted-foreground" data-testid="goblin-login-expired">
					{phase === 'expired' ? 'This login challenge has expired.' : 'Could not reach your wallet.'}
				</p>
				<Button onClick={() => setAttempt((n) => n + 1)} className="w-full" data-testid="goblin-login-retry">
					Try Again
				</Button>
			</div>
		)
	}

	return (
		<div className="space-y-4 py-4 w-full max-w-full overflow-hidden">
			<p className="text-sm text-muted-foreground">
				{mode === 'trust'
					? 'Trust this site for the session so it can sign low-risk actions without asking each time. Buying and selling always ask your wallet. Your key never leaves it.'
					: 'Sign a one-time challenge with your Goblin wallet. Your key never leaves your wallet.'}
			</p>
			{phase === 'loading' || !loginUri ? (
				<div className="flex justify-center py-8">
					<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
				</div>
			) : (
				<>
					<Button asChild className="w-full" data-testid="goblin-login-deeplink">
						{/* Same-device tap: keep return-to-caller (flag absent) so the wallet bounces back here. */}
						<a href={withReturnFlag(loginUri, true)}>{mode === 'trust' ? 'Trust for this session' : 'Log in with Goblin'}</a>
					</Button>
					<Button variant="outline" className="w-full" onClick={() => setShowQr((visible) => !visible)} data-testid="goblin-login-show-qr">
						{showQr ? 'Hide QR code' : 'Scan from another device'}
					</Button>
					{showQr && (
						<div className="space-y-2">
							<p className="text-center text-xs text-muted-foreground">Scan with your Goblin wallet to approve.</p>
							<div className="flex justify-center" data-testid="goblin-login-qr">
								{/* Scanned from another screen/device: no caller to return to, so suppress the bounce. */}
								<QRCode value={withReturnFlag(loginUri, false)} size={200} showBorder={false} />
							</div>
						</div>
					)}
					<p className="flex items-center justify-center gap-2 text-xs text-muted-foreground" data-testid="goblin-login-waiting">
						<Loader2 className="h-3 w-3 animate-spin" />
						{session.status === 'confirm' ? 'Confirm in your wallet...' : 'Waiting for your wallet...'}
					</p>
					<button
						type="button"
						onClick={() => setMode((m) => (m === 'trust' ? 'view' : 'trust'))}
						className="w-full text-center text-xs text-muted-foreground underline"
						data-testid="goblin-login-mode-toggle"
					>
						{mode === 'trust' ? 'Prefer to approve every action? Sign in view-only' : 'Trust this site for the session instead'}
					</button>
				</>
			)}
		</div>
	)
}
