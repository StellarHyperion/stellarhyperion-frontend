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

## Run

Node 22.13 or newer is required.

```bash
npm ci
npm run dev
```

Connect Freighter, Albedo, xBull or LOBSTR for Stellar Testnet through the native wallet picker. Direct wallet SDKs replace the multi-chain wallet-kit bundle. Only Freighter restores a saved connection silently; popup wallets require an explicit selection. Every returned signature is checked against the exact requested transaction, connected account and Testnet passphrase before submission. Users need testnet XLM for reserves and network fees, plus Axelar relay gas when using ITS. The setup disclosure links to the XLM and Circle testnet faucets. Testnet assets have no cash value.

## Configuration and tracking

The checked-in deployment supplies the default router and canonical USDC asset. Public overrides are documented in `.env.example`. The app is testnet only.

`NEXT_PUBLIC_HYPERION_API_URL` supplies transfer activity and destination verification. The backend must run its indexer and rail pollers regularly. The public testnet uses a five-minute GitHub Actions schedule, subject to runner queueing; destination Activity can take several minutes to update. Unreachable history is shown explicitly. A confirmed Stellar transaction proves source execution; destination delivery requires matching confirmed bridge and token-payment events.

Next serves `/api/relay-fee` for Axelar's live ITS estimate and `/api/cctp-fee` for Circle's finalized forwarding estimate. Static export cannot serve these endpoints. There are no fixed relay prices, generated transaction hashes, sample claims or fabricated history.

Relay budgets include 10% headroom over the live estimate. The Axelar XLM budget is paid in full; the Circle receive minimum accounts for the full USDC forwarding budget. A refreshed estimate must fit inside the displayed budget before signing. Transient read failures receive one bounded retry; signed transactions are never retried automatically.

Hyperion charges 30 basis points (0.3%) on the bridged USDC amount. The source transaction sends that protocol fee to the router's configured Stellar treasury. Bridge forwarding, relay and network fees are separate and shown before signing.

Claim recovery reads `get_claim` and signs `settle_claim` on the Stellar router. It pays the recorded recipient. A claim exists only when a destination router has parked funds for recovery; completed transfers have no claim number. Activity displays genuine claim numbers and settlement status, while transfer details explain when no claim exists. A delayed outbound transfer does not automatically become a Stellar claim.

## Deploy

The production alias is [stellarhyperion.vercel.app](https://stellarhyperion.vercel.app/), attached to the Vercel project `hyperion`. Set `NEXT_PUBLIC_HYPERION_API_URL=https://stellarhyperion-backend.vercel.app` in its production environment, then deploy from this repository with `vercel deploy --prod`. The app requires a Next.js server for its live bridge-fee API routes.

The backend uses a server-side PostgreSQL connection and a scheduled indexer. Database credentials and signing keys must never be included in `NEXT_PUBLIC_` variables. The checked-in deployment is testnet only. See the backend README for the scheduled indexer, optional continuous container and database configuration.

Vercel's installed Git integration publishes `main` after pushes. GitHub Actions runs quality checks; the legacy token-based deployment jobs were removed to avoid duplicate deployments and expired deployment credentials.

## Verification

`npm run check` runs formatting, interface rules, contrast checks, unit tests, lint, types and the production build. Start the app and run `npm run test:browser` for the real wallet picker, theme persistence, native selectors and mobile layout. Chromium must be installed with `npx playwright install chromium`.

Set `HYPERION_BROWSER=firefox` to check Firefox, or `HYPERION_BROWSER_EXECUTABLE` to use a specific installed browser executable.

Live transaction tests require explicit opt-in and real named CLI wallets. `test/live-transfer.test.ts` retains the original ITS acceptance. `test/live-routes.test.ts` verifies conversion or CCTP through actual destination payment, preserving its proof file across interrupted runs. Normal tests skip both live suites.

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
