import { UserDisplayComponent } from '@/components/UserDisplayComponent'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { fetchLatestAppEvent, ndkActions } from '@/lib/stores/ndk'
import { MERCHANT_ALLOWLIST_DTAG, MERCHANT_ALLOWLIST_KIND, clearMerchantAllowlistCache } from '@/lib/market-scope'
import { addToMarketMerchants, removeFromMarketMerchants } from '@/publish/marketMerchants'
import { useUserRole } from '@/queries/app-settings'
import { useConfigQuery } from '@/queries/config'
import { useDashboardTitle } from '@/routes/_dashboard-layout'
import { npubToHex } from '@/routes/setup'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus, Store, UserMinus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_dashboard-layout/dashboard/app-settings/market-merchants')({
	component: MarketMerchantsComponent,
})

const fetchMerchantAllowlist = async (appPubkey: string): Promise<string[]> => {
	const event = await fetchLatestAppEvent({
		kinds: [MERCHANT_ALLOWLIST_KIND],
		authors: [appPubkey],
		'#d': [MERCHANT_ALLOWLIST_DTAG],
	})
	return event ? Array.from(new Set(event.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]))) : []
}

function MarketMerchantsComponent() {
	useDashboardTitle('Market Merchants')
	const queryClient = useQueryClient()
	const { data: config } = useConfigQuery()
	const appPubkey = config?.appPublicKey || ''
	const { amIAdmin, amIEditor, isLoading: isLoadingPermissions } = useUserRole(appPubkey)

	const { data: merchants = [], isLoading: isLoadingMerchants } = useQuery({
		queryKey: ['marketMerchants', appPubkey],
		queryFn: () => fetchMerchantAllowlist(appPubkey),
		enabled: !!appPubkey,
		staleTime: 30000,
	})

	const [newInput, setNewInput] = useState('')
	const [isAdding, setIsAdding] = useState(false)
	const [removingPubkey, setRemovingPubkey] = useState<string | null>(null)

	const invalidate = () => {
		clearMerchantAllowlistCache()
		queryClient.invalidateQueries({ queryKey: ['marketMerchants', appPubkey] })
	}

	const handleAdd = async () => {
		if (!newInput.trim()) {
			toast.error('Please enter a merchant npub or public key')
			return
		}
		const ndk = ndkActions.getNDK()
		const signer = ndkActions.getSigner()
		if (!ndk || !signer) {
			toast.error('You must be signed in to manage merchants')
			return
		}
		try {
			setIsAdding(true)
			const hexPubkey = npubToHex(newInput.trim())
			await addToMarketMerchants(hexPubkey, signer, ndk, appPubkey)
			setNewInput('')
			invalidate()
			toast.success('Merchant added to the market')
		} catch (error) {
			toast.error(`Failed to add merchant: ${error instanceof Error ? error.message : 'Unknown error'}`)
		} finally {
			setIsAdding(false)
		}
	}

	const handleRemove = async (pubkey: string) => {
		const ndk = ndkActions.getNDK()
		const signer = ndkActions.getSigner()
		if (!ndk || !signer) return
		try {
			setRemovingPubkey(pubkey)
			await removeFromMarketMerchants(pubkey, signer, ndk, appPubkey)
			invalidate()
			toast.success('Merchant removed from the market')
		} catch (error) {
			toast.error(`Failed to remove merchant: ${error instanceof Error ? error.message : 'Unknown error'}`)
		} finally {
			setRemovingPubkey(null)
		}
	}

	if (isLoadingPermissions) {
		return (
			<div className="space-y-6 p-6">
				<div className="animate-pulse">
					<div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
					<div className="h-4 bg-gray-200 rounded w-1/2"></div>
				</div>
			</div>
		)
	}

	if (!amIAdmin && !amIEditor) {
		return (
			<div className="space-y-6 p-6">
				<Card>
					<CardContent className="p-6 text-center">
						<Store className="w-16 h-16 mx-auto text-gray-400 mb-4" />
						<h3 className="text-lg font-medium mb-2">Access Denied</h3>
						<p className="text-gray-600">You don't have permission to manage market merchants.</p>
					</CardContent>
				</Card>
			</div>
		)
	}

	return (
		<div className="space-y-6 p-4 lg:p-8">
			<div className="flex items-center gap-3">
				<Store className="w-6 h-6 text-muted-foreground" />
				<div>
					<h1 className="text-2xl font-bold">Market Merchants</h1>
					<p className="text-muted-foreground text-sm">
						The allowlist that scopes your market. Only these merchants' stalls appear in the shared catalog. When this list is empty, the
						market falls back to showing all content on your relay.
					</p>
				</div>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Store className="w-5 h-5" />
						Market Merchants ({merchants.length})
					</CardTitle>
					<CardDescription>Merchants whose GRIN listings make up your market.</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{isLoadingMerchants ? (
						<div className="text-center py-8 text-gray-500">Loading…</div>
					) : merchants.length === 0 ? (
						<div className="text-center py-8 text-gray-500">
							<Store className="w-12 h-12 mx-auto mb-3 text-gray-300" />
							<p>No merchants added yet. The market is showing all relay content until you add one.</p>
						</div>
					) : (
						<div className="space-y-3">
							{merchants.map((pubkey, index) => (
								<UserDisplayComponent
									key={pubkey}
									userPubkey={pubkey}
									index={index}
									onRemove={() => handleRemove(pubkey)}
									isRemoving={removingPubkey === pubkey}
								/>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Plus className="w-5 h-5" />
						Add Merchant
					</CardTitle>
					<CardDescription>Add a merchant by entering their npub or public key.</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="newMerchant">Npub or Public Key</Label>
						<div className="flex gap-2">
							<Input
								id="newMerchant"
								value={newInput}
								onChange={(e) => setNewInput(e.target.value)}
								placeholder="npub1... or hex pubkey"
								className="flex-1"
							/>
							<Button onClick={handleAdd} disabled={isAdding || !newInput.trim()}>
								{isAdding ? (
									<div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
								) : (
									<UserMinus className="w-4 h-4" />
								)}
								Add
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	)
}
