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
Descriptions pasted entirely inside a code fence are read as PR descriptions.
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

## Locked dependency audits

CI checks every committed npm lockfile version, including development and optional
dependencies, with npm's official Bulk Advisory endpoint and blocks high or critical
active advisories. No package scripts execute during the audit.
The audit verifies each finding against GitHub's canonical advisory API. A finding
is removed only when GitHub confirms that advisory was withdrawn; API errors,
incomplete evidence, and active findings remain blocking. This handles stale npm
reports without a repository allowlist or disabling security checks.

Run the audit and its regression tests locally:

```bash
python3 -B .github/scripts/test_audit_npm_dependencies.py
python3 -B .github/scripts/audit_npm_dependencies.py . --audit-level high
```

An optional `GITHUB_TOKEN` increases the API rate limit. It is sent only to the
canonical GitHub API; npm's advisory endpoint receives no GitHub credential.

Automatic Vercel Git deployments are disabled in `vercel.json` while the hosting
project is paused. Build, test, and security checks continue to run in GitHub Actions.
The Vercel GitHub app no longer has access to this repository because the paused
account reported failed statuses before reading deployment settings. Regrant the
app access and restore `git.deploymentEnabled` when hosting is ready to deploy again.

## Automatic pull request checks

CI runs on opened, updated, and reopened pull requests. The `Automatic PR CI`
action authorizes waiting fork CI when the author satisfies the issue assignment
policy, including the documented bot, organization role, and code owner exemptions.
It checks waiting runs every five minutes and when issues are assigned. GitHub
may delay scheduled runs; maintainers can also dispatch the action manually.

The authorization job uses only default-branch policy code. It never checks out PR
code, downloads contributed artifacts, approves a code review, or merges a PR.
Only the current fork head's `ci.yml` pull request run can be authorized; changed
heads or unverifiable assignments remain unapproved. The approved CI jobs retain
read-only permissions and receive no repository deployment or signing secrets.

Run its regression tests locally:

```bash
python3 -B .github/scripts/test_approve_pr_ci.py
```
