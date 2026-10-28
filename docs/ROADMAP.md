# Testnet implementation status

Implemented: Stellar wallet connection, live contract capability checks, exact USDC amounts, router quotes, Axelar relay-gas estimates, transaction simulation/signing/submission, real source status, strict indexer history and on-chain parked-claim recovery.

Activation is pending: deploy the paid-transfer contract upgrade, map the Stellar USDC ITS token and link Ethereum Sepolia. The existing deployment refuses sends until these checks pass. See the contracts repository's `docs/TESTNET_ACTIVATION.md`.

Verification still required after activation: a real wallet transfer, confirmed destination token payment and a restarted indexer recording that payment. Browser and unit checks alone do not establish cross-chain delivery.

Additional networks and rails require independently verified contract support, token representations, funding and event tracking before entering the UI. EVM wallet execution, four-rail price comparisons, gas top-ups and rail second-step automation are not available in this app.
