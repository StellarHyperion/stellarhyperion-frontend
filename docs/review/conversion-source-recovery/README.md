# Conversion source recovery

Chromium 158.0.8127.18 drove the complete production Bridge, SourceAssetPicker, Stellar provider and checkpoint store in a small Vite fixture. Next navigation links were rendered as anchors; RPC and Horizon reads were mocked. Generated local keys supplied an independently encoded Stellar conversion envelope and success/failure result. No wallet approval or network submission occurred.

The browser changed XLM to USDC while a saved conversion remained pending. Its original account, exact amount, source identity and signed hash stayed unchanged, the recovery card retained the original source asset, and no new conversion or bridge ran. Confirmed, failed and unknown read responses, explicit reconnect guidance, repeated-click locking and discarded late account responses also passed. Desktop and mobile captures were inspected for overflow and recovery copy. Source hashes are recorded.
