# ADR-015: Production-safe NDK filter validation and stable kind-0 profile fetching

## Status

Accepted

## Date

2026-08-02

## Related

- PR: #1207
- User-reported crash: `AI_GUARDRAILS ERROR: Filter[0].authors[0] is not a valid 64-char hex pubkey: ""`
- Symptom: profile pages fail to load / show a false "Could not load user profile" after the browser tab is backgrounded and refocused.

## Context

Two distinct failure modes were producing the same user-visible outcome — a
profile page that wouldn't load — and both traced back to how NDK filters and
kind-0 (metadata) fetches were handled.

1. **Filter-validation crash.** NDK AI Guardrails were enabled unconditionally
   in production via `{ skip: ... }`. The `filter-invalid-hex` guardrail is a
   fatal, `canDisable: false` throw, so any filter carrying an empty/invalid
   pubkey — e.g. `{ authors: [''] }` produced by a `pubkey ?? ''` fallback
   during a transient state — crashed the page. Several query helpers built
   `authors` / `#p` filters straight from a pubkey parameter with no empty
   check, so an empty string reached the filter and threw.

   Disabling guardrails alone is **not** sufficient: NDK validates every
   filter before subscribing regardless of guardrails, and the default
   `filterValidationMode: 'validate'` _also_ throws (`"Invalid filter(s)
detected"`) on a bad pubkey — the page would still crash, just with a
   different message.

2. **Stale-refetch profile clobber.** Kind-0 metadata is a stable,
   rarely-updated event, yet profile reads used React Query defaults
   (`refetchOnWindowFocus: true`). On a degraded relay pool after a backgrounded
   tab, the refetch can EOSE-empty and React Query commits `{ profile: null }`
   over previously-loaded good data, which trips the `!profile` "Could not
   load user profile" error even though the profile was fine moments before.
   This was confirmed by A/B test (revert → bug returns; re-apply → bug gone).

## Decision

Three coupled decisions; each guards a layer the next depends on.

### 1. Disable AI Guardrails in production; set `filterValidationMode: 'fix'`

- AI Guardrails are an NDK **dev-time educational tool** (shipped off by
  default). Gate them on `stage`: **on** in `development`/`staging` (useful
  dev tooling), **off** in `production` (graceful degradation, not a fatal
  throw).
- Set `filterValidationMode: 'fix'` in production. In `'fix'` mode NDK
  **strips** invalid entries from a filter instead of throwing; if that
  empties an `authors`/`#p` array the key is dropped entirely (`void 0`),
  broadening the filter rather than crashing. Dev/staging keep the default
  `'validate'` so filter bugs surface loudly during development.
- The server-side app-settings fetch NDK uses `aiGuardrails: false` +
  `filterValidationMode: 'fix'` (lenient, never crash).

These two are **inseparable**: guardrails off without `'fix'` still throws in
`'validate'`; `'fix'` without guardrails off keeps the educational throw.

### 2. Guard empty-string pubkey paths before building Nostr filters

The primary defense. Query helpers that build `authors`/`#p` from a pubkey
parameter now short-circuit on an empty/blank pubkey (early-return / throw /
`enabled: !!pubkey`) instead of constructing an invalid filter. No fetching
logic is changed beyond guarding the error-causing condition:

- `fetchProfileByIdentifier` — bail on empty/blank identifier
- `useProfileName` / `useProfileNip05` — add `enabled: !!pubkey` (matching
  the existing `useProfile`)
- `fetchAuthor` — throw on empty pubkey
- `fetchShippingOptionsByPubkey`, `fetchProductsByPubkey`,
  `fetchCollectionsByPubkey`, `fetchOrdersByBuyer`, `fetchOrdersBySeller`,
  `fetchSellerPrivateOrderGiftWraps`, `resolvePaymentDetailsForProduct` —
  early-return on empty pubkey

### 3. Do not refetch kind-0 metadata (stable events)

- Stop refetching kind-0 on `refetchOnWindowFocus` / `refetchOnReconnect`.
- Keep previous data visible during any refetch (`keepPreviousData`).
- `staleTime: 60_000`.

### Explicit non-goals

- **Do not** return a placeholder profile instead of the "Profile not found"
  error. The error condition stays `!profile` so genuinely-unfound profiles
  (valid hex, but no kind-0 metadata anywhere) still show the error.
- **Do not** change any fetching logic apart from guarding the
  error-causing condition.

## Consequences

- An empty/invalid pubkey in production can no longer crash a page: the query
  guards prevent the invalid filter from being built (primary), and
  `filterValidationMode: 'fix'` strips any that slip through (safety net).
- Dev/staging retain loud failure on filter bugs (`'validate'` + guardrails
  on), so regressions are caught before production.
- Profile metadata is no longer clobbered by a degraded post-refocus refetch;
  the previously-loaded profile stays visible.
- New query helpers that build `authors`/`#p` from a pubkey parameter must
  guard against empty input. The server-side app-settings NDK pattern
  (`aiGuardrails: false`, `filterValidationMode: 'fix'`) is the template for
  any future one-off server fetch NDK instance.
- `'fix'` broadens (does not narrow) a filter when it strips a bad author, so
  it must remain a safety net, not the primary defense — the empty-pubkey
  guards are the contract that keeps filters well-formed.
