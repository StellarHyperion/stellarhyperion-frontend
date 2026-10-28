# Hyperion testnet app

A Stellar wallet interface for real contract quotes, signed transfers, transaction status and parked-claim recovery. The current interface supports Stellar Testnet USDC to Ethereum Sepolia through Axelar ITS. The received token is the seven-decimal ITS representation of Stellar USDC, **not Circle's native Sepolia USDC**.

The app checks the deployed router, adapter, token mapping, destination token and relay-gas support before enabling a transfer. The deployment record alone does not establish a usable lane. The existing deployment requires the paid-transfer router/adapter upgrade and Sepolia link/token mapping; until those operations are confirmed, sending stays disabled.

## Run

Use Node 22.13 or newer (the pinned version is in `.nvmrc`).

```bash
npm ci
cp .env.example .env.local
npm run dev
```

The shared protocol package is a committed, versioned tarball. No sibling checkout is required. `npm run check` runs formatting, design rules, contrast, unit tests, lint, type checking and a production build.

## Wallet and transfer behavior

Freighter, xBull, Albedo and Lobstr are available through Stellar Wallets Kit. Select Stellar Testnet in your wallet. Fund your account with testnet XLM and the configured testnet USDC asset; testnet assets have no monetary value. The asset code, issuer and SAC address are in `src/config/testnet-deployment.json`.

Amounts use exact seven-decimal integers. Quotes come from the deployed router and relay-gas estimates from Axelar's testnet API. The signature includes the USDC transfer, protocol fee and XLM relay gas. The wallet also pays Stellar network fees. The app rechecks the quote, account, network and balance before submission and verifies the signed transaction matches the prepared transaction.

A confirmed Stellar transaction establishes source execution. Destination delivery requires a matching confirmed ITS event and token payment, verified by the backend. Unknown submission outcomes retain the real transaction hash; check its outcome before retrying. There are no generated transaction hashes, sample claims, offline transfer fixtures or fixed relay-price estimates.

Claim recovery reads `get_claim` directly from the Stellar router and signs `settle_claim`. It cannot recover assets that were never dispatched or bypass a destination trustline requirement.

## Configuration

The browser RPC/router/USDC settings default to the checked-in testnet deployment. Public overrides are documented in `.env.example`. This app is testnet only.

`NEXT_PUBLIC_HYPERION_API_URL` is optional for signing and direct claim lookup, and required for transfer history and destination verification. The backend must run its indexer and rail poller. An absent or unreachable backend is shown explicitly; no fabricated history appears. The Next server exposes `/api/relay-fee` to fetch Axelar's live ITS gas estimate. Static export cannot serve this endpoint.

For a read-only browser smoke check, install Chromium with `npx playwright install chromium`, start the development server on port 3100, then run `npm run test:browser`. No wallet signing is automated by this check.

Operator activation instructions are in the contracts repository at `docs/TESTNET_ACTIVATION.md`. Code validation does not prove a deployed upgrade or an end-to-end wallet transfer.

MIT.
