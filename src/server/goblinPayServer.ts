/**
 * Server-side GoblinPay REST client for magick.market name purchases.
 *
 * GoblinPay is a receive-only Grin payment server: a buyer pays an invoice with
 * their Goblin wallet and the funds land in the marketplace till wallet. This
 * module is the ONLY place the GoblinPay API token is used — it lives on the
 * Bun server and is NEVER exposed to the browser. The client talks to GoblinPay
 * exclusively through the server's own `/api/{nip05,vanity}/invoice` routes,
 * which proxy these functions.
 *
 * Env:
 *   GOBLINPAY_URL        base URL of the GoblinPay instance (default 127.0.0.1:8192)
 *   GOBLINPAY_API_TOKEN  bearer token for the create/read invoice surface
 */

import { NANOGRIN_PER_GRIN } from '@/lib/grin'
import type { GoblinPayInvoiceView } from './nameGrant'

export const DEFAULT_GOBLINPAY_URL = 'http://127.0.0.1:8192'

export interface GoblinPayServerConfig {
	url: string
	token: string
}

/** Read the (server-only) GoblinPay config from the environment. */
export function getGoblinPayConfig(): GoblinPayServerConfig {
	return {
		url: (process.env.GOBLINPAY_URL || DEFAULT_GOBLINPAY_URL).replace(/\/+$/, ''),
		token: process.env.GOBLINPAY_API_TOKEN || '',
	}
}

export interface CreateNameInvoiceParams {
	/** Exact amount in integer nanogrin (the tier price). */
	amountNanogrin: number
	/** `<prefix>:<name>:<buyerPubkey>` — binds the invoice to name + buyer. */
	orderRef: string
	/** Human memo shown on the checkout page (mentions the name). */
	memo: string
}

export interface CreatedNameInvoice {
	invoiceId: string
	payUrl: string
}

/**
 * Parse a GoblinPay invoice amount into integer nanogrin.
 *
 * GoblinPay may report the amount as a numeric nanogrin field or as a human
 * string like `"500 GRIN"` / `"500.5"`. We accept whichever is present,
 * preferring an explicit numeric nanogrin field, then falling back to parsing
 * the human decimal-GRIN string. Returns 0 when nothing parses.
 */
export function parseInvoiceAmountNanogrin(json: Record<string, unknown>): number {
	// Explicit nanogrin fields (integer base units).
	for (const key of ['amount_nanogrin', 'expected_amount', 'amount_grin']) {
		const v = json[key]
		if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0) return v
	}
	// Human decimal-GRIN string, e.g. "500 GRIN" or "0.25".
	const human = json.amount
	if (typeof human === 'string') {
		const match = human.trim().match(/([\d]+)(?:\.(\d{1,9}))?/)
		if (match) {
			const whole = Number(match[1])
			const frac = (match[2] ?? '').padEnd(9, '0')
			const nano = whole * NANOGRIN_PER_GRIN + Number(frac)
			if (Number.isSafeInteger(nano) && nano > 0) return nano
		}
	}
	return 0
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Normalize a GoblinPay `GET /invoice/{id}` JSON body into the grant view. */
export function invoiceViewFromJson(json: Record<string, unknown>): GoblinPayInvoiceView {
	return {
		invoiceId: str(json.invoice_id),
		status: str(json.status),
		confirmations: num(json.confirmations),
		confirmationsRequired: num(json.confirmations_required),
		orderRef: str(json.order_ref),
		amountNanogrin: parseInvoiceAmountNanogrin(json),
	}
}

/**
 * Create a name-purchase invoice (`POST /invoice`, Bearer token). match_mode is
 * `memo` so the payment is correlated by the invoice memo, and order_ref binds
 * the invoice to the exact name + buyer. Throws when GoblinPay is unconfigured
 * or the request fails.
 */
export async function createNameInvoice(
	params: CreateNameInvoiceParams,
	config: GoblinPayServerConfig = getGoblinPayConfig(),
	fetchFn: typeof fetch = fetch,
): Promise<CreatedNameInvoice> {
	if (!config.url || !config.token) {
		throw new Error('GoblinPay is not configured on this instance')
	}
	const res = await fetchFn(`${config.url}/invoice`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${config.token}`,
		},
		body: JSON.stringify({
			amount_grin: params.amountNanogrin,
			match_mode: 'memo',
			order_ref: params.orderRef,
			memo: params.memo,
		}),
	})
	if (!res.ok) {
		throw new Error(`GoblinPay invoice creation failed (${res.status})`)
	}
	const json = (await res.json()) as Record<string, unknown>
	const invoiceId = str(json.invoice_id)
	const payUrl = str(json.pay_url)
	if (!invoiceId || !payUrl) {
		throw new Error('GoblinPay returned an incomplete invoice')
	}
	return { invoiceId, payUrl }
}

/**
 * Fetch and normalize a GoblinPay invoice by id (`GET /invoice/{id}`, Bearer
 * token). Returns `null` when GoblinPay is unreachable, unconfigured, or the
 * invoice is missing — so the grant decision fails closed.
 */
export async function fetchNameInvoice(
	invoiceId: string,
	config: GoblinPayServerConfig = getGoblinPayConfig(),
	fetchFn: typeof fetch = fetch,
): Promise<GoblinPayInvoiceView | null> {
	if (!config.url || !config.token || !invoiceId) return null
	try {
		const res = await fetchFn(`${config.url}/invoice/${encodeURIComponent(invoiceId)}`, {
			headers: { Authorization: `Bearer ${config.token}` },
		})
		if (!res.ok) return null
		const json = (await res.json()) as Record<string, unknown>
		return invoiceViewFromJson(json)
	} catch {
		return null
	}
}
