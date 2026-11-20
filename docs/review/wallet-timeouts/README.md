# Bounded wallet requests

Chromium 158.0.8127.18 drove the actual provider, wallet button, SDK and cryptographic signature verifier with mocked Freighter transport. Playwright advanced the production timers, rather than replacing the timeout implementation. All keys and the Testnet envelope were generated locally; nothing was submitted.

An eight-second availability timeout prevented a later extension response from starting an account prompt. A twenty-second account timeout freed the wallet choice for an explicit retry and discarded the old address. A 120-second signing timeout released the loading control, retained the unknown-outcome warning and discarded a late valid signature without making another signing request. Cancelling an older account request could not change a newer connection when the old deadline elapsed.

The six connection-generation browser cases also passed against this source, including account changes, disconnect and unmount. Pending checkpoint storage remained intact and no browser runtime errors occurred. Screenshots show the account-timeout retry affordance at desktop and mobile widths and the signing uncertainty warning.

Deterministic SDK tests separately verify timer cleanup, preflight cancellation and xBull connection disposal. Live signing suites remain opt-in.

The final Node 22 pipeline passed 283 deterministic tests, with two live suites skipped, strict lint/types and production build. Chromium 158 also refreshed the final production picker, Escape dismissal, restored controls and retained signed-hash reload at desktop/mobile widths; the current captures were inspected.

The subsequent cancellation error normalization passed 116 focused SDK/signature/submission regressions. The exact final timeout helper hash also matches the independently verified Chromium 158 and Firefox 159 wallet compatibility runs. This reuse covers the timeout helper only, as recorded in timeout-source-reuse.json; the original four provider/timer cases above remain separate evidence.
