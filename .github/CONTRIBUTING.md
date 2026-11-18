# Contributing to Hyperion Frontend

Hyperion frontend is the routing and status interface between Stellar and EVM chains.
It surfaces quotes from the router contract, connects wallets across both ecosystems,
and tracks live transfer lifecycles.

## Issue assignment requirement

Request assignment from a maintainer before opening a pull request. Reference the issue in
the PR title or description, preferably with `Closes #42`. You must be a current assignee
on every referenced issue in the StellarHyperion organization. Local issue numbers,
`StellarHyperion/repository#42`, full GitHub issue URLs, and GitHub's linked closing issues
are supported. References inside HTML comments and fenced examples do not count.
References to other pull requests or issues outside StellarHyperion do not grant eligibility.

The `PR assignment enforcement` action closes unauthorized PRs and PRs without a referenced
issue. It sweeps all open PRs every five minutes and runs when an issue is assigned or
unassigned. GitHub may delay scheduled runs. Reopened and edited PRs are included in the
next sweep. Closing a PR leaves its issue open and never merges its changes. Ask for
assignment before reopening a rejected PR.

Organization owners and members, repository collaborators, users with admin, maintain,
write, or triage permission, and users named in the default branch's CODEOWNERS are exempt.
Team code owners qualify through organization membership. Public read access and previous
contributions alone do not grant an exemption.

Trusted helper bots are Dependabot, Renovate, GitHub Actions, GitHub Copilot, and CodeRabbit.
Maintainers can add other exact bot or service account logins to the comma-separated
repository Actions variable `PR_ASSIGNMENT_HELPER_BOTS`. An unknown bot still needs issue
assignment unless it qualifies through a repository role or code ownership.

The action uses GitHub's built-in token and only executes the policy on the default branch.
It never checks out a PR branch. API verification errors preserve affected PRs and fail the
workflow for maintainer review. No personal access token is needed in Actions. The action
records its decisions in the run log and summary. Use its manual `dry_run` input to inspect
decisions without closing PRs.

Policy regression tests also run in the required contribution security job. Run them locally:

```bash
python3 -B .github/scripts/test_enforce_pr_assignments.py
```

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
