import { describe, expect, it } from "vitest";
import { selectFinalizedCctpFee } from "../src/lib/cctp-fee";

describe("Circle finalized fee selection", () => {
  it("rejects conflicting finalized tiers instead of choosing a cheaper one", () => {
    const tier = { finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 7 } };
    expect(selectFinalizedCctpFee([tier, { ...tier, forwardFee: { med: 9 } }])).toBeNull();
  });
  it("keeps the exact six-decimal fee amount", () => {
    expect(
      selectFinalizedCctpFee([
        { finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 123456 } },
      ]),
    ).toEqual({ amount: 123456n, finality: 2000 });
  });
});
