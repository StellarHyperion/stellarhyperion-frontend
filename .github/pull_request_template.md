<!--
Every question below is here because design drift and broken invariants are expensive to reverse.
Do not delete sections. If one does not apply, write "not applicable" and explain why.
-->

## What changed

<!--
Plain prose. What is different in the UI, components, or client logic after this change.
-->

## Why

<!--
What user experience problem was addressed, what protocol capability was enabled, or what bug was fixed.
-->

## Affected subsystems

<!--
Select all subsystems affected by this change:
-->

- [ ] Design token layer (`src/app/globals.css`, `src/app/tokens.ts`)
- [ ] Brand and geometry (`src/components/brand/`, `src/components/switchyard/`)
- [ ] Wallet adapters (`src/wallets/stellar/`, `src/wallets/evm/`)
- [ ] Route planner and quotes (`src/planner/`)
- [ ] Transfer execution and stages (`src/components/transfer/`)
- [ ] Transfer registry and history (`src/app/transfers/`, `src/api/`)
- [ ] Layout and chrome (`src/components/chrome/`, `src/app/layout.tsx`)

## Design rules and house checks

- [ ] Zero box shadows anywhere in components or styles
- [ ] No hex color values outside the token layer (`src/app/globals.css`, `src/app/tokens.ts`)
- [ ] No em or en dashes in prose, comments, or documentation
- [ ] No emoji or glyph arrows
- [ ] No banned marketing vocabulary
- [ ] WCAG 2.2 AA contrast verified across dark surfaces (`npm run contrast`)
- [ ] Reduced motion collapses animations to instant state swaps

## Verification

<!--
Confirm the commands run locally prior to submission:
-->

- [ ] `npm run fmt:check` (Prettier code style check)
- [ ] `npm run house` (Repo house rules enforcement)
- [ ] `npm run contrast` (WCAG 2.2 AA contrast check)
- [ ] `npm run test` (Vitest unit and audit tests)
- [ ] `npm run lint` (ESLint Next.js rules)
- [ ] `npm run typecheck` (TypeScript typecheck)
- [ ] `npm run build` (Next.js production build)
- [ ] `npm run check` (Complete verification pipeline)
