import { describe, expect, it } from "vitest";
import { cctpMinimumReceived, relayBudget } from "../src/lib/relay-budget";

describe("relay budgets", () => {
  it("keeps Circle's conservative forwarding deduction in exact units", () => {
    expect(cctpMinimumReceived(1_000_000n, relayBudget(12_345n) * 10n)).toBe(986_420n);
  });

  it("rejects precision dust and budgets that consume the payout", () => {
    expect(() => cctpMinimumReceived(1_000n, 11n)).toThrow("invalid precision");
    expect(() => cctpMinimumReceived(1_000n, 10_000n)).toThrow("Increase the amount");
  });
});
