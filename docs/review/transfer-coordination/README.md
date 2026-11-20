# Transfer coordination and destination amounts

Chromium 158.0.8127.18 opened two real tabs on the same fixture origin. The harness imports the production Web Lock lease, checkpoint store, transaction submission and signature verifier; generated local keys sign a Testnet payment and the RPC boundary records an uncertain outcome without external submission. The first tab held ownership through signing and checkpoint persistence. The second tab was rejected, exactly one transaction reached the mocked RPC, and its public hash survived the owner tab closing. A further transfer was refused while that signed checkpoint remained unresolved.

The actual TransferList rendered three generated destination-payment records: CCTP with six decimals, ITS with seven decimals and an ITS token with unknown precision. They show exact received amounts and raw token identity; unknown precision stays in base units. Desktop/mobile captures were inspected, with no runtime errors or horizontal overflow. Source hashes are in source-evidence.json. The Bridge source hash records the integrated lease call site; the harness drives production coordination and submission directly rather than the full Bridge UI.

Deterministic submission regressions separately verify that a changed claim recipient, token or amount is refused before wallet approval. Live signing suites remain disabled.
