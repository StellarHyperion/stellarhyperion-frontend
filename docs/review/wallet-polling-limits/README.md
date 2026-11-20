# Wallet recovery and polling verification

This review covers original PR #211 and issues #45, #135 and #149. It preserves the original contributor commits, validated transfer recovery work and the merged mobile review footer from PR #248.

The actual wallet provider, adapter logic, recovery component, wallet button, native dialog, transfer history and transaction detail components were compiled from the current source for Chromium 158.0.8127.18. The fixture supplies a mock Freighter transport and read-only indexer/RPC responses. Next links render as anchors. Document visibility transitions are synthesized in the browser; this is not a live signing, provider pricing or on-chain spending test.

Browser assertions verify denied access, missing extensions, blocked popups and unsupported network guidance; focus on the resulting status; Tab to retry; an explicit retry count; wallet selection focus; and returning focus to the opener after cancellation. The official installation link is only offered as an action. No failure opens an automatic popup or exposes arbitrary adapter details.

The actual transfer history immediately refreshes after a visibility transition, blocks pagination until that request settles, retains the public pending checkpoint and ignores late search results. The actual detail page keeps claim actions blocked while refreshing and after an indexer failure, retains the public source hash, and discards results from a previous transaction after navigation. Desktop and mobile captures were inspected and have no horizontal overflow. Mock claims and hashes in these captures are fixture data.

The deterministic suite verifies one timer and request owner, hidden minute budgets, coalesced foreground refreshes, cancellation and cleanup. Provider-route regressions verify shared concurrency admission despite forged forwarding headers, structured `429` retry guidance, exact fee units and destination binding, URL limits, bounded streamed response bodies and release after completed requests. These tests mock provider responses and do not establish live prices.

Source fingerprints and browser scope are recorded in [browser-evidence.json](browser-evidence.json). Captures:

- [Denied connection and safe details](denied-desktop.png)
- [Missing extension recovery on mobile](missing-mobile.png)
- [Failed status refresh with claim action blocked](failed-refresh-desktop.png)
- [Fresh transaction detail on mobile](fresh-detail-mobile.png)

Node 22 validation uses live signing suites disabled. The final source passed formatting, interface rules, contrast, 359 deterministic tests, strict lint and TypeScript. Production build verification is recorded separately in the handoff metadata. The Impeccable detector returned no findings for the changed recovery and transfer surfaces.
