# Wallet connection generations

The desktop and mobile captures show the actual wallet provider and account details after a delayed silent Freighter restore returns behind a newer explicit account connection. The newer account remains active.

Chromium 158.0.8127.18 drove the production provider, wallet button, SDK and signature verifier in an isolated browser fixture. Only Freighter transport responses were mocked. The fixture used newly generated local Stellar keys and an encoded Testnet transaction; nothing was submitted.

Six scenarios passed: delayed silent restoration, picker cancellation followed by a newer connection, disconnect during silent restoration, disconnect during explicit authorization, an old signature returning after account change, and provider unmount during authorization. Pending checkpoint storage remained intact and there were no browser runtime errors. The fixture menu uses the same placement as the application header.

Deterministic generation, SDK, signature and submission regressions also run through `npm run check`. Live signing suites remain opt-in.
