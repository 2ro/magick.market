# AGENTS.md — src/components

This directory follows the repository-level AGENTS.md and `src/AGENTS.md`.

## Context

`src/components/` contains reusable UI components, feature components, dialogs,
wallet UI, product/profile display components, and shadcn/Radix-style primitives
under `src/components/ui/`.

## Constraints

- Keep protocol parsing, payment state machines, signing decisions, and relay
  publishing out of presentational components.
- Components may display query, relay, auth, wallet, or payment state, but they
  should not turn those states into broader truth than the data layer provides.
- Do not render secrets, private keys, NWC URIs, Cashu seed material, or raw
  sensitive payment details.
- Preserve accessible labels, roles, focus behavior, and existing shadcn/ui
  conventions when changing controls.

## Directory structure (per ADR: Component UI Migration §1b)

```
src/components/
  ui/              ← Shadcn primitives (generated, unmodified)
  ui-wrappers/     ← Wrappers around ui/ primitives with custom styling/behavior
  shared/          ← General-purpose reusable components (non-domain-specific)
  nostr/           ← Nostr-domain components (users, products, auctions, profiles)
  layout/          ← Structural components (Header, Footer, Sidebar)
  dialogs/         ← Dialog compositions built on ui/dialog
  theme-migration/ ← ThemeMigrationWrapper + scoped theme infrastructure
```

New components must be placed in the appropriate subdirectory above. Legacy
components that currently live outside `src/components/` are tracked as
migration debt and will be relocated during their slice migration.

### Import hierarchy

The import hierarchy applies to **new and migrated code only**. Existing
legacy components that violate these rules are tracked as migration debt and
are not required to be fixed as part of this PR — they will be addressed
during their respective slice migrations (see ADR §2a Classification System).

For new and migrated code, components may only import from directories below
them in the hierarchy:
`ui` → `ui-wrappers` → `shared` / `nostr` / `layout` / `dialogs`. New UI
components must be placed in `src/components/`. Each subdirectory's
`AGENTS.md` file is the authoritative source for its import rules and
exceptions.

### Canonical import alias

`@/components/{directory}/{component}`. Barrel exports per directory allowed.
Routes must import UI exclusively from `src/components/`.

## Instructions

- Prefer existing UI primitives and local component patterns before adding new
  abstractions.
- Keep loading, empty, error, and eventually-consistent relay states visible
  when a component depends on Nostr data.
- Use icons and controls consistently with the surrounding UI.
- **Ref convention (React 19 ref-as-prop, per ADR: Component UI Migration):**
  - `src/components/ui/` holds generated Shadcn primitives. Leave them **as-is,
    no diffs** — do not modify them. They use the modern
    `React.ComponentProps` + `data-slot` style.
  - Components authored by us (in `ui-wrappers/`, `shared/`, `nostr/`,
    `layout/`, `dialogs/`, and feature directories) **must expose `ref`** to
    their root DOM element. React 19 (\^19.2.6) supports `ref` as a regular
    prop — `forwardRef` is not required. Accept `ref` in the component's
    props type and pass it through to the root element (or the underlying
    Shadcn primitive, which spreads `{...props}` onto its root node).
  - **Passing refs through Shadcn primitives:** most Shadcn primitives spread
    `{...props}` onto their root DOM element, so a `ref` passed into the
    primitive's props attaches to that node. Our `ui-wrappers/` components
    should rely on this: pass `ref` through to the primitive via its props.
    **Do not** wrap the primitive in an extra DOM element solely to attach a
    ref. This keeps the wrapper a single element. Per-subdirectory `AGENTS.md`
    files (e.g. `ui-wrappers/AGENTS.md`) restate this rule.

## Safe Checks

- `git diff --check`
- `bun run format:check`
- For behavior changes, run focused unit/integration checks when relevant and
  authorized.
