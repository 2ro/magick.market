# magick.market

A GRIN-only, Nostr-native marketplace. Listings live on Nostr (NIP-99 / Gamma spec, kind 30402),
the money is [Grin](https://grin.mw), and a buyer needs no account: an anonymous shopper pays a
seller in Grin by opening a `nostr:` pay link or QR in their [Goblin](https://goblin.st) wallet.
The seller, the only party who logs in, sees the order and fulfills it.

Forked from [PlebeianApp market](https://github.com/PlebeianTech/plebeian-market) and stripped to a
single rail:

- **GRIN only** - Lightning, Cashu and on-chain Bitcoin are removed. Listings are priced in decimal
  GRIN; all internal integer amounts are nanogrin (1 GRIN = 10^9 nanogrin).
- **Anonymous guest buyer** - checkout mints a fresh one-time key that signs the order events
  (kind 16, NIP-17 flavored) and is never registered as an account. The buyer gets a copyable order
  code (saved locally under "Your orders on this device") and can track the order at `/track`.
- **Goblin payment handoff** - the payment step shows a QR / "Open in Goblin" deeplink in the Goblin
  wallet's canonical pay-URI format,
  `nostr:<nprofile or slatepack address>?amount=<decimal GRIN>&memo=<invoice number>` (the exact
  shape the wallet's scanner parses; amount is decimal GRIN, converted from the app's internal
  nanogrin). The opaque invoice number bridges the Grin payment to the order: it rides in the pay-URI
  memo, on the kind 16 order (`invoice` tag), and in kind 17 receipts (`payment-request` tag). When
  the operator has configured a proof watcher, the pay-URI can additionally carry `proof`/`order`/`notify`
  params (proofs-on-request) so the buyer's wallet can include a native Grin payment proof; these are
  off by default and the flagship instance emits a plain, proof-free URI.
- **True wallet-to-wallet payment** - the payment is a private Grin transfer straight from the buyer's
  Goblin wallet to the seller's Goblin wallet. The marketplace never touches the money; it only carries
  the messages that let a page know a payment happened.
- **Message-driven confirmation, the seller's wallet is the truth** - by default an order is confirmed
  by a message, not by the marketplace watching a chain. When the buyer pays, their Goblin wallet
  announces it by publishing a signed kind 17 "payment sent" receipt carrying the invoice number; the
  order page is subscribed to that receipt and flips live to a calm "payment sent" state the moment it
  arrives. To the seller this is shown as a claim - "Buyer reports payment sent" - never as settled:
  the seller checks their own Goblin wallet, confirms the funds actually arrived, and marks the order
  paid by hand. The seller's wallet is the source of truth for the money. (The payment-sent receipt is
  a plain public note matched only by invoice number; the buyer's private order details, such as a
  shipping address, travel separately as an encrypted NIP-17 gift-wrapped message.)
- **Optional chain-verified attestation (a shelf component)** - an operator MAY run a separate watcher
  daemon (the `grin-proof-watcher` component) that verifies a Grin payment proof and its on-chain
  kernel and republishes a watcher-signed `confirmed` receipt; only that watcher-signed receipt can
  flip an order to a hard `paid` state automatically. The watcher is optional and is **not** running on
  the flagship instance, where confirmation is the manual, message-driven model above. A future opt-in,
  per-seller GoblinPay till is planned but not shipped.
- **Buyer and seller surfaces** - buying your own product is refused up front, before any order is
  created. Legacy `/product/:id` links permanently redirect to `/products/:id`. The seller (the only
  party who logs in) signs in with a Nostr browser extension (recommended) or a private key; Nostr Connect
  has been removed in favour of extension-first login. Relays are operator infrastructure - magick.market
  federates with its own relay - and are not something buyers or sellers manage.
- **Privacy-first contact and delivery** - a digital-goods buyer chooses how the seller reaches them from a
  set of privacy-respecting channels: email, Signal, Matrix, Session, or SimpleX. The chosen channel rides
  the same encrypted NIP-17 gift-wrapped order message as the rest of the private order details, so the
  marketplace never sees it; the seller reads it off the private order card.
- **Paid names** - NIP-05 usernames and vanity URLs are bought with real GoblinPay invoices, not an
  honor-system payment proof. The buyer pays an invoice whose funds land in the marketplace till
  wallet (wallet-to-wallet, sweepable by the operator), and the name is granted only after the
  payment confirms on chain (GoblinPay's 10-confirmation house standard).

### Why the seller confirms payment by hand

Product sales use a rudimentary, non-custodial P2P model: the buyer pays the seller's Goblin wallet
directly, wallet to wallet, and the seller confirms the payment by hand once they watch the Grin arrive
in their own wallet. This manual step is intentional, not a missing feature or a broken flow. The
marketplace never holds the money and, by design, cannot see inside an encrypted, private Grin payment,
so it has no honest way to auto-confirm a product sale on its own; only the seller, looking at their own
wallet, knows the funds actually landed. Paid names are different because they are paid to the
marketplace's own till with a GoblinPay invoice, which the marketplace can watch and confirm
automatically once it reaches GoblinPay's 10-confirmation house standard. The planned per-seller GoblinPay
till is the future path that brings that same automatic confirmation to products too: a seller could opt
in to an invoice-backed till and have product sales auto-confirm, while the funds stay non-custodial and
land straight in their wallet.

To install dependencies:

```bash
bun install
```

To start a development server:

```bash
bun dev
```

To run for production:

```bash
bun start
```

This project was created using `bun init` in bun v1.2.4. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Getting Started

### Initial Setup

1. Install dependencies with `bun install`
2. Copy `.env.example` to `.env` and configure your environment variables:
   - `APP_RELAY_URL`: Your relay URL
   - `APP_PRIVATE_KEY`: Your private key for initialization
3. Set up a development relay (required for local development)
   - We recommend using [nak](https://github.com/fiatjaf/nak) for development:

     ```bash
     # Install nak
     go install github.com/fiatjaf/nak@latest

     # Start a local relay
     nak serve
     ```

   - The relay will be available at `ws://localhost:10547`
   - Update your `.env` file with this relay URL

4. Initialize the application with default settings:
   ```bash
   bun run startup
   ```
   This will create:
   - Default app settings
   - User roles configuration
   - Ban list
   - Relay list

### First Run

When you first start the application:

1. If no settings are found in the configured relay, you'll be automatically redirected to `/setup`
2. The first user to complete the setup process becomes the administrator
   - Skip this step if you've run the startup script, as it creates default admin users
3. Complete the setup form to configure your marketplace settings
   - Skip this if you've run the startup script and want to use the default configuration

### Development Workflow

1. Start the development server:

   ```bash
   bun dev:seed
   ```

   _start without seeding for a fresh start with no setup data_

   ```bash
   bun dev
   ```

2. In a separate terminal, run the route watcher:

   ```bash
   bun run watch-routes
   ```

3. Optional: Seed the relay with test data:
   ```bash
   bun seed
   ```

## React Query

This project uses TanStack React Query (v5) for data fetching, caching, and state management. React Query helps with:

- Fetching, caching, and updating server state in your React applications
- Automatic refetching when data becomes stale
- Loading and error states handling
- Pagination and infinite scrolling

In our implementation, query functions and options are defined in the `src/queries` directory, using a pattern that separates query key factories and query functions.

Example:

```tsx
// Query key factory pattern for organized cache management
export const postKeys = {
	all: ['posts'] as const,
	details: (id: string) => [...postKeys.all, id] as const,
}

// Query options for use in routes and components
export const postsQueryOptions = queryOptions({
	queryKey: postKeys.all,
	queryFn: fetchPosts,
})
```

## Routing and Prefetching

This project uses TanStack Router for file-based routing with built-in prefetching capabilities:

- File-based routing: Routes are defined in the `src/routes` directory
- Dynamic routes: Parameters in file names (e.g., `posts.$postId.tsx`)
- Automatic route tree generation

Data prefetching is implemented via loader functions in route files:

```tsx
export const Route = createFileRoute('/posts/')({
	loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(postsQueryOptions),
	component: PostsRoute,
})
```

The router is configured to prefetch data on "intent" (hovering over links) with zero stale time to ensure fresh data:

```tsx
const router = createRouter({
	routeTree,
	context: {
		queryClient,
		nostr: nostrService,
	},
	defaultPreload: 'intent',
	defaultPreloadStaleTime: 0,
})
```

## Development Workflow

### .env variables

Set the .env variables by copying and renaming the `.env.example` file, then set your own values for the variables.

### Development relay

During development, you should spin up a relay to seed data and use it during the development cycle, you can use `nak serve` as a quick solution, or run another relay locally, then set it in your `.env` variables, and run `bun seed` to seed it.

### watch-routes Command

During development, you should run the `watch-routes` command in a separate terminal:

```bash
bun run watch-routes
```

This command uses the TanStack Router CLI (`tsr watch`) to monitor your route files and automatically generate the route tree file (`src/routeTree.gen.ts`). This file connects all your route components into a coherent navigation structure.

Without running this command, changes to route files or creating new routes won't be detected until you manually generate the route tree or restart the server.

## Releasing

Staging deploys automatically after the `E2E Tests` workflow succeeds on `master`.
Production deploys require the `production` environment approval and can be triggered
either by pushing a `*-release` tag or by running the `Promote to Production`
workflow, which creates the next release tag for you.

### One-liner

```bash
git tag v0.2.9-release && git push origin v0.2.9-release
```

### Steps

1. Ensure all changes are merged to `master`
2. Wait for staging deployment to finish successfully
3. Either:
   Create and push a new tag with incremented version:
   ```bash
   git tag vX.Y.Z-release && git push origin vX.Y.Z-release
   ```
4. Or run `Promote to Production` in GitHub Actions and choose `patch`, `minor`, or `major`
5. The `Deploy to Production` workflow will build and deploy the selected tag after approval

---

🤖 Built with AI pair-programming assistance (Claude)
