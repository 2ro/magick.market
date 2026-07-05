/**
 * Proof-on-request watcher logic (spec section 4.4/4.5 + section 7).
 *
 * Two audiences, one file:
 *
 * 1. THE MARKETPLACE (contract 4.5): `classifyOrderReceipts` is the pure core of
 *    magick's order-status matcher. It matches kind-17 events by the
 *    `payment-request` (invoice number) tag ALONE, classifies them by their
 *    `status` tag and signer, and enforces the trust rule that ONLY a
 *    watcher-signed `status=confirmed` event flips an order to "paid". Buyer /
 *    merchant events can only reach "detected"/"confirming". No proof crypto
 *    runs here.
 *
 * 2. THE WATCHER (section 7, a separate daemon holding its own nsec): the
 *    reference verification pipeline `verifyProofDelivery` (steps 2-5 + depth)
 *    and `queryKernelConfirmations` (the node client), plus `hasExistingConfirmed`
 *    for idempotence (step 8). magick does not run these; they are the reusable,
 *    tested reference for whoever builds the watcher.
 */
import { parsePaymentProof, verifyProofBindings } from './grinProofs'

/** House standard depth for "paid" (matches GoblinPay GP_CONFIRMATIONS=10). */
export const CONFIRMATIONS_REQUIRED = 10

// ---------------------------------------------------------------------------
// Shared event shape (a minimal kind-17 view; NDKEvent is structurally compatible)
// ---------------------------------------------------------------------------

export interface ReceiptEventLike {
	pubkey?: string
	created_at?: number
	tags: string[][]
	content?: string
}

function firstTag(ev: ReceiptEventLike, name: string): string[] | undefined {
	return ev.tags.find((t) => t[0] === name)
}

function tagValue(ev: ReceiptEventLike, name: string): string | undefined {
	return firstTag(ev, name)?.[1]
}

function intTag(ev: ReceiptEventLike, name: string, fallback: number): number {
	const raw = tagValue(ev, name)
	if (raw == null) return fallback
	const n = parseInt(raw, 10)
	return Number.isFinite(n) ? n : fallback
}

/**
 * Contract 4.5 matching: an event belongs to an invoice iff its `payment-request`
 * tag equals the invoice number. We also accept an `order` tag carrying the
 * invoice number, because the wallet echoes the URI `order` param (= invoice
 * number) and may stamp it under either name; magick's own self-receipts and the
 * watcher's confirmed events use `payment-request`. Either way the match value is
 * the 96-bit opaque invoice number, never magick's internal orderId.
 */
export function receiptMatchesInvoice(ev: ReceiptEventLike, invoiceNumber: string): boolean {
	if (!invoiceNumber) return false
	return ev.tags.some((t) => (t[0] === 'payment-request' || t[0] === 'order') && t[1] === invoiceNumber)
}

// ---------------------------------------------------------------------------
// Marketplace matcher core (contract 4.5)
// ---------------------------------------------------------------------------

export type OrderConfirmationState = 'waiting' | 'detected' | 'confirming' | 'paid'

export interface OrderConfirmationResult {
	state: OrderConfirmationState
	/** Best-known confirmation depth (0 until a watcher confirming/confirmed event). */
	confirmations: number
	required: number
	/** Proof payload string if any event carried one (usually empty by privacy default). */
	proof: string | null
}

const STATE_RANK: Record<OrderConfirmationState, number> = { waiting: 0, detected: 1, confirming: 2, paid: 3 }

/**
 * Reduce all kind-17 events already filtered to one invoice into a single honest
 * order state, enforcing contract 4.5. `watcherPubkeyHex` is the instance's
 * configured watcher pubkey (hex); pass null when no watcher is configured
 * (degraded mode M4 — nothing can reach "paid").
 *
 * Dedupe by design: many events collapse to the single highest-trust state, so
 * duplicate `sent` receipts or replayed `confirmed` events are naturally
 * idempotent for the UI.
 */
