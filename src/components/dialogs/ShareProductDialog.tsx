import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

interface ShareProductDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	productId: string
	pubkey: string
	title: string
}

// Share is copy-only. Posting to a Nostr feed required publishing a kind-1 note,
// which the market's relay deliberately blocks (public-note kinds are author-locked
// by policy), so that action always failed ("0 published, 1 required"). We share by
// copying a link or a ready-made blurb instead.
export function ShareProductDialog({ open, onOpenChange, productId, pubkey: _pubkey, title }: ShareProductDialogProps) {
	const [shareText, setShareText] = useState('')
	const [copied, setCopied] = useState<'url' | 'content' | null>(null)

	// Build the product URL
	const productUrl = typeof window !== 'undefined' ? `${window.location.origin}/products/${productId}` : `/products/${productId}`

	// Generate default share text when dialog opens
	useEffect(() => {
		if (open) {
			const defaultText = `Check out "${title}" on Magick!

${productUrl}

#magick`
			setShareText(defaultText)
			setCopied(null)
		}
	}, [open, title, productUrl])

	const copy = async (value: string, which: 'url' | 'content', label: string) => {
		try {
			await navigator.clipboard.writeText(value)
			setCopied(which)
			toast.success(`${label} copied to clipboard!`)
			setTimeout(() => setCopied((c) => (c === which ? null : c)), 2000)
		} catch (error) {
			console.error(`Failed to copy ${which}:`, error)
			toast.error(`Failed to copy ${label.toLowerCase()}`)
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="bg-white max-w-[calc(100%-2rem)] sm:max-w-[40em] max-h-[90vh] overflow-x-hidden overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Share Product</DialogTitle>
					<DialogDescription id="share-dialog-description">
						Copy a link to this product, or copy a ready-made blurb to share.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-6 py-4 overflow-x-hidden">
					<div className="space-y-2">
						<label htmlFor="share-text" className="font-medium text-gray-700 text-sm">
							Shareable text
						</label>
						<Textarea
							id="share-text"
							aria-describedby="share-dialog-description"
							value={shareText}
							onChange={(e) => setShareText(e.target.value)}
							rows={8}
							className="w-full overflow-wrap-anywhere break-words whitespace-pre-wrap resize-none"
							placeholder="Write something about this product..."
						/>
					</div>

					<div className="flex flex-wrap gap-2">
						<Button variant="outline" onClick={() => copy(productUrl, 'url', 'URL')} className="shrink-0">
							{copied === 'url' ? <Check className="mr-2 w-4 h-4" /> : <Copy className="mr-2 w-4 h-4" />}
							{copied === 'url' ? 'Copied!' : 'Copy URL'}
						</Button>

						<Button
							onClick={() => copy(shareText, 'content', 'Content')}
							disabled={!shareText.trim()}
							className="flex flex-1 justify-center items-center gap-2"
						>
							{copied === 'content' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
							{copied === 'content' ? 'Copied!' : 'Copy content'}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}
