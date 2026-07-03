import { nip19 } from 'nostr-tools'
import { Card } from '@/components/ui/card'
import { UserCard } from '../UserCard'

interface RecipientPreviewProps {
	npub: string
	percentage: number
	hasGrinAddress: boolean | undefined
	isLoading: boolean
}

export function RecipientPreview({ npub, percentage, hasGrinAddress, isLoading }: RecipientPreviewProps) {
	if (!npub) return null

	let pubkey: string = npub

	// Convert npub to hex pubkey if needed
	if (npub.startsWith('npub')) {
		try {
			const { data } = nip19.decode(npub)
			if (typeof data === 'string') {
				pubkey = data
			}
		} catch (error) {
			// Invalid npub, but still show something
			return (
				<Card className="p-3 border-dashed border-orange-300 bg-orange-50 mt-2">
					<div className="text-sm text-orange-700">Invalid npub format</div>
				</Card>
			)
		}
	}

	if (isLoading) {
		return (
			<Card className="p-3 border-dashed mt-2">
				<div className="flex items-center gap-2">
					<div className="h-6 w-6 rounded-full bg-gray-200 animate-pulse"></div>
					<div className="flex-1 h-4 bg-gray-200 animate-pulse rounded"></div>
					<div className="text-sm text-gray-500">Checking Goblin GRIN address...</div>
				</div>
			</Card>
		)
	}

	return (
		<Card className={`p-3 border-dashed ${hasGrinAddress ? 'border-green-300 bg-green-50' : 'border-red-300 bg-red-50'} mt-2`}>
			<div className="flex items-center gap-2">
				<UserCard pubkey={pubkey} size="xs" />
				<div className="flex-grow"></div>
				<div className="font-semibold">{percentage}%</div>
				{hasGrinAddress === false && <div className="text-sm text-red-600">No Goblin GRIN address configured</div>}
			</div>
		</Card>
	)
}
