# Wallet account changes

Chromium 158.0.8127.18 drove the actual provider, wallet button and SDK with mocked Freighter transport and locally generated Stellar keys. No transaction was submitted.

Four cases passed: a window focus check rejected a changed account without silently adopting it; the five-second poll detected a removed extension; a visibility check abandoned an old signing request and discarded its later valid signature; and an old silent account query could not invalidate a newer explicit connection. Each case retained pending checkpoint storage, produced no runtime errors and stayed within the viewport.

The screenshots show the account-change warning and explicit reconnect control on desktop and mobile. The production recovery card separately retains the full account that owns a saved operation. Silent checks never ask popup wallets for authorization.
