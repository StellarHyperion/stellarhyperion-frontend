# Contributing to Hyperion Frontend

Hyperion frontend is the routing and status interface between Stellar and EVM chains.
It surfaces quotes from the router contract, connects wallets across both ecosystems,
and tracks live transfer lifecycles.

## Prerequisites

- Node.js >= 20.11
- Built protocol package at `../contracts/packages/protocol`

### Protocol dependency

The frontend depends directly on `@hyperion/protocol` via local file path:

```bash
cd ../contracts/packages/protocol
npm install
npm run build
```

Never duplicate protocol definitions or hard-code contract addresses locally in the frontend.

## Local development

```bash
cd frontend
npm install
npm run dev
```

The application runs on `http://localhost:3000`.

## House rules and design tokens

The visual design system is locked in `.planning/DESIGN-TOKENS.md`:

1. Zero box shadows: Depth is achieved strictly through subtle background steps and 1px hairline rules.
2. Token layer isolation: Raw hex values are restricted to `src/app/globals.css` and `src/app/tokens.ts`. All components consume CSS variables.
3. Typography: Archivo for display and body text; IBM Plex Mono for all figures, addresses, and data labels.
4. Purposeful motion: Motion occurs only in direct response to user action or confirmed state changes. All animations collapse to 0ms when `prefers-reduced-motion` is active.
5. Contrast: All color pairings meet or exceed WCAG 2.2 AA standards.
6. Documentation integrity: No em or en dashes, no emoji or unicode arrow characters, and no banned promotional marketing vocabulary.

## Verification pipeline

Before creating a pull request, run the verification command:

```bash
npm run check
```

This command executes in order:

- `npm run fmt:check`: Prettier code style check
- `npm run house`: House rules validation script
- `npm run contrast`: WCAG AA contrast calculation script
- `npm run test`: Vitest unit and audit tests
- `npm run lint`: ESLint rules
- `npm run typecheck`: TypeScript type check
- `npm run build`: Next.js production build

## Commit guidelines

Commits in this repository follow strict identity requirements:

- Committer identity: `dotmantissa <negativemantissa@gmail.com>`.
- Commit trailers (such as `Co-Authored-By` or AI generator tags) are forbidden.
- Use concise, imperative commit titles describing the technical change.
