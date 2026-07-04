import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useStore } from '@tanstack/react-store'
import { toast } from 'sonner'
import { NDKUser } from '@nostr-dev-kit/ndk'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProductCard } from '@/components/ProductCard'
import { ItemGrid } from '@/components/ItemGrid'
import { useProductsByPubkey } from '@/queries/products'
import { filterGrinOnly } from '@/lib/market-scope'
import { importedSourcesStore, importedSourcesActions } from '@/lib/stores/imported-sources'
import { X } from 'lucide-react'

export const Route = createFileRoute('/imported')({
	component: ImportedSourcesPage,
})

const shortId = (pubkey: string): string => {
	try {
		return new NDKUser({ pubkey }).npub.slice(0, 12) + '…'
	} catch {
		return pubkey.slice(0, 12) + '…'
	}
}

function ImportedSourceSection({ pubkey }: { pubkey: string }) {
	const { data: products = [] } = useProductsByPubkey(pubkey)
	// Enforce the GRIN-only invariant on imported items too (Bitcoin never meshes,
	// even in a viewer's own imported scope).
	const grinProducts = filterGrinOnly(products, true)

	return (
		<section className="space-y-4">
			<div className="flex items-center justify-between">
				<h2 className="font-heading text-lg">{shortId(pubkey)}</h2>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => importedSourcesActions.remove(pubkey)}
					aria-label={`Remove imported source ${shortId(pubkey)}`}
				>
					<X className="w-4 h-4" /> Remove
				</Button>
			</div>
			{grinProducts.length === 0 ? (
				<p className="text-sm text-muted-foreground">No GRIN listings found for this source yet.</p>
			) : (
				<ItemGrid className="gap-4 sm:gap-8">
					{grinProducts.map((product) => (
						<ProductCard key={product.id} product={product} />
					))}
				</ItemGrid>
			)}
		</section>
	)
}

function ImportedSourcesPage() {
	const { sources } = useStore(importedSourcesStore)
	const [input, setInput] = useState('')

	const handleAdd = () => {
		if (!input.trim()) return
		try {
			importedSourcesActions.add(input)
			setInput('')
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Invalid source')
		}
	}

	return (
		<div className="mx-auto max-w-6xl px-4 py-8 space-y-8">
			<header className="space-y-2">
				<h1 className="font-theylive text-3xl">Imported sources</h1>
				<p className="text-sm text-muted-foreground max-w-2xl">
					Browse a merchant or store you found elsewhere on Nostr. Imported sources are private to this device: they are never published,
					never shared, and never mixed into the main market. Only their GRIN listings are shown.
				</p>
			</header>

			<div className="flex gap-2 max-w-xl">
				<Input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
					placeholder="npub1… / nprofile1… / hex pubkey"
					aria-label="Import a market source"
				/>
				<Button onClick={handleAdd} disabled={!input.trim()}>
					Import
				</Button>
			</div>

			{sources.length === 0 ? (
				<p className="text-muted-foreground">You have not imported any sources yet.</p>
			) : (
				<div className="space-y-10">
					{sources.map((pubkey) => (
						<ImportedSourceSection key={pubkey} pubkey={pubkey} />
					))}
				</div>
			)}
		</div>
	)
}
