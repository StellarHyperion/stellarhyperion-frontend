# Acceptance proof verification

The live runner requires genuine signed-source evidence and the exact destination payment receipt. It checks deployed route and token identity, exact integer amounts, recipient, signature and transaction result. Private proof files use an owner lock and atomic monotonic updates; read-only proof verification does not create transfers.

The full local pipeline passed on the acceptance implementation source with 367 deterministic tests and four opt-in live skips. Final preserving integrations retain these acceptance files unchanged and production source matches fully validated PR208. Fresh focused integration tests passed. See `validation-reuse.json` for the exact evidence sources. No funded live run or destination delivery is claimed.
