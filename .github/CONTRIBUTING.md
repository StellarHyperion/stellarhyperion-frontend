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

CI runs on opened, updated, reopened, and edited pull requests, including changes
from draft to ready for review. `Automatic PR CI` responds to those PR events
without waiting for a scheduled sweep. It authorizes waiting fork CI only when the
author is assigned to every referenced issue, or satisfies a documented trusted
bot, organization-role, or code-owner exemption. Issue-assignment events and the
five-minute scheduled sweep remain recovery paths. GitHub event delivery and runner
availability can still delay execution; conflicted PRs may have no runnable CI.

The approval job uses a `pull_request_target` event restricted to `main`. It never
checks out a branch, downloads contributed artifacts, or executes PR code. It loads
only default-branch authorization modules through the GitHub API. Only the current
fork head's ordinary `ci.yml` run can be approved. The job waits briefly for a newly
submitted or edited PR's CI run to register, rechecks all issue assignments, and
checks the PR head and description again immediately before approval. It cannot
approve a code review or merge a PR. PR build jobs retain read-only permissions and
receive no deployment or signing secrets.

The workflow-security scan permits the privileged trigger only in this exact,
reviewed approval workflow, pinned by SHA-256 in `scan_workflow_security.py`. A
workflow edit invalidates that exception until its trust boundary is reviewed and
the fingerprint updated. Every other medium/high Zizmor finding, including a
privileged trigger in another workflow, still blocks the gate. Repository ignore
comments and configuration cannot suppress findings.

## PR description requirements

The gate checks human descriptions against `.github/pull_request_template.md` at
the PR's base commit. Keep its level-two sections in order, answer each section,
and retain and select applicable checklist items. If a section does not apply,
write `Not applicable:` followed by the reason. Hidden comments, code examples,
blank answers, and unfilled TODO/TBD placeholders do not satisfy the template.
Description edits rerun CI. This validates the description's structure and
attestations; reviewers still assess whether its claims match the change.

Authenticated `dependabot[bot]` and `renovate[bot]` accounts are exempt only from
description formatting. Their full build and security checks remain required.

## Source and dependency security

The required gate includes CodeQL's `security-extended` analysis for
JavaScript/TypeScript and Python, without executing a project build. High and
critical source findings block; all findings are retained as SARIF artifacts for
14 days. The analysis uses read-only permissions and does not require a paid plan
for these public repositories. Existing dependency, secret, workflow and
contract-specific checks remain required. These tools do not prove that arbitrary
code is free of malware.

For dependency behavior and suspected malware detection, the
[Socket Security GitHub App](https://github.com/apps/socket-security) offers a
[free plan for public repositories](https://socket.dev/pricing). It can identify
known malware, suspicious install scripts, obfuscation, typosquatting, and risky
API usage. Install it through GitHub's app installation screen and select the
three StellarHyperion repositories. Installation is separate from these committed
checks and requires the organization's GitHub browser authorization. This change
does not claim that the Socket app is already installed. Review its first alerts
and check names before making its external check required; do not bypass existing
gates to accommodate an alert.

Run its regression tests locally:

```bash
python3 -B .github/scripts/test_approve_pr_ci.py
```
