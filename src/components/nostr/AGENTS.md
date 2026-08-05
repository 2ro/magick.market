# AGENTS.md — src/components/nostr

This directory follows `src/components/AGENTS.md` and the repository-level
`AGENTS.md`.

## Purpose

`nostr/` contains Nostr-domain presentational components: user cards, product
cards, profile badges, NIP-05 indicators, WoT scores, post views, and other
components that render Nostr event/profile data.

## Import rules

- **May import from:** `@/components/ui/*`, `@/components/ui-wrappers/*`,
  `@/components/shared/*`, `@/lib/*`, `@/hooks/*`, `@/queries/*`
  (read-only data adapters only).
- **May NOT import from:** `layout/`, `dialogs/`, `@/publish/*`, `@/stores/*`
  (for mutations — read-only store selectors are permitted, see below), or
  feature directories (`checkout/`, `orders/`, `wallet/`, etc.).
- **Canonical alias:** `@/components/nostr/{component}`.

## Nostr data-access exception

`nostr/` is the **only** component subdirectory permitted to consume Nostr
data adapters inline for **read-only** data access. This is an explicit,
narrowly-scoped exception to the "no business logic in presentational
components" rule, documented here per ADR §1b.

### Allowed — read-only data adapters

Components may import and call the following validated data adapters:

- `useProfile` — fetch profile metadata for a pubkey (read-only)
- `useQuery` with nostr query options — fetch Nostr events for display
  (products, auctions, posts, etc.) (read-only)
- Read-only store selectors for display state (e.g.,
  `useStore(authStore)` to check authenticated-user context)

These are **data adapters** — they encapsulate Nostr protocol details
behind a stable interface. Components consume the adapter's return value;
they do not access the raw NDK/relay layer or construct queries themselves.

### NOT allowed — mutations, actions, publishing

- Cart actions (`cartActions`) — checkout-domain; pass via callbacks
- UI actions (`uiActions.openDialog`, etc.) — pass via callbacks
- Auth actions (`authActions.logout`, etc.) — pass via callbacks
- Wallet actions — pass via callbacks
- **Publishing, signing, relay management** — belongs in `src/publish/`,
  not components. Components must not import from `src/publish/` directly;
  if a Nostr action is needed, the parent route/feature passes a callback.
- Raw NDK event construction or relay publishing — components consume
  validated adapter results, not raw protocol APIs.

When a component needs to trigger an action, accept a **callback prop**
(e.g., `onAddToCart`, `onPress`, `onShare`) rather than calling the store
action inline. Data hooks for _reading_ Nostr state are the narrow
exception; _mutating_ state, publishing, and signing are not.

## Standards

- **Ref exposure (React 19 ref-as-prop):** All components **must** expose
  `ref` to their root DOM element. React 19 (\^19.2.6) supports `ref` as a
  regular prop — `forwardRef` is not required. Accept `ref` in props and
  pass it through to the root element.
- **`cn()` className merging:** Accept `className` prop, merge via `cn()`.
- **Callbacks for actions:** Accept callback props for any user action
  (clicks, selections, etc.). Data-fetching hooks are the only exception.
- **Props typing:** Extend `React.HTMLAttributes<HTMLElement>` or
  `React.ComponentProps<typeof Wrapper>` as appropriate. Prefer accepting
  `pubkey` or `profile` as a prop rather than fetching internally when the
  parent already has the data.

## Review checklist

- [ ] Exposes `ref` to root DOM element (React 19 ref-as-prop)
- [ ] Uses `cn()` for className merging
- [ ] Only data hooks (useProfile, useQuery) — no action/store mutations
- [ ] Actions delegated via callback props
- [ ] No hardcoded colors — uses semantic tokens
