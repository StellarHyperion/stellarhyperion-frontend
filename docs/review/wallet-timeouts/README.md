# Bounded wallet requests

Chromium 158.0.8127.18 drove the actual provider, wallet button, SDK and cryptographic signature verifier with mocked Freighter transport. Playwright advanced the production timers, rather than replacing the timeout implementation. All keys and the Testnet envelope were generated locally; nothing was submitted.

An eight-second availability timeout prevented a later extension response from starting an account prompt. A twenty-second account timeout freed the wallet choice for an explicit retry and discarded the old address. A 120-second signing timeout released the loading control, retained the unknown-outcome warning and discarded a late valid signature without making another signing request. Cancelling an older account request could not change a newer connection when the old deadline elapsed.

The six connection-generation browser cases also passed against this source, including account changes, disconnect and unmount. Pending checkpoint storage remained intact and no browser runtime errors occurred. Screenshots show the account-timeout retry affordance at desktop and mobile widths and the signing uncertainty warning.

Deterministic SDK tests separately verify timer cleanup, preflight cancellation and xBull connection disposal. Live signing suites remain opt-in.
