import { describe, expect, it } from "vitest";
import { compareQuotes } from "../src/lib/quote-diff";

const circle = {
  route: 0,
  destination: "sepolia",
  adapter: "circle",
  requestedAmount: 10_000_000n,
  grossAmount: 10_000_000n,
  fee: 30_000n,
  destinationAmount: 987_000n,
  relayGas: 100_000n,
  estimatedRelayGas: 90_000n,
  ledger: 100,
};

describe("Actual delivered minimum in refreshed quote comparison", () => {
  it("compares the already-net Circle receive minimum without deducting the budget twice", () => {
    const diff = compareQuotes(
      circle,
      { ...circle, destinationAmount: 986_999n, relayGas: 100_010n, ledger: 101 },
      { displayDecimals: 2 },
    );
    const minimum = diff.fields.find((field) => field.key === "minimum");
    expect(minimum).toMatchObject({
      reviewed: 987_000n,
      refreshed: 986_999n,
      delta: -1n,
      direction: "worse",
      material: true,
    });
    expect(minimum?.reviewedDisplay).toBe(minimum?.refreshedDisplay);
    expect(diff.materialWorsening).toBe(true);
  });

  it("reports lower Circle cost as improved payout while preserving both exact inputs", () => {
    const reviewed = Object.freeze({ ...circle });
    const refreshed = Object.freeze({
      ...circle,
      destinationAmount: 987_001n,
      relayGas: 99_990n,
      estimatedRelayGas: 89_990n,
    });
    const diff = compareQuotes(reviewed, refreshed);
    expect(diff.fields.find((field) => field.key === "minimum")).toMatchObject({
      reviewed: 987_000n,
      refreshed: 987_001n,
      delta: 1n,
      direction: "better",
    });
    expect(diff.materialWorsening).toBe(false);
    expect(diff.improved).toBe(true);
    expect(reviewed.relayGas).toBe(100_000n);
    expect(refreshed.relayGas).toBe(99_990n);
  });

  it("does not subtract integers or assign improvement across different rail precisions", () => {
    const diff = compareQuotes(circle, {
      ...circle,
      route: 1,
      adapter: "its",
      destinationAmount: 9_970_000n,
    });
    expect(diff.fields.find((field) => field.key === "minimum")).toMatchObject({
      delta: null,
      direction: "changed",
      material: true,
      reviewedDisplay: "0.987 USDC",
      refreshedDisplay: "0.997 USDC (ITS)",
    });
    expect(diff.materialWorsening).toBe(true);
    expect(diff.improved).toBe(false);
  });

  it("does not invent a payout change when only an informational estimate improves", () => {
    const diff = compareQuotes(circle, { ...circle, estimatedRelayGas: 89_999n });
    expect(diff.fields.map((field) => field.key)).toEqual(["estimatedProviderBudget"]);
    expect(diff.materialWorsening).toBe(false);
    expect(diff.improved).toBe(true);
  });
});
