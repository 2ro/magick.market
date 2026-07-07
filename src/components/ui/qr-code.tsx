import { QRCodeSVG } from 'qrcode.react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

// Self-contained white-rounded Goblin badge (white backing + black mark + white eyes/mouth)
const GOBLIN_MARK_DATA_URI =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23fff'/%3E%3Cpath fill='%23201d09' d='M20 22c0-3 3-5 6-4l6 3 6-3c3-1 6 1 6 4v10c0 8-6 14-12 14S20 40 20 32z'/%3E%3Ccircle cx='26' cy='30' r='3' fill='%23fff'/%3E%3Ccircle cx='38' cy='30' r='3' fill='%23fff'/%3E%3Cpath fill='%23fff' d='M28 40h8l-4 5z'/%3E%3C/svg%3E"

// Full Goblin emblem for the login/trust QR: the detailed mark on a TRANSPARENT
// 12.5%-per-side margin (no backing tile - the old white-rounded tile is what the
// owner rejected). Excavation clears the image rect to the QR background, so the
// margin becomes clean white padding around the crisp black silhouette.
export const GOBLIN_EMBLEM_DATA_URI =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 800'%3E%3Cg transform='translate(100,99.5)'%3E%3Cg transform='translate(0.000000,601.000000) scale(0.050000,-0.050000)' fill='%23000000' stroke='none'%3E %3Cpath d='M195 11784 c-515 -1551 98 -2966 1520 -3514 171 -66 171 -72 2 -72 -415 0 -893 215 -1273 572 -178 167 -181 163 -77 -83 478 -1130 1770 -1734 2963 -1384 283 83 309 101 420 292 376 648 1038 1116 1763 1245 l143 26 100 202 c887 1780 -911 3344 -3076 2675 l-170 -52 220 -14 c480 -32 818 -114 1118 -273 258 -137 548 -414 624 -597 l32 -76 -87 76 c-435 375 -938 524 -1557 461 -273 -28 -340 -39 -740 -120 -893 -182 -1449 24 -1756 650 l-98 200 -71 -214z'/%3E %3Cpath d='M9720 10053 c0 -146 -256 -556 -441 -705 -381 -308 -766 -380 -1559 -290 -1178 133 -2048 -270 -2488 -1152 -57 -115 -92 -149 -92 -89 0 78 123 415 199 548 43 74 73 135 67 135 -25 0 -397 -184 -512 -253 -962 -578 -1594 -1675 -1594 -2767 0 -209 -2 -210 -154 -95 -393 297 -523 388 -751 525 -321 192 -571 311 -843 400 -290 95 -302 94 -242 -15 52 -95 166 -372 191 -465 9 -33 34 -121 56 -195 48 -161 120 -508 194 -935 118 -684 437 -1371 795 -1715 185 -178 324 -239 594 -262 144 -13 150 -15 147 -63 -1 -27 -14 -174 -28 -326 -83 -902 258 -1568 1037 -2024 139 -81 161 -80 127 4 -37 96 -85 369 -96 546 l-10 170 46 -60 c328 -431 869 -753 1497 -891 351 -77 1285 -67 1426 15 9 5 -104 50 -250 98 -653 218 -1499 778 -1704 1129 -43 73 -54 78 188 -79 230 -149 543 -303 750 -369 783 -249 1542 -242 2332 20 l274 91 106 -83 c298 -236 798 -328 1259 -231 197 42 196 38 32 169 -156 124 -344 356 -443 546 l-60 116 70 52 c544 408 783 906 627 1300 l-41 102 170 138 c442 355 584 624 813 1537 186 742 257 952 452 1328 l118 227 -145 -14 c-693 -68 -1425 -411 -1729 -810 -99 -130 -112 -127 -165 44 -54 175 -217 511 -308 636 -64 88 -70 91 -224 117 -419 70 -947 328 -1223 597 -98 96 -153 192 -70 122 41 -35 332 -177 487 -238 97 -38 146 -55 348 -118 335 -105 983 -129 1280 -47 1070 294 1688 1238 1761 2691 16 304 7 325 -82 190 -88 -134 -504 -535 -669 -645 -618 -412 -1228 -507 -1895 -296 -192 60 -199 77 -67 163 428 277 628 871 480 1428 -20 75 -38 98 -38 48z m-682 -4962 c306 -158 601 -1396 416 -1747 -118 -224 -283 -345 -526 -387 -455 -78 -577 227 -456 1143 96 725 320 1118 566 991z m-3115 -156 c371 -172 699 -815 799 -1565 34 -251 19 -307 -108 -422 -575 -519 -1624 -162 -1931 657 -265 709 593 1630 1240 1330z m5261 -120 c20 -377 -135 -912 -290 -995 -70 -38 -72 -35 -157 230 l-64 200 -24 -90 c-50 -192 -144 -340 -215 -340 -111 0 -316 804 -228 893 53 53 200 -130 226 -283 l14 -80 36 105 c100 293 222 333 332 109 l54 -110 35 105 c89 260 271 427 281 256z m-8491 -284 l75 -230 52 160 c89 272 210 336 295 154 126 -268 210 -757 142 -825 -44 -44 -163 120 -247 340 -12 33 -19 24 -39 -50 -89 -330 -286 -346 -374 -30 l-22 80 -35 -125 c-54 -196 -223 -428 -275 -377 -37 37 -29 448 11 608 70 276 219 524 314 524 17 0 56 -87 103 -229z m4164 -2698 c137 -310 856 -372 1401 -121 175 81 194 76 89 -23 -356 -336 -878 -447 -1310 -278 -224 88 -517 339 -517 443 0 53 140 267 212 324 l58 46 14 -152 c8 -84 31 -191 53 -239z'/%3E %3C/g%3E%3C/g%3E%3C/svg%3E"

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
	/** true = classic white-tile mark; a string = custom center-image data URI (e.g. GOBLIN_EMBLEM_DATA_URI). */
	logo?: boolean | string
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
							src: typeof logo === 'string' ? logo : GOBLIN_MARK_DATA_URI,
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
