# Accessible review checks and asynchronous actions

A bounded summary links to the exact invalid amount or destination field, or to the current balance, fee or recovery explanation. Links move focus only after explicit activation and preserve the current URL and entered values. Recipient errors never mark a valid amount as invalid. Disabled review, refresh and balance controls reference readable guidance; successful quote and balance reads explicitly say that no transaction has been submitted. Rapid refresh activation admits one current request, and pending recovery controls expose their existing read-only status.

The current production Bridge, Providers and wallet SDK browser passed exact invalid-field association, explicit focus without URL mutation, preserved input, no focus jump when a delayed quote fails, a single request after three rapid refresh activations, readable retry and read-success semantics, keyboard review and preservation of the original signed checkpoint through three rapid recovery activations. It used transport-only mocks and one held synthetic unfunded signature. The recovery read remained unknown; it did not confirm or broadcast a transaction. Desktop and mobile captures were inspected, links meet 44px targets and mobile content stays within the viewport.

- [Desktop quote failure summary](summary-desktop.png)
- [Mobile quote failure summary](summary-mobile.png)
- [Mobile saved recovery](recovery-mobile.png)

[source-evidence.json](source-evidence.json) records current production-source fingerprints. All seven supported Node 22 commands passed on cumulative sourced4ac343f: formatting, house rules, contrast, 509 deterministic tests/four funded skips, strict lint, typecheck and the production Turbopack build. Actual emitted client bundle checks passed with wallet119262/450000 and transaction1098386/1200000 bytes. The refreshed browser includes the final preceding cooldown implementation and waits for its explicit retry boundary.
