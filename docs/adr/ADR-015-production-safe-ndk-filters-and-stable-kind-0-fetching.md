# ADR-015: Production-safe NDK filter handling and stable kind-0 profile fetching

## Status

Accepted

## Date

2026-08-02

## Related

- PR: #1207
- User-reported crash: `AI_GUARDRAILS ERROR: Filter[0].authors[0] is not a valid 64-char hex pubkey: ""`
- Symptom: profile pages fail to load / show a false "Could not load user profile" after the browser tab is backgrounded and refocused.
- Review feedback: #1206 (products empty-pubkey guard), maximotodev review of #1207.

## Context

Two failure modes produced the same user-visible outcome — a profile page
that wouldn't load — and a third latent risk was surfaced in review.

1. **Filter-validation crash.** NDK AI Guardrails were enabled unconditionally
   in production via `{ skip: ... }`. The `filter-invalid-hex` guardrail is a
   fatal, `canDisable: false` throw, so any filter carrying an empty/invalid
   pubkey — e.g. `{ authors: [''] }` from a `pubkey ?? ''` fallback during a
   transient state — crashed the page. Several query helpers built
   `authors`/`#p` filters straight from a pubkey parameter with no empty
   check, so an empty string reached the filter.

2. **Profile clobber.** Kind-0 metadata is a stable, rarely-updated event,
   yet profile reads used React Query defaults (`refetchOnWindowFocus: true`).
   On a degraded relay pool after a backgrounded tab, a refetch could resolve
   to a null-shaped value and React Query committed `{ profile: null }` over
   previously-loaded data, tripping a false "Could not load user profile".
   Compounding this, `fetchProfileByIdentifier` wrapped every path in a
   try/catch that returned `{ profile: null, user: null }`, so timeout, relay
   error, no connection, and genuine absence were all indistinguishable.

3. **App-config authority gap.** Not a reported crash, but a latent risk
   surfaced in review: the kind-31990 app-config fetch queried by author +
   kind + d tag yet trusted whichever returned event had the highest
   `created_at`. The content schema validates shape, not publisher authority,
   so a malformed `appPubkey` (or a relay returning an event from a different
   publisher) could yield app settings from an unrelated source.

## Decision

### 1. Disable AI Guardrails in production; retain strict filter validation

- AI Guardrails are an NDK **dev-time educational tool** (shipped off by
  default). Gate them on `stage`: **on** in `development`/`staging`,
  **off** in `production`.
- **Retain NDK's default strict filter validation** (`'validate'`) in all
  stages. Do **not** set `filterValidationMode: 'fix'`: in `'fix'` mode NDK
  strips a bad `authors`/`#p` entry and, if that empties the array, drops the
  key entirely — broadening an identity-scoped request instead of rejecting
  it. That is fail-open and unsafe for marketplace identity, order, payment,
  and private-data boundaries. Invalid/empty pubkeys are rejected at the
  query layer **before** any filter is built (fail closed); strict validation
  then never throws because filters are always well-formed.
- The server-side app-settings fetch NDK uses `aiGuardrails: false` with
  default strict validation. App-config publisher authority is verified
  separately (see decision 4).

### 2. Validate identity inputs before building Nostr filters

Query helpers that build `authors`/`#p` from a pubkey parameter reject a
malformed pubkey (not just an empty one) before constructing the filter, using
the repository-standard checks:

- **Hex-pubkey fetchers** (`fetchAuthor`, `fetchShippingOptionsByPubkey`,
  `fetchOrdersByBuyer`/`fetchOrdersBySeller`,
  `fetchSellerPrivateOrderGiftWraps`, `fetchCollectionsByPubkey`,
  `resolvePaymentDetailsForProduct`) use `isValidHexKey` — these build
  `authors`/`#p` directly, which NDK's strict validation requires to be 64-hex.
