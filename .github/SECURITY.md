# Security policy

Hyperion frontend operates the user interface, wallet connection adapters, route pricing
planner, and transfer status visualizer. Because the frontend prepares transactions for wallet
signatures, client-side defects could construct invalid transfer parameters, misrepresent
protocol fees, or expose user credentials.

## Supported versions

| Revision        | Supported | Notes                      |
| --------------- | --------- | -------------------------- |
| `main`          | Yes       | Active development branch. |
| Tagged releases | Not yet   | Pre-release phase.         |

Report vulnerabilities against the latest commit on `main`.

## Reporting a vulnerability

Use GitHub private vulnerability reporting:

**https://github.com/StellarHyperion/stellarhyperion-frontend/security/advisories/new**

Advisories remain confidential between the reporter and maintainers until a coordinated
disclosure date is established.

Do not submit vulnerability reports through public issues or PR discussions.

### What to include

- Specific commit hash evaluated.
- Affected component (e.g. wallet provider, planner arithmetic, transfer submission).
- Attack prerequisites (e.g. malicious RPC node, malicious wallet extension).
- Demonstrated security impact (e.g. transaction parameter spoofing, cross-site scripting).
- Step-by-step reproduction instructions.

## Scope

### In scope

- Transaction spoofing or parameter injection prior to wallet approval.
- Cross-site scripting (XSS) or prototype pollution in client bundles.
- Client-side quote manipulation that hides true protocol fees or destination amounts.
- Insecure storage or leakage of user wallet keys or addresses.

### Out of scope

- Compromised browser extensions or malicious wallet software installed on the user device.
- Upstream vulnerabilities in external RPC endpoints or wallet connect relays.
- Social engineering attacks against users.
