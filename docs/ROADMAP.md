# Testnet implementation status

Implemented: Stellar wallet connection, live contract capability checks, exact USDC amounts, router quotes, Axelar relay-gas estimates, transaction simulation/signing/submission, real source status, strict indexer history and on-chain parked-claim recovery.

Claim settlement recovery now records the signed transaction before broadcast, preserves unresolved
claim hashes across navigation, and reports preparation, signing, broadcast, pending, and confirmed
states. Amount diagnostics retain the user's exact text and are linked to the input for screen
readers, so invalid precision or range never silently changes a wallet review.

The current wallet-owned router/adapter deployment is active, with confirmed USDC mapping and a Sepolia link. The normal one-hour router timelock was observed. See the contracts repository's `docs/TESTNET_ACTIVATION.md`.

A live acceptance transfer uses the actual application helpers and a real wallet signature. Current source/destination verification evidence is recorded in the contracts repository; browser and unit checks alone do not establish cross-chain delivery.

Additional networks and rails require independently verified contract support, token representations, funding and event tracking before entering the UI. EVM wallet execution, four-rail price comparisons, gas top-ups and rail second-step automation are not available in this app.
