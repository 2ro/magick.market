import { QRCodeSVG } from 'qrcode.react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

// Self-contained white-rounded Goblin badge (white backing + black mark + white eyes/mouth)
const GOBLIN_MARK_DATA_URI =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23fff'/%3E%3Cpath fill='%23201d09' d='M20 22c0-3 3-5 6-4l6 3 6-3c3-1 6 1 6 4v10c0 8-6 14-12 14S20 40 20 32z'/%3E%3Ccircle cx='26' cy='30' r='3' fill='%23fff'/%3E%3Ccircle cx='38' cy='30' r='3' fill='%23fff'/%3E%3Cpath fill='%23fff' d='M28 40h8l-4 5z'/%3E%3C/svg%3E"

interface QRCodeProps {
	value: string
	size?: number
	className?: string
	includeMargin?: boolean
	level?: 'L' | 'M' | 'Q' | 'H'
	bgColor?: string
	fgColor?: string
	title?: string
	description?: string
	showBorder?: boolean
	logo?: boolean
}

export function QRCode({
	value,
	size = 200,
	className,
	includeMargin = true,
	level = 'M',
	bgColor = '#ffffff',
	fgColor = '#000000',
	title,
	description,
	showBorder = true,
	logo = false,
}: QRCodeProps) {
	if (!value) {
		return (
			<div className={cn('flex items-center justify-center bg-gray-100 rounded-lg', className)} style={{ width: size, height: size }}>
				<div className="text-center text-gray-500 text-sm">
					<div className="text-xs">No QR data</div>
				</div>
			</div>
		)
	}

	const qrCodeComponent = (
		<QRCodeSVG
			value={value}
			size={size}
			level={logo ? 'H' : level}
			includeMargin={includeMargin}
			bgColor={bgColor}
			fgColor={fgColor}
			className="rounded-lg"
			imageSettings={
				logo
					? {
							src: GOBLIN_MARK_DATA_URI,
							height: Math.round(size * 0.2),
							width: Math.round(size * 0.2),
							excavate: true,
						}
					: undefined
			}
		/>
	)

	if (showBorder) {
		return (
			<Card className={cn('p-4 inline-block', className)}>
				<div className="text-center space-y-2">
					{title && <h3 className="font-medium text-sm">{title}</h3>}
					{qrCodeComponent}
					{description && <p className="text-xs text-gray-500 max-w-xs">{description}</p>}
				</div>
			</Card>
		)
	}

	return (
		<div className={cn('text-center space-y-2', className)}>
			{title && <h3 className="font-medium text-sm">{title}</h3>}
			{qrCodeComponent}
			{description && <p className="text-xs text-gray-500 max-w-xs">{description}</p>}
		</div>
	)
}