export function classifyOrderReceipts(events: ReceiptEventLike[], watcherPubkeyHex: string | null): OrderConfirmationResult {
	let state: OrderConfirmationState = 'waiting'
	let confirmations = 0
	let proof: string | null = null

	for (const ev of events) {
		const status = tagValue(ev, 'status')
		const isWatcher = !!watcherPubkeyHex && ev.pubkey === watcherPubkeyHex
		const paymentProof = firstTag(ev, 'payment')?.[3]
		if (paymentProof) proof = paymentProof

		let candidate: OrderConfirmationState | null = null
		let candidateConfs = 0

		if (status === 'confirmed' && isWatcher) {
			// ONLY the watcher key may assert paid (contract 4.5).
			candidate = 'paid'
			candidateConfs = intTag(ev, 'confirmations', CONFIRMATIONS_REQUIRED)
		} else if (status === 'confirming' && isWatcher) {
			candidate = 'confirming'
			candidateConfs = intTag(ev, 'confirmations', 0)
		} else if (status === 'sent') {
			// Buyer-signed plain receipt (4.3.1): honest intermediate only.
			candidate = 'detected'
		} else if (!status && paymentProof) {
			// Legacy / hand-published receipt carrying a proof: treat as detected,
			// never paid (only the watcher signature flips paid).
			candidate = 'detected'
		}

		if (!candidate) continue
		if (STATE_RANK[candidate] > STATE_RANK[state]) {
			state = candidate
			confirmations = candidateConfs
		} else if (candidate === state && candidateConfs > confirmations) {
			confirmations = candidateConfs
		}
	}

	return { state, confirmations, required: CONFIRMATIONS_REQUIRED, proof }
}

// ---------------------------------------------------------------------------
// Watcher reference: node client (section 7 step 5)
// ---------------------------------------------------------------------------

/**
 * The instance's configured Grin node foreign-API endpoint. Operator-configurable;
 * no default is baked in because a wrong hardcoded node would silently fail
 * confirmation. The watcher operator points this at their own or a trusted public
 * node's `/v2/foreign` JSON-RPC endpoint. Curated public candidates are listed for
 * operator convenience only.
 */
export const CURATED_GRIN_NODES = ['https://grinnode.live/v2/foreign', 'https://grincoin.org/v2/foreign'] as const

export interface KernelResult {
	found: boolean
	confirmations: number
	/** Inclusion height if found. */
	height?: number
}

type FetchLike = (
	input: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
	ok: boolean
	status: number
	json: () => Promise<unknown>
}>

/**
 * Query a Grin node for a kernel by excess and compute its confirmation depth.
 * Uses the foreign-API JSON-RPC `get_kernel` + `get_tip`. `fetchImpl` is injected
 * for testing. Returns { found:false } when the kernel is not yet on chain.
 */
export async function queryKernelConfirmations(
	nodeUrl: string,
	excessHex: string,
	fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<KernelResult> {
	const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
		const res = await fetchImpl(nodeUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		})
		if (!res.ok) throw new Error(`grin node ${method} HTTP ${res.status}`)
		const json = (await res.json()) as { result?: { Ok?: unknown; Err?: unknown }; error?: unknown }
		if (json?.error) throw new Error(`grin node ${method} error: ${JSON.stringify(json.error)}`)
		const result = json?.result
		if (result && typeof result === 'object' && 'Err' in result) {
			throw new Error(`grin node ${method} Err: ${JSON.stringify(result.Err)}`)
		}
		if (result && typeof result === 'object' && 'Ok' in result) return result.Ok
		return result
	}

	const kernel = await rpc('get_kernel', [excessHex, null, null])
	if (kernel == null) return { found: false, confirmations: 0 }

	// get_kernel returns [TxKernelPrintable, height, mmr_index].
	const height = Array.isArray(kernel) ? Number(kernel[1]) : Number((kernel as { height?: number }).height)
	const tip = (await rpc('get_tip', [])) as { height?: number } | null
	const tipHeight = Number(tip?.height)

	if (!Number.isFinite(height) || !Number.isFinite(tipHeight)) {
		// Kernel present but heights unreadable: at least one confirmation.
		return { found: true, confirmations: 1, height: Number.isFinite(height) ? height : undefined }
	}
	return { found: true, confirmations: Math.max(1, tipHeight - height + 1), height }
}

