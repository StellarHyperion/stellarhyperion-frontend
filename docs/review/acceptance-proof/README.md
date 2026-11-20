# Acceptance proof verification

The live runner requires genuine signed-source evidence and the exact destination payment receipt. It checks deployed route and token identity, exact integer amounts, recipient, signature and transaction result. Private proof files use an owner lock and atomic monotonic updates; read-only proof verification does not create transfers.

The full local pipeline passed on the acceptance implementation source with 367 deterministic tests and four opt-in live skips. Final preserving integrations retain production source matching fully validated PR208. The current proof security repair reads and validates the same opened inode and rejects symlinks, shared-readable files and invalid saved proof shapes. Its 23 focused acceptance tests and full typecheck pass; the full current-source pipeline is pending. See `validation-reuse.json` for the exact evidence sources. No funded live run or destination delivery is claimed.
