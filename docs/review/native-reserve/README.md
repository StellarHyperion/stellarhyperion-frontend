# Native XLM spending constraints

Chromium 158.0.8127.18 drove the production accountAssets loader and SourceAssetPicker with generated local Horizon account and ledger responses. Ten XLM minus two XLM selling liabilities, three XLM minimum reserve and a two-operation fee margin yielded exactly 4.9999800 spendable XLM. The captures show this separate from the total balance.

A fully sponsored account correctly had zero minimum reserve. A malformed base reserve preserved an unknown fee gate and zero usable balance. Desktop and mobile had no horizontal overflow or runtime errors, and no wallet or transaction submission occurred. The fee and reserve values are fixture inputs, not live network observations.

All seven check stages passed on supported Node 22: 307 deterministic tests passed, two opt-in live suites skipped, and strict lint, type checking and production build passed.
