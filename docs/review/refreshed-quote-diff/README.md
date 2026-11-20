# Refreshed quote field differences

The composer compares exact protocol fees, the receive minimum, approved and estimated provider budgets, route, destination and adapter with the frozen reviewed quote. Worsening requires another explicit review. Improvements are displayed while the transaction keeps the reviewed minimum and budget. Circle's minimum is already net of its full forwarding budget; the comparison does not deduct that budget again. Different rails retain their own precision and currency.

The browser fixture mounts the production Bridge and Providers and exercises supported ITS and CCTP quote refresh, configuration reads, contract simulation, review, wallet signing, signature verification, transaction preparation and durable recovery. RPC, Horizon, EVM, provider and Freighter transports are mocked with a synthetic unfunded signer. No external transaction or payment is broadcast.

For both rails, a larger provider budget blocks the wallet callback and shows the exact differences. A new explicit review then approves that budget. When the subsequent quote improves, the actual signed operation still contains the reviewed minimum and approved budget. The fixture verifies those exact transaction arguments and the saved signed hash. Lost acknowledgement preserves recovery; reloading never automatically signs or sends. All six captures were inspected and mobile overflow checks passed.

| Rail | Worsening on desktop                  | Worsening on mobile                 | Improvement during approval           |
| ---- | ------------------------------------- | ----------------------------------- | ------------------------------------- |
| ITS  | [Desktop](its-worsening-desktop.png)  | [Mobile](its-worsening-mobile.png)  | [Mobile](its-improvement-mobile.png)  |
| CCTP | [Desktop](cctp-worsening-desktop.png) | [Mobile](cctp-worsening-mobile.png) | [Mobile](cctp-improvement-mobile.png) |

The focused suite passed 111 tests. All seven local checks passed, including 479 tests with four funded live suites disabled. The final cumulative account-change safeguards and inherited CSS passed all seven checks and a rebuilt complete browser fixture. [validation.json](validation.json), [validation-reuse.json](validation-reuse.json) and [source-evidence.json](source-evidence.json) record the tested commits and matching production-source fingerprints.
