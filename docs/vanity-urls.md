# Vanity URL Feature

This feature allows users to register custom vanity URLs for their profile/shop pages.

## Overview

Vanity URLs provide users with memorable, shareable links like `/alice-store` that display their profile page directly. A vanity URL is a time-limited platform name fee, bought with a real GoblinPay (Grin) invoice. The buyer pays the invoice with their Goblin wallet, the funds land in the marketplace till, and the name is granted only after the payment confirms on-chain (GoblinPay's 10-confirmation house standard). Vanity URLs are the same class of paid name as NIP-05 usernames and share the grant logic.

## Architecture

### Backend (`src/server/`)

- **VanityManager.ts** - Manages the vanity URL registry
  - Handles kind `30000` events with `d=vanity-urls` tag
  - Mints GoblinPay invoices for purchases (`createPurchaseInvoice`)
  - Verifies buyer-signed claims (kind `17`) against a confirmed invoice and registers the name (`handleGrinPurchase`)
  - Validates reserved names and name format
  - Matches the paid amount to a pricing tier to calculate the validity period
- **goblinPayServer.ts** - Server-only GoblinPay REST client (`createNameInvoice`, `fetchNameInvoice`). The GoblinPay API token lives on the Bun server and is never exposed to the browser.
- **nameGrant.ts** - Pure, shared grant decision (`decideNameGrant`, `buildNameOrderRef`) used by both VanityManager and Nip05Manager.

### Frontend

- **Store** (`src/lib/stores/vanity.ts`) - Client-side state management
- **Queries** (`src/queries/vanity.tsx`) - NDK fetch with live subscription
- **Sync Hook** (`src/hooks/useVanitySync.ts`) - Syncs store with relay data
- **Route** (`src/routes/$vanityName.tsx`) - Mirror route that renders profile directly
- **Dashboard** (`src/routes/_dashboard-layout/dashboard/account/vanity-url.tsx`) - Management UI and purchase flow

## Data Format

### Vanity Registry Event (Kind 30000)

The registry is a single replaceable event. Each registered name is one `vanity` tag: `[name, pubkey, validUntil, invoiceId?]`. The trailing invoice id is the GoblinPay invoice that was consumed to grant the entry (reuse guard).

```json
{
	"kind": 30000,
	"tags": [
		["d", "vanity-urls"],
		["vanity", "alice-store", "<pubkey>", "<validUntil>", "<invoiceId>"]
	],
	"content": ""
}
```

Source: `VanityManagerImpl.buildRegistryTags` / `extractEntriesFromEvent` (`src/server/VanityManager.ts:133-155`).

## Name Rules

A vanity name must match `^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$`: lowercase alphanumerics, hyphens, and underscores, 3 to 30 characters, starting and ending with an alphanumeric. Names are stored and compared lowercased. The same regex is enforced on the server (`VanityManagerImpl.isValidVanityName`, `src/server/VanityManager.ts:338-342`) and in the client store (`isValidVanityName`, `src/lib/stores/vanity.ts:151-154`).

## Reserved Names

A fixed set of names cannot be registered. The server list (`RESERVED_NAMES`, `src/server/VanityManager.ts:11-49`) covers:

- Route conflicts: `admin`, `api`, `dashboard`, `products`, `profile`, `checkout`, `setup`, `community`, `posts`, `search`, `collection`, `collections`, `settings`, etc.
- System names: `app`, `static`, `assets`, `images`, `public`, `favicon`, `robots`, `sitemap`
- Auth and account: `login`, `logout`, `register`, `signup`, `signin`, `account`, `user`, `users`
- Content: `nostr`, `post`, `product`, `support`, `help`, `about`, `terms`, `privacy`

The client store keeps a parallel list (`RESERVED_NAMES`, `src/lib/stores/vanity.ts:31`) so the dashboard can reject a reserved name before hitting the server. See both files for the authoritative sets.

## Pricing

| Tier       | Amount   | Validity   |
| ---------- | -------- | ---------- |
| Dev (test) | 1 GRIN   | 90 seconds |
| 6 Months   | 500 GRIN | 180 days   |
| 1 Year     | 800 GRIN | 365 days   |

Source: `VANITY_PRICING` (`src/server/VanityManager.ts:62-70`). The dev tier is only present when `NODE_ENV=development`. Amounts are stored in integer nanogrin. These are the same amounts as the NIP-05 name fee. `matchVanityPricingTier` (`src/server/VanityManager.ts:76-84`) maps a paid amount to the highest tier it clears, returning that tier's validity in seconds (or `null` if the amount clears no tier).

## Purchase Flow

The dashboard drives a four-step flow (`src/routes/_dashboard-layout/dashboard/account/vanity-url.tsx`):

1. **Mint invoice.** The user picks an available name and a pricing tier. The dashboard POSTs `{name, tier, pubkey}` to `/api/vanity/invoice` (`vanity-url.tsx:235`). The server calls `VanityManagerImpl.createPurchaseInvoice`, which re-checks availability, then asks GoblinPay for a real invoice via `createNameInvoice`. The invoice is created with `match_mode: "memo"` and an `order_ref` of `vanity:<name>:<buyerPubkey>` that binds it to the exact name and buyer (`VanityManager.ts:229-256`, `goblinPayServer.ts:102-133`, `nameGrant.ts:46-48`). The response returns `{invoice_id, pay_url}`.

2. **Pay.** The user opens `pay_url` and pays the invoice with their Goblin wallet. The funds go to the marketplace till.

3. **Poll for confirmation.** The dashboard polls `GET /api/vanity/invoice/:id/status` every 5 seconds (`vanity-url.tsx:303-342`). That route proxies `fetchNameInvoice` and returns `{status, confirmations, confirmations_required}` (`src/index.tsx:296-309`). The UI shows `open -> waiting`, `paid -> confirming (n of 10)`, `confirmed -> claim`. `confirmations_required` is GoblinPay's 10-confirmation standard.

4. **Claim and grant.** Once status is `confirmed`, the dashboard signs a kind-17 receipt carrying `["vanity", name]` and `["invoice", invoiceId]` tags, addressed to the recipient pubkey with `["p", VANITY_GRIN_RECIPIENT_PUBKEY]`, publishes it to the relay, and POSTs `{event}` to `/api/vanity/claim` (`vanity-url.tsx:255-299`). The server calls `VanityManagerImpl.handleGrinPurchase`.

### Grant gate (`handleGrinPurchase`)

`handleGrinPurchase` (`src/server/VanityManager.ts:267-336`) and the shared `decideNameGrant` (`src/server/nameGrant.ts:80-113`) require ALL of:

- the event is kind `17` and has not already been processed (in-memory `processedGrinClaims` dedup, `VanityManager.ts:271-276`);
- the event signature verifies (`verifyEvent`, `VanityManager.ts:277-279`);
- the `["p", ...]` recipient equals `VANITY_GRIN_RECIPIENT_PUBKEY` (the same platform identity as NIP-05 names, `VanityManager.ts:281-284`, `88-89`);
- the receipt carries a `vanity` tag and an `invoice` tag (`VanityManager.ts:286-294`);
- the name passes `validateRegistration` (valid format, not reserved, not currently taken by a different pubkey, `VanityManager.ts:119-131`);
- the invoice id has not already been consumed by a prior grant (`consumedInvoiceIds`, persisted from the registry across restarts, `nameGrant.ts:87-90`, `VanityManager.ts:168-175`);
- the invoice is reachable (an unreachable or missing GoblinPay fails closed, `nameGrant.ts:92-95`);
- the invoice `status === "confirmed"` (the only grant gate, GoblinPay's 10 confirmations, `nameGrant.ts:97-100`);
- the invoice `order_ref` exactly equals `vanity:<name>:<buyerPubkey>` (`nameGrant.ts:102-105`);
- the paid amount clears a pricing tier via `matchVanityPricingTier` (`nameGrant.ts:107-110`).

On success the server computes `validUntil = now + tier validity`; if the buyer already holds the same name with time left, the new validity is added to the existing expiry (renewal, `VanityManager.ts:322-327`). It records the consumed invoice id on the entry, updates the registry, and publishes the new kind-30000 event (`VanityManager.ts:329-333`). The claim route returns `{vanityName, validUntil}` (`src/index.tsx:312-332`).

### Failure and expiry handling

- **Payment not yet confirmed** - the claim returns HTTP 402 (`nameGrant.ts:97-100`). In practice the dashboard only claims after polling reports `confirmed`, so this guards direct or racing claims.
- **GoblinPay unreachable** - `fetchNameInvoice` returns `null` and the grant fails closed with HTTP 503; the status endpoint likewise returns 503 (`goblinPayServer.ts:140-156`, `nameGrant.ts:92-95`, `src/index.tsx:300-302`).
- **Reused invoice** - a consumed invoice can never grant again; the claim returns HTTP 409 (`nameGrant.ts:87-90`).
- **Wrong name/buyer** - an `order_ref` mismatch returns HTTP 400 (`nameGrant.ts:102-105`).
- **Amount too low** - an amount below every tier returns HTTP 400 (`nameGrant.ts:107-110`).
- **Expiry** - entries carry a `validUntil` timestamp. A name is available again once expired: `isVanityAvailable` treats an entry as free when `validUntil` is in the past, and `resolveVanity` returning an expired entry lets the mirror route fall through to 404 (`VanityManager.ts:191-200`).

## Resolution Flow

1. User navigates to `/{vanityName}`
2. `$vanityName.tsx` resolves via `vanityActions.resolveVanity()` (`src/routes/$vanityName.tsx:19`)
3. If found and valid, it renders the profile page directly (mirror route)
4. If not found or expired, it shows a 404-like page with an option to return home

## API Endpoints

### POST `/api/vanity/invoice`

Mints a real GoblinPay invoice for a vanity URL purchase. The GoblinPay API token stays server-side.

**Request:**

```json
{
	"name": "alice-store",
	"tier": "6mo",
	"pubkey": "<buyer pubkey hex>"
}
```

**Response:**

```json
{
	"invoice_id": "<goblinpay invoice id>",
	"pay_url": "<goblinpay checkout url>"
}
```

Source: `src/index.tsx:274-294`.

### GET `/api/vanity/invoice/:id/status`

Proxies GoblinPay's invoice status for the buyer to poll. Returns HTTP 503 if GoblinPay is unreachable.

**Response:**

```json
{
	"status": "open | paid | confirmed",
	"confirmations": 3,
	"confirmations_required": 10
}
```

Source: `src/index.tsx:296-309`.

### POST `/api/vanity/claim`

Verifies a buyer-signed kind-17 claim against a confirmed GoblinPay invoice and registers the vanity URL. Errors surface as the grant-gate HTTP statuses above (402, 400, 409, 503).

**Request:**

```json
{
	"event": "<signed kind 17 receipt with vanity + invoice tags>"
}
```

**Response:**

```json
{
	"vanityName": "alice-store",
	"validUntil": 1737000000
}
```

Source: `src/index.tsx:312-333`.
