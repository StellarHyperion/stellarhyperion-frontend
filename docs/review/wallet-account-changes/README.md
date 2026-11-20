# Wallet account changes

Chromium 158.0.8127.18 drove the actual provider, wallet button and SDK with mocked Freighter transport and locally generated Stellar keys. No transaction was submitted.

Four cases passed: a window focus check rejected a changed account without silently adopting it; the five-second poll detected a removed extension; a visibility check abandoned an old signing request and discarded its later valid signature; and an old silent account query could not invalidate a newer explicit connection. Each case retained pending checkpoint storage, produced no runtime errors and stayed within the viewport.

The screenshots show the account-change warning and explicit reconnect control on desktop and mobile. The production recovery card separately retains the full account that owns a saved operation. Silent checks never ask popup wallets for authorization.

The final integrated source 09c3206147a7dd1981fcc7f84421366e7516b2c0 passed all seven supported Node22 commands: formatting, house, contrast, 469 deterministic tests with four opt-in funded live skips, strict lint, typecheck and production build. [validation.json](validation.json) records the exact source, lock and commands. Subsequent integrations change review evidence only.

A second browser compiles the complete production Bridge, Providers, quote, contract simulation, intent, submission, checkpoint, wallet SDK and signature verifier. With transport-only mocks and a synthetic unfunded local signer, it verifies review invalidation, saves the original signed hash without sending a superseded operation, detects a changed wallet account, explicitly reconnects the new account and retains the entire old-account checkpoint unchanged. The real recovery card displays the full owning account and requests the original account on desktop and mobile; reload never signs or sends automatically. No external broadcast or payment occurred. Both new captures were inspected.

- [Account warning desktop](account-changed-desktop.png)
- [Account warning mobile](account-changed-mobile.png)
- [Recoverable owner desktop](checkpoint-owner-desktop.png)
- [Recoverable owner mobile](checkpoint-owner-mobile.png)

[source-evidence.json](source-evidence.json) records the eleven current complete-Bridge fingerprints. [provider-evidence.json](provider-evidence.json) records the actual wallet-only fixture sources and scope. [validation-reuse.json](validation-reuse.json) records evidence-only integration after full validation.
