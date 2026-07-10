interface PriceDisplayProps {
	/** The price value as a decimal GRIN amount */
	priceValue: number
	/** The original currency of the price (always GRIN on magick.market) */
	originalCurrency?: string
	/** Optional className for styling */
	className?: string
	/** Whether to show the root currency indicator */
	showRootCurrency?: boolean
}

/**
 * GRIN price display. Listings are priced in decimal GRIN; there is no
 * conversion service and no secondary fiat price.
 */
export function PriceDisplay({ priceValue, originalCurrency = 'GRIN', className = '', showRootCurrency = false }: PriceDisplayProps) {
	const formatted = Number.isFinite(priceValue) ? priceValue.toLocaleString(undefined, { maximumFractionDigits: 9 }) : '0'

	return (
		<div className={`flex flex-col gap-1 ${className}`}>
			{showRootCurrency && (
				<div className="flex items-center gap-2 mb-1">
					<span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Listed in {originalCurrency}</span>
				</div>
			)}
			<p className="text-md font-bold">{formatted} GRIN</p>
		</div>
	)
}