- **Identifier-accepting** paths (`fetchProfileByIdentifier`, `useProfileName`,
  `useProfileNip05`, `useProfile`) use `validateProfileIdentifier`, because
  they feed `ndk.fetchUser`, which accepts hex/npub/nprofile/nip05. (The
  dashboard messages route passes an npub route param to `useProfileName`, so
  a hex-only gate would break that view.) The validation lives in the shared
  `profileByIdentifierQueryOptions` factory (`enabled`), not in individual
  hooks, so every consumer is gated — including route loaders and direct
  `useQuery` callers. Callers with additional conditions COMBINE (not
  overwrite) the factory's `enabled`, e.g.
  `enabled: options.enabled && !validationError`.
- **Hex-pubkey query factories** (`wotScoreQueryOptions`) use `isValidHexKey`
  at the factory level, so `useWotScore` and direct callers like `WotScore.tsx`
  inherit the guard.

This replaces the earlier truthiness (`!!pubkey`) guards, which permitted
whitespace, truncated keys, and arbitrary malformed non-empty values.

### 3. Distinguish transient fetch failures from genuine absence; don't refetch stable kind-0

- `fetchProfileByIdentifier` throws on transient failures — timeout, relay
  error, and no relay connection (`ndk.pool.connectedRelays()`, matching the
  pattern in `publish/profiles.tsx`) — so React Query treats them as `isError`
  and retains previous profile data. Only genuine absence (relays connected
  and `fetchProfile()` resolved to null) returns the null-shaped value.
- ProfilePage keeps previous data visible during refetch
  (`placeholderData: keepPreviousData`), stops refetching kind-0 on window
  focus / reconnect, and its not-found condition fires only when there is
  genuinely no profile to show (`!profile`, not `isError || !profile`).
- Behavior is covered by `profilesFetch.test.ts`.

### 4. Verify app-settings publisher authority before accepting content

The kind-31990 app-config fetch (`fetchAppSettings` in `lib/appSettings.ts`)
queries `{ kinds: [31990], authors: [appPubkey], '#d': ['plebeian-market-handler'] }`.
Two hardenings close the gap between the requested filter and the content the
app actually trusts:

- **Validate before the query**: `appPubkey` is checked with `isValidHexKey`
  before an NDK instance is created or any relay request is issued. A malformed
  key is rejected early (fail closed) rather than relying solely on NDK's
  strict filter validation to refuse the filter.
- **Verify after the fetch**: the returned events are filtered to only those
  authored by `appPubkey`, with kind 31990 and the exact `d` tag
  `plebeian-market-handler` (`selectAuthoritativeAppSettingsEvent`). The
  content schema validates shape, not authority, so a spoofed event from a
  different publisher that happens to pass `AppSettingsSchema` is refused.
  A higher-timestamp spoofed event is ignored in favor of the legitimate one.
- Behavior is covered by `appSettings.test.ts`.

### Explicit non-goals

- **Do not** return a placeholder profile instead of the "Profile not found"
  error; genuinely-unfound profiles still show the error.
- **Do not** change fetching logic apart from: input validation guards, the
  transient/absence distinction, and app-config publisher-authority
  verification. No other fetching behavior is altered.

## Consequences

- A malformed pubkey (empty, whitespace, truncated, or non-hex) is rejected
  at the query layer with `isValidHexKey` / `validateProfileIdentifier`
  before any filter is built (fail closed). NDK strict validation is retained
  as the backstop, so any filter that slips past the guards fails loudly
  rather than being silently broadened.
- Guardrails off in production removes the `AI_GUARDRAILS` educational throw;
  strict `'validate'` remains the backstop for malformed filters.
- A transient post-refocus refetch no longer clobbers a loaded profile
  (throws → `isError` + retained data; `keepPreviousData` covers the pending
  state). Genuine absence still surfaces the "not found" error.
- App-config content is accepted only from events authored by the expected
  `appPubkey` with kind 31990 and the exact d tag; a spoofed event that
  passes the shape schema is refused.
- New query helpers building `authors`/`#p` from a pubkey must validate it with
  `isValidHexKey` (hex fetchers) or `validateProfileIdentifier` (identifier
  fetchers) before constructing the filter.

## Follow-ups (not in this PR, per review)

- Products-by-pubkey is owned by #1206 (`enabled: isValidHexKey` at the
  query-activation boundary); this PR does not guard products to avoid two
  competing contracts. Merge #1206 before this PR and rebase onto the result.
