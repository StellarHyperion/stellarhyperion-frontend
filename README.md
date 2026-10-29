# Hyperion frontend

[Open Hyperion](https://stellarhyperion.vercel.app/) | [Backend](https://github.com/StellarHyperion/stellarhyperion-backend) | [Contracts and deployment evidence](https://github.com/StellarHyperion/stellarhyperion-contracts)

A focused bridge interface for Stellar wallets, real quotes and verified destination payments. The app uses a compact send/receive composer, native token and destination pickers, explicit quote loading, a review before signing and recoverable transaction progress.

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

Connect a Stellar wallet configured for Testnet. Users need testnet XLM for reserves and network fees, plus Axelar relay gas when using ITS. The setup disclosure links to the XLM and Circle testnet faucets. Testnet assets have no cash value.

## Configuration and tracking

The checked-in deployment supplies the default router and canonical USDC asset. Public overrides are documented in `.env.example`. The app is testnet only.

`NEXT_PUBLIC_HYPERION_API_URL` supplies transfer activity and destination verification. The backend must run its persistent indexer and rail pollers. Unreachable history is shown explicitly. A confirmed Stellar transaction proves source execution; destination delivery requires matching confirmed bridge and token-payment events.

Next serves `/api/relay-fee` for Axelar's live ITS estimate and `/api/cctp-fee` for Circle's finalized forwarding estimate. Static export cannot serve these endpoints. There are no fixed relay prices, generated transaction hashes, sample claims or fabricated history.

Relay budgets include 10% headroom over the live estimate. The Axelar XLM budget is paid in full; the Circle receive minimum accounts for the full USDC forwarding budget. A refreshed estimate must fit inside the displayed budget before signing. Transient read failures receive one bounded retry; signed transactions are never retried automatically.

Hyperion charges 30 basis points (0.3%) on the bridged USDC amount. The source transaction sends that protocol fee to the router's configured Stellar treasury. Bridge forwarding, relay and network fees are separate and shown before signing.

Claim recovery reads `get_claim` and signs `settle_claim` on the Stellar router. It pays the recorded recipient. A claim exists only when a destination router has parked funds for recovery; completed transfers have no claim number. Activity displays genuine claim numbers and settlement status, while transfer details explain when no claim exists. A delayed outbound transfer does not automatically become a Stellar claim.

## Deploy

The production alias is [stellarhyperion.vercel.app](https://stellarhyperion.vercel.app/), attached to the Vercel project `hyperion`. Set `NEXT_PUBLIC_HYPERION_API_URL=https://stellarhyperion-backend.vercel.app` in its production environment, then deploy from this repository with `vercel deploy --prod`. The app requires a Next.js server for its live bridge-fee API routes.

The backend uses a server-side PostgreSQL connection and a continuously running indexer. Database credentials and signing keys must never be included in `NEXT_PUBLIC_` variables. The checked-in deployment is testnet only. See the backend README for the persistent worker and database configuration.

## Verification

`npm run check` runs formatting, interface rules, contrast checks, unit tests, lint, types and the production build. Start the app and run `npm run test:browser` for the real wallet picker, theme persistence, native selectors and mobile layout. Chromium must be installed with `npx playwright install chromium`.

Set `HYPERION_BROWSER=firefox` to check Firefox, or `HYPERION_BROWSER_EXECUTABLE` to use a specific installed browser executable.

Live transaction tests require explicit opt-in and real named CLI wallets. `test/live-transfer.test.ts` retains the original ITS acceptance. `test/live-routes.test.ts` verifies conversion or CCTP through actual destination payment, preserving its proof file across interrupted runs. Normal tests skip both live suites.

For the route suite, set `HYPERION_LIVE_ROUTES=1`, `HYPERION_ROUTE_MODE=convert` or `cctp`, `HYPERION_ROUTE_IDENTITY`, `HYPERION_ROUTE_PROOF`, `HYPERION_ROUTE_DESTINATION`, `HYPERION_TESTNET_APP_URL`, `HYPERION_TESTNET_RECIPIENT` and `NEXT_PUBLIC_HYPERION_API_URL`. Conversion spends at most 1 testnet XLM plus fees; CCTP spends 0.3 testnet USDC. Never delete a pending proof to retry a transfer.

Real signed acceptance includes native XLM conversion followed by an ITS payout and CCTP native-USDC payouts on all three destination testnets. Public source/destination hashes, observed amounts and confirmation evidence are retained in the contracts repository under `deployments/evidence/2026-10-29-conversion.json` and `deployments/evidence/2026-10-29-cctp.json`.

## Interface

The layout study used [Jumper](https://jumper.xyz/), [Relay](https://relay.link/bridge) and [Stargate](https://stargate.finance/) as reference points for focused asset selection and progressive route details. Hyperion adds explicit receive-token identity, quote request feedback, review and interruption recovery. Decorative orbital paths provide background motion without implying that funds are moving. One theme button switches between light and dark; all motion honors reduced-motion preferences.

MIT.
