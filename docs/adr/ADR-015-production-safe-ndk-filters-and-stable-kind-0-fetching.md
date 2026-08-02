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
that wouldn't load.

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
  default strict validation (a malformed appPubkey fails closed rather than
  broadening the query).

### 2. Guard empty-string pubkey paths before building Nostr filters

Query helpers that build `authors`/`#p` from a pubkey parameter short-circuit
on an empty/blank pubkey (early-return / throw / `enabled: !!pubkey`) instead
of constructing an invalid filter. No fetching logic is changed beyond
guarding the error-causing condition.

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

### Explicit non-goals

- **Do not** return a placeholder profile instead of the "Profile not found"
  error; genuinely-unfound profiles still show the error.
- **Do not** change fetching logic apart from guarding the error-causing
  condition and the transient/absence distinction.

## Consequences

- An empty/invalid pubkey is rejected at the query layer (fail closed); NDK
  strict validation is retained, so any filter that slips past the guards
  fails loudly rather than being silently broadened.
- Guardrails off in production removes the `AI_GUARDRAILS` educational throw;
  strict `'validate'` remains the backstop for malformed filters.
- A transient post-refocus refetch no longer clobbers a loaded profile
  (throws → `isError` + retained data; `keepPreviousData` covers the pending
  state). Genuine absence still surfaces the "not found" error.
- New query helpers building `authors`/`#p` from a pubkey must guard empty
  input.

## Follow-ups (not in this PR, per review)

- Upgrade the empty-pubkey guards from truthiness (`!!pubkey`) to full
  repo-standard `isValidHexKey` validation, and validate profile identifiers
  with `validateProfileIdentifier` before any relay request.
- Validate `appPubkey` before the app-settings query and verify the returned
  event's publisher authority (author + kind 31990 + exact `d` tag).
- Resolve the products-query overlap with #1206 (which uses `isValidHexKey`
  at the query-activation boundary).
