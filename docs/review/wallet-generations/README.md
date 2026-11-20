# Wallet connection generations

The desktop and mobile captures show the actual wallet provider and account details after a delayed silent Freighter restore returns behind a newer explicit account connection. The newer account remains active.

Chromium 158.0.8127.18 drove the production provider, wallet button, SDK and signature verifier in an isolated browser fixture. Only Freighter transport responses were mocked. The fixture used newly generated local Stellar keys and an encoded Testnet transaction; nothing was submitted.

Six scenarios passed: delayed silent restoration, picker cancellation followed by a newer connection, disconnect during silent restoration, disconnect during explicit authorization, an old signature returning after account change, and provider unmount during authorization. Pending checkpoint storage remained intact and there were no browser runtime errors. The fixture menu uses the same placement as the application header.

Deterministic generation, SDK, signature and submission regressions also run through `npm run check`. Live signing suites remain opt-in.

The current Next production build also passed explicit wallet selection, Escape cancellation with immediate reconnect availability, saved-preference clearing without checkpoint loss, generated signed-hash retention after reload and mobile overflow checks. RPC/Horizon outage responses were isolated fixtures. No automatic network submission occurred. The additional picker captures come from that production build.

The final Node 22 pipeline passed all seven stages with 272 deterministic tests and two opt-in live suites skipped. Chromium 158 refreshed the production picker at desktop and mobile widths: explicit opening, Escape cancellation and restored controls, saved-preference clearing and signed-hash reload all passed without errors or automatic submission. The current picker captures were visually inspected.
