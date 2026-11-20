# Hyperion frontend

[Open Hyperion](https://stellarhyperion.vercel.app/) | [Backend](https://github.com/StellarHyperion/stellarhyperion-backend) | [Contracts and deployment evidence](https://github.com/StellarHyperion/stellarhyperion-contracts)

A focused bridge interface for Stellar wallets, real quotes and verified destination payments. The app uses a compact send/receive composer, native token and destination pickers, explicit quote loading, a review before signing and recoverable transaction progress.

## Changes since October 12, 2026

- Replaced simulated transfer submission with real Soroban construction, simulation, wallet signing and broadcast. Live Axelar and Circle fee estimates are reviewed before signing.
- Added liquid Stellar asset conversion, trustline creation and paid ITS/CCTP routes, with saved signed hashes and recovery that checks uncertain outcomes before another submission.
- Replaced the wallet-kit bundle with direct Freighter, Albedo, xBull and LOBSTR SDKs, checked transaction signatures, and updated Next.js to 16.4.3. Activity now displays independently verified destination payouts and genuine claims.

## Assets and routes

Send canonical Stellar USDC directly, or choose another classic Stellar asset. The app discovers wallet balances and issued assets through Stellar Testnet Horizon, then finds a real liquid conversion path into USDC. Issuer addresses distinguish assets with the same symbol. A listed asset still needs liquidity before a usable quote can exist.

- Axelar ITS delivers the seven-decimal ITS representation of Stellar USDC to Ethereum Sepolia. This is not Circle's native Sepolia USDC.
- Circle CCTP delivers six-decimal native USDC to supported Sepolia, Base Sepolia and Arc Testnet lanes. Circle's forwarding service mints on the destination; its live USDC fee budget is included in the receive minimum.

The interface reads the active router, adapter configuration, destination contracts, token precision and bridge capabilities. A configured destination does not guarantee an available lane. Pending activation, paused routes, missing liquidity and unavailable pricing prevent signing rather than producing placeholder quotes.

Conversion and bridging are separate signed transactions. The conversion uses a strict-receive path payment with an exact source spending cap and 0.5% price tolerance. It can create the canonical USDC trustline in the same transaction. If the bridge cannot proceed, the converted USDC remains in the user's wallet. The app saves the actual signed hash before broadcast; after an interruption, it checks the recorded transaction before offering a fresh bridge review. Unknown outcomes never trigger an automatic resend.

Recovery first checks bounded Stellar RPC evidence, then falls back to Horizon when the RPC history is absent or unavailable. Every accepted result must establish the Testnet network, signed hash, account and matching operations. Conversion success also requires a matching canonical USDC payment result. Continuing requires the same wallet, a current authorized spendable USDC balance, a fresh quote and simulation, and explicit approval. Historical failure is distinct from missing, malformed or conflicting evidence, which leaves the checkpoint unknown and intact. Source confirmation does not establish destination delivery.

## Run

Node 22.13 or newer is required.

```bash
npm ci
npm run dev
```

Connect Freighter, Albedo, xBull or LOBSTR for Stellar Testnet through the native wallet picker. Direct wallet SDKs replace the multi-chain wallet-kit bundle. Only Freighter restores a saved connection silently; popup wallets require an explicit selection. Every returned signature is checked against the exact requested transaction, connected account and Testnet passphrase before submission. Users need testnet XLM for reserves and network fees, plus Axelar relay gas when using ITS. The setup disclosure links to the XLM and Circle testnet faucets. Testnet assets have no cash value.

## Configuration and tracking

The checked-in deployment supplies the default router and canonical USDC asset. Public overrides are documented in `.env.example`. The app is testnet only.

At startup, the public configuration admission check compares the network,
router and canonical token against the checked-in testnet deployment and
requires an HTTPS RPC endpoint. A mismatch renders an unavailable state with
safe diagnostic labels; it never prints environment values or server secrets.

`NEXT_PUBLIC_STELLAR_READ_RPC_URLS` may list up to two additional, independently operated Stellar Testnet RPC origins, comma-separated. RPC transaction status is accepted only when every configured source identifies as Stellar Testnet and agrees on the signed hash, outcome, encoded result and return value. Reads share a five-second deadline and support cancellation. Disagreement or an unavailable source alongside final evidence leaves the saved transaction unknown; historical fallback cannot override conflicting RPC evidence. When RPC history is absent, the independently network-checked Horizon recovery path remains available. Reset compares the complete saved checkpoint so a change in another tab cannot discard a different intent.

`NEXT_PUBLIC_HYPERION_API_URL` supplies transfer activity and destination verification. The backend must run its indexer and rail pollers regularly. The public testnet uses a five-minute GitHub Actions schedule, subject to runner queueing; destination Activity can take several minutes to update. Unreachable history is shown explicitly. A confirmed Stellar transaction proves source execution; destination delivery requires matching confirmed bridge and token-payment events.

Transfer history refreshes every 10 seconds and transaction details every 5 seconds while visible; hidden tabs reduce those reads to once per minute. Each poll owns one timer and one request, aborts obsolete lookups, and obtains fresh status immediately when visibility returns. Pagination and claim recovery wait for that refresh; a failed indexer refresh keeps claim actions blocked. Public source hashes remain in the URL and pending checkpoint regardless of polling activity. No visibility event signs or resubmits a transaction.

The public Axelar and Circle fee routes share a fixed process budget of 120 admitted requests per minute and at most four concurrent provider calls. The budget does not trust caller forwarding headers or allocate per-address maps. A saturated route returns `429` with `code: RATE_LIMITED`, an integer `retryAfter`, and `Retry-After`; retry after that delay. Upstream429/503 also sets one bounded cooldown per provider, shared across destinations on both the server process and client. The composer preserves inputs, shows unavailable pricing and disables explicit fee retry until the cooldown expires. Expiry never automatically signs, sends or retries a quote. Every provider call has a 15-second timeout and an 8192-byte response limit. Request URLs are limited to 2048 characters, unknown or repeated parameters are rejected, and Circle destinations must match the configured testnet allowlist. These budgets apply to each server process; replicas each have their own budget. Failed provider estimates stay unavailable instead of becoming zero or fixed prices.

Next serves `/api/relay-fee` for Axelar's live ITS estimate and `/api/cctp-fee` for Circle's finalized forwarding estimate. Static export cannot serve these endpoints. There are no fixed relay prices, generated transaction hashes, sample claims or fabricated history.

Relay budgets include 10% headroom over the live estimate. The Axelar XLM budget is paid in full; the Circle receive minimum accounts for the full USDC forwarding budget. A refreshed estimate must fit inside the displayed budget before signing. Transient read failures receive one bounded retry; signed transactions are never retried automatically.

Hyperion charges 30 basis points (0.3%) on the bridged USDC amount. The source transaction sends that protocol fee to the router's configured Stellar treasury. Bridge forwarding, relay and network fees are separate and shown before signing.

Claim recovery reads `get_claim` and signs `settle_claim` on the Stellar router. It pays the recorded recipient. A claim exists only when a destination router has parked funds for recovery; completed transfers have no claim number. Activity displays genuine claim numbers and settlement status, while transfer details explain when no claim exists. A delayed outbound transfer does not automatically become a Stellar claim.

Transfer history keeps destination token identity, precision and the actual paid amount separate from the source net amount and quote minimum. If an indexer record omits token metadata, the UI shows base units and the raw token address rather than guessing a symbol or decimal precision. Claim approval performs a final on-chain refresh immediately before building the wallet request; settled or changed claims remain visible but cannot be signed. A live operation lock prevents a second browser tab from replacing an unresolved signing intent. Run `npm run test:browser:faults` to build the actual production modules in an isolated browser fixture. Two real tabs compete during delayed approval, one generated signed transaction reaches the controlled RPC boundary, and its public hash survives tab closure. The harness also renders exact CCTP/ITS and unknown-precision destination records; no network transaction is sent. Set `HYPERION_RECOVERY_EVIDENCE_DIR` to save inspected captures and source hashes.

## Deploy

The production alias is [stellarhyperion.vercel.app](https://stellarhyperion.vercel.app/), attached to the Vercel project `hyperion`. Set `NEXT_PUBLIC_HYPERION_API_URL=https://stellarhyperion-backend.vercel.app` in its production environment, then deploy from this repository with `vercel deploy --prod`. The app requires a Next.js server for its live bridge-fee API routes.

The backend uses a server-side PostgreSQL connection and a scheduled indexer. Database credentials and signing keys must never be included in `NEXT_PUBLIC_` variables. The checked-in deployment is testnet only. See the backend README for the scheduled indexer, optional continuous container and database configuration.

Vercel's installed Git integration publishes `main` after pushes. GitHub Actions runs quality checks; the legacy token-based deployment jobs were removed to avoid duplicate deployments and expired deployment credentials.

## Public asset metadata

Asset discovery caches only public code, issuer, Stellar precision and deployment identity, with a five-minute freshness window and at most 64 entries in memory and browser storage. Keys separate networks, deployment revisions and same-symbol issuers. During a Horizon outage, the picker can show cached identities with an explicit cached or stale source label. Balances, authorization, conversion prices, recipients and signed amounts are never taken from this cache; signing still requires fresh account and quote checks. Storage failure leaves safely available discovery reads usable and does not clear transaction recovery checkpoints.

## Verification

`npm run check` runs formatting, interface rules, contrast checks, unit tests, lint, types and the production build. Start the app and run `npm run test:browser` for the real wallet picker, theme persistence, native selectors and mobile layout. Chromium must be installed with `npx playwright install chromium`.

Set `HYPERION_BROWSER=firefox` to check Firefox, or `HYPERION_BROWSER_EXECUTABLE` to use a specific installed browser executable.

Live transaction tests require explicit opt-in and real named CLI wallets. `test/live-transfer.test.ts` retains the original ITS acceptance. `test/live-routes.test.ts` verifies conversion or CCTP through actual destination payment, preserving its proof file across interrupted runs. Normal tests skip both live suites.

The ITS suite keeps its default proof at `~/.hyperion-testnet-proofs/its-transfer.json` in a private directory owned by the current user. That stable path preserves recovery across reruns. Set `HYPERION_TESTNET_PROOF` to resume another saved proof. Proof files use owner-only permissions and remain available after interruption.

For the route suite, set `HYPERION_LIVE_ROUTES=1`, `HYPERION_ROUTE_MODE=convert` or `cctp`, `HYPERION_ROUTE_IDENTITY`, `HYPERION_ROUTE_PROOF`, `HYPERION_ROUTE_DESTINATION`, `HYPERION_TESTNET_APP_URL`, `HYPERION_TESTNET_RECIPIENT` and `NEXT_PUBLIC_HYPERION_API_URL`. Conversion spends at most 1 testnet XLM plus fees; CCTP spends 0.3 testnet USDC. Never delete a pending proof to retry a transfer.

Verified testnet acceptance is published with actual signed transaction hashes and destination payment evidence:

| Evidence                                                                                                                                              | Result                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [Paid ITS acceptance](https://github.com/StellarHyperion/stellarhyperion-contracts/blob/main/deployments/evidence/2026-10-28-paid-its.json)           | Stellar USDC delivered through ITS to Ethereum Sepolia                                   |
| [Asset conversion acceptance](https://github.com/StellarHyperion/stellarhyperion-contracts/blob/main/deployments/evidence/2026-10-29-conversion.json) | An XLM-only wallet created its USDC trustline, converted XLM and completed an ITS payout |
| [CCTP acceptance](https://github.com/StellarHyperion/stellarhyperion-contracts/blob/main/deployments/evidence/2026-10-29-cctp.json)                   | Native-USDC payouts verified on Ethereum Sepolia, Base Sepolia and Arc Testnet           |

The [October 29 CI run](https://github.com/StellarHyperion/stellarhyperion-frontend/actions/runs/40881695541) passed formatting, interface/contrast checks, lint, types, the production build and 54 ordinary tests. The two live suites require explicit opt-in and are skipped in normal runs. Browser verification also covered wallet errors/cancellation, saved connections, mobile layout, themes, live quotes and recorded receipt links in Chromium and Firefox.

As of October 29, 2026, `npm audit` reports zero known vulnerabilities after patching Next.js to 16.4.3 and replacing the wallet-kit bundle with direct SDKs. Adapter tests use mocked wallet responses and real locally generated signatures; browser checks cover the picker and read-only flows. These checks do not certify third-party wallets or replace signed live acceptance.

## Interface

The layout study used [Jumper](https://jumper.xyz/), [Relay](https://relay.link/bridge) and [Stargate](https://stargate.finance/) as reference points for focused asset selection and progressive route details. Hyperion adds explicit receive-token identity, quote request feedback, review and interruption recovery. Decorative orbital paths provide background motion without implying that funds are moving. One theme button switches between light and dark; all motion honors reduced-motion preferences.

MIT.

## Independent acceptance proof checks

Live ITS and route runners save the public signed source envelope and hash before broadcast, use atomic proof-file replacement and permit one runner per proof. An interrupted lock stays in place for manual inspection. Pending source and conversion hashes cannot be overwritten by a retry.

Acceptance requires matching source account, canonical token contract, route, destination, recipient and exact integer amounts; origin gross, fee and net must agree. A successful destination receipt must match the indexed hash and block and contain the exact token Transfer payment to the recipient. A balance increase or provider reference alone cannot satisfy this check.

Set `HYPERION_LIVE_PROOF=1` to inspect an existing ITS proof without signing. It uses `HYPERION_TESTNET_PROOF` or the same private default proof path as the ITS runner, verifies the public signature and source confirmation, then independently reads the Sepolia receipt. It does not enable the spending suites. Existing proofs without their public signed envelope remain available for manual recovery and cannot pass acceptance automatically.

Deterministic checks cover source-only evidence, wrong chains, recipient or token, missing and inexact amounts, unrelated receipts, interrupted writes, retained hashes and competing proof owners. Application source and dependencies match the fully validated binding-limit head. Its diagnostic browser evidence and the included conversion-recovery evidence are retained under `docs/review/`. Live spending remained disabled during this repair.

## Client bundle budgets

`npm run build` retains the minified Turbopack production build and runs its native analysis, then checks actual emitted client chunks. The budget check joins each emitted JavaScript source map to installed modules and the native sync/async import graph, and uses Next's route first-load manifest. Missing or stale attribution fails the build. Per-route diagnostics identify the responsible chunk, package and import chain; unique chunks are counted once across routes. Optional wallet adapters are capped at450,000 uncompressed JavaScript bytes and transaction code at1,200,000 bytes. Wallet adapter chunks must remain asynchronous on the landing route. Client source maps are generated for this measurement.

The complete report is `.next/diagnostics/bundle-attribution.json`; [bundle validation](docs/review/provider-cooldown-budget/README.md) records final measured totals and browser checks.
