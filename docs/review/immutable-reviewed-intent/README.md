# Immutable reviewed transfer intent

The review binds the account, network, router, issuer-qualified source token, destination, recipient, exact source debit, protocol fee, minimum received, provider budgets and adapter. Conversion spending and output are copied before asynchronous preflight reads. Later edits require another explicit review.

The browser fixture mounts the production Bridge and Providers and exercises quote fetching, contract simulation, review, wallet signing, signature verification, transaction preparation and durable checkpoints. Only RPC, Horizon, EVM, provider and Freighter transports are mocked, using a synthetic unfunded local signer. It does not broadcast or pay on an external network.

The regression holds a wallet signature while a synthetic background input event changes the recipient through the production React handler. The native dialog normally prevents ordinary background interaction. After signing, the original hash and issuer-qualified intent remain recoverable, the superseded transfer is not submitted, and reloading does not automatically sign or send. Desktop and mobile review, the mobile fee disclosure and superseded recovery are captured below. Mobile overflow checks passed.

- [Desktop review](review-desktop.png)
- [Mobile review](review-mobile.png)
- [Mobile exact fee disclosure](review-mobile-fees.png)
- [Superseded signed transfer](superseded-mobile.png)

[source-evidence.json](source-evidence.json) records SHA-256 fingerprints of the production sources exercised by the fixture. The final tuple typing change affects a test only and preserves these fingerprints. The focused regression suite passed 187 tests with one separately funded live test skipped. All seven final local checks passed on Node 22: formatting, house rules, contrast, the complete test suite, strict lint, typecheck and production build. Funded live suites were disabled. [validation.json](validation.json) records the exact validated source commit, lock fingerprint and commands.
