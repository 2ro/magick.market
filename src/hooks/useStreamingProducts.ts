import { useState, useEffect, useRef, useCallback } from 'react'
import { ndkActions, ndkStore } from '@/lib/stores/ndk'
import { filterBlacklistedEvents } from '@/lib/utils/blacklistFilters'
import { isProductInStock } from '@/queries/products'
import { filterGrinOnly, getMerchantAllowlist } from '@/lib/market-scope'
import type { NDKEvent, NDKFilter, NDKSubscription } from '@nostr-dev-kit/ndk'
import { useStore } from '@tanstack/react-store'

interface UseStreamingProductsOptions {
	/** Maximum number of products to stream */
	limit?: number
	/** Optional tag to filter products by */
	tag?: string
	/** Whether to include hidden products */
	includeHidden?: boolean
	/** Whether to show out of stock products */
	showOutOfStock?: boolean
	/** Whether to hide pre-order products */
	hidePreorder?: boolean
	/** Country name to filter products by location */
	country?: string
}

interface UseStreamingProductsReturn {
	/** Products received so far, sorted by created_at desc */
	products: NDKEvent[]
	/** Whether we're still actively receiving products */
	isStreaming: boolean
	/** Whether NDK is connected */
	isConnected: boolean
	/** Number of products received */
	count: number
}

/**
 * Hook that streams products progressively as they arrive from relays.
 * Products appear immediately as each event is received, rather than waiting for all.
 */
export function useStreamingProducts({
	limit = 500,
	tag,
	includeHidden = false,
	showOutOfStock = false,
	hidePreorder = false,
	country = '',
}: UseStreamingProductsOptions = {}): UseStreamingProductsReturn {
	const [products, setProducts] = useState<NDKEvent[]>([])
	const [isStreaming, setIsStreaming] = useState(true)
	const isConnected = useStore(ndkStore, (s) => s.isConnected)

	// Track seen event IDs to prevent duplicates
	const seenIds = useRef(new Set<string>())
	const subscriptionRef = useRef<NDKSubscription | null>(null)

	// Stable callback to add a product
	const addProduct = useCallback(
		(event: NDKEvent) => {
			const key = event.deduplicationKey()
			if (seenIds.current.has(key)) return
			seenIds.current.add(key)

			// Check visibility
			const visibilityTag = event.tags.find((t) => t[0] === 'visibility')
			const visibility = visibilityTag?.[1] || 'on-sale'

			// Filter hidden products (unless includeHidden is true)
			if (!includeHidden && visibility === 'hidden') return

			// Filter pre-order products (if hidePreorder is true)
			if (hidePreorder && visibility === 'pre-order') return

			// GRIN-only invariant: drop Bitcoin/Lightning-tagged and non-GRIN-priced
			// listings that stream in from the relay (this browse surface has no way to
			// check out with them), same as the non-streaming fetchProducts path.
			if (filterGrinOnly([event], true).length === 0) return

			// Filter out-of-stock products (unless showOutOfStock is true)
			if (!showOutOfStock && !isProductInStock(event)) return

			// Filter by country (match against location tag)
			if (country) {
				const location = event.tags.find((t) => t[0] === 'location')?.[1] || ''
				if (!location.toLowerCase().includes(country.toLowerCase())) return
			}

			// Add product and sort by created_at (newest first)
			setProducts((prev) => {
				const filtered = filterBlacklistedEvents([event])
				if (filtered.length === 0) return prev

				const newProduct = filtered[0]
				const updated = [...prev, newProduct]
				updated.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
				return updated.slice(0, limit)
			})
		},
		[includeHidden, showOutOfStock, hidePreorder, country, limit],
	)

	useEffect(() => {
		const ndk = ndkActions.getNDK()
		if (!ndk) {
			// NDK not ready yet - will re-run when connected
			return
		}

		// Reset state when filter changes
		setProducts([])
		seenIds.current.clear()
		setIsStreaming(true)

		let cancelled = false

		// Timeout fallback - stop streaming after 10s even if no EOSE
		const timeout = setTimeout(() => {
			setIsStreaming(false)
		}, 10000)

		// Scope the stream to the operator's merchant allowlist (closed by default) so
		// this browse surface never leaks the connected relay's firehose of foreign
		// (e.g. upstream Plebeian / Bitcoin) stalls — same scope as fetchProducts.
		void (async () => {
			const allowlist = await getMerchantAllowlist()
			if (cancelled) return

			const filter: NDKFilter = {
				kinds: [30402],
				limit,
				...(allowlist.length > 0 && { authors: allowlist }),
				...(tag && { '#t': [tag] }),
			}

			const subscription = ndk.subscribe(filter, {
				closeOnEose: true,
			})

			subscriptionRef.current = subscription

			subscription.on('event', (event: NDKEvent) => {
				addProduct(event)
			})

			subscription.on('eose', () => {
				setIsStreaming(false)
			})

			subscription.on('close', () => {
				setIsStreaming(false)
			})
		})()

		return () => {
			cancelled = true
			clearTimeout(timeout)
			subscriptionRef.current?.stop()
			subscriptionRef.current = null
		}
	}, [isConnected, tag, limit, addProduct, showOutOfStock, hidePreorder, country])

	return {
		products,
		isStreaming,
		isConnected,
		count: products.length,
	}
}
