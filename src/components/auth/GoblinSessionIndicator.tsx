import { goblinSessionStore } from '@/lib/stores/goblinSession'
import { useStore } from '@tanstack/react-store'
import { Loader2 } from 'lucide-react'

/**
 * Global "confirm in your wallet" indicator for a live Goblin trust session.
 *
 * When a request stays outstanding past the hint delay (a money-tier sign such
 * as a payment or a 30402 listing publish awaiting the wallet's password
 * prompt, a pay-committing encrypt, or a backgrounded wallet), the session
 * store's pendingConfirmCount rises and this fixed banner tells the user to
 * look at their wallet, rather than leaving the action silently spinning (spec
 * 5.4, two response timings; section 7 "confirm in your wallet"). Mounted at
 * the root layout, so it covers every flow including the dashboard listing
 * publish form.
 */
export function GoblinSessionIndicator() {
	const { status, pendingConfirmCount } = useStore(goblinSessionStore)
	if (status !== 'confirm' || pendingConfirmCount < 1) return null

	return (
		<div
			className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit max-w-[90vw] items-center gap-2 rounded-full border border-amber-400/60 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 shadow-lg dark:border-amber-500/40 dark:bg-amber-950 dark:text-amber-100"
			role="status"
			data-testid="goblin-session-confirm"
		>
			<Loader2 className="h-4 w-4 animate-spin" />
			Confirm in your wallet
			{pendingConfirmCount > 1 ? ` (${pendingConfirmCount})` : ''}
		</div>
	)
}