// ---------------------------------------------------------------------------
// Watcher reference: the full verification pipeline (section 7 steps 2-5)
// ---------------------------------------------------------------------------

/** What the watcher learns from the kind-16 payment request event (contract 4.2). */
export interface InvoiceContext {
	invoiceNumber: string
	amountNanogrin: number
	/** The merchant grin1 proof-address (the `proof-address` tag). */
	proofAddress: string
}

export interface ProofDeliveryInput {
	/** The rumor content: the Grin payment proof JSON (contract 4.3.2). */
	proofJson: string
	/** The `kernel` convenience tag on the delivery (must equal the proof excess). */
	kernelTag?: string
	/** The `payment-request` tag on the delivery (the invoice number). */
	invoiceTag?: string
	/** The `amount` tag on the delivery. */
	amountTag?: string
}

export interface ProofVerificationResult {
	ok: boolean
	/** Kernel excess to look up on chain, present when the crypto checks pass. */
	excessHex?: string
	reason?: string
}

/**
 * Watcher steps 2-4 (section 7): parse the proof, require the kernel tag to equal
 * the proof excess, bind amount + recipient address to the invoice, and verify
 * the receiver + sender signatures. Any mismatch: not ok, with a reason to log
 * (never published). Step 5 (chain depth) is `queryKernelConfirmations`.
 */
export function verifyProofDelivery(delivery: ProofDeliveryInput, invoice: InvoiceContext): ProofVerificationResult {
	const proof = parsePaymentProof(delivery.proofJson)
	if (!proof) return { ok: false, reason: 'proof JSON did not parse' }

	// Step 2: kernel tag must equal the proof's excess (convenience-copy agreement).
	if (delivery.kernelTag != null && delivery.kernelTag.toLowerCase() !== proof.excessHex) {
		return { ok: false, reason: 'kernel tag does not match proof excess' }
	}

	// Step 3: match the invoice by payment-request tag (when provided).
	if (delivery.invoiceTag != null && delivery.invoiceTag !== invoice.invoiceNumber) {
		return { ok: false, reason: 'delivery payment-request does not match invoice' }
	}

	// Steps 3-4: bind amount + recipient address, verify signatures.
	const bindings = verifyProofBindings({ proof, merchantAddress: invoice.proofAddress, amountNanogrin: invoice.amountNanogrin })
	if (!bindings.valid) return { ok: false, reason: bindings.reason }

	return { ok: true, excessHex: bindings.excessHex }
}

/**
 * Watcher step 8 (idempotence): has this invoice already got a confirmed event
 * signed by the watcher's own key? If so, publish nothing further.
 */
export function hasExistingConfirmed(events: ReceiptEventLike[], invoiceNumber: string, watcherPubkeyHex: string): boolean {
	return events.some(
		(ev) => ev.pubkey === watcherPubkeyHex && tagValue(ev, 'status') === 'confirmed' && receiptMatchesInvoice(ev, invoiceNumber),
	)
}

/**
 * Build the tags for the watcher's confirmed receipt (contract 4.4). Privacy
 * default: the `payment` proof field is EMPTY. The watcher signs and publishes
 * this; it is the only event that flips an order to paid.
 */
export function buildConfirmedReceiptTags(invoiceNumber: string, amountNanogrin: number, confirmations: number): string[][] {
	return [
		['payment-request', invoiceNumber],
		['payment', 'grin', invoiceNumber, ''],
		['amount', String(amountNanogrin)],
		['status', confirmations >= CONFIRMATIONS_REQUIRED ? 'confirmed' : 'confirming'],
		['confirmations', String(confirmations)],
	]
}
