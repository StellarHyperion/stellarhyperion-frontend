# Wallet interruption verification

The production screenshots show desktop and mobile recovery of a saved signed transaction hash after reload, with external requests deliberately unavailable. They establish interface behavior and checkpoint retention; they do not establish live source confirmation or destination delivery.

The pending screenshots come from an isolated build of the actual wallet provider, wallet button, adapters and cryptographic signature verifier with a mock Freighter boundary. Chromium 158.0.8127.18 and fixture mock-freighter/2.0 exercised cancellation, late response rejection, a fresh valid locally signed approval, rejection of an unsigned echo, and extension loss. No network transaction was submitted. Recovery controls have a minimum height of 44px.

Validation used Node 22.22.1: 256 deterministic tests passed, with two live suites disabled; formatting, house rules, contrast, lint, type checking and the production build passed. The screenshots were visually inspected at desktop and 390px mobile sizes. The mock fixture verifies interruption behavior independently from the production screenshots.

Chromium 158.0.8127.18 refreshed the final production build: opening the picker, Escape cancellation and restored controls, saved preference clearing, retaining the owned signed hash across reload and mobile overflow all passed without errors or submission. Picker captures show the current production controls. Source and dependencies are identical to the fully validated head; subsequent commits add inspected evidence and preserving merge ancestry only.
