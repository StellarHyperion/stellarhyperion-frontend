# Public token identifier scan

The acceptance proof tests use the public Sepolia ITS ERC20 address `0xFd5a146686d16060ef9c595B37C30b248402304c`. The protocol repository records it as the destination token in `deployments/evidence/2026-10-28-paid-its.json` and `deployments/evidence/2026-10-29-conversion.json`. It identifies the asset paid by the deployed protocol and provides no authentication capability.

Gitleaks classifies three historical `token` or `destinationToken` assignments in `test/backend-api.test.ts` as generic API keys because of the field name and address entropy. The contribution scan keeps all default rules and scans the complete contributed Git history. Its sole public identifier exception requires all three conditions: the `generic-api-key` rule, this exact test path, and this exact case-sensitive address value. No commit, file, directory or secret rule is excluded from scanning, and repository `.gitleaksignore` files remain prohibited.

The real scanner regression checks the exact public case, the same value in another path, a newly generated API key in the acceptance path, and a GitHub key shape beside the public address. The latter three remain detected. Historical contributor commits remain preserved.
