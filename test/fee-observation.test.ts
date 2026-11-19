import { describe, expect, it } from "vitest";
import { feeObservation, isFreshFeeObservation } from "../src/lib/relay-budget";

describe("fee observations", () => {
  it("bounds validity to a short explicit window", () => {
    const observation = feeObservation(1_000_000);
    expect(observation.observedAt).toBe("1970-01-01T00:16:40.000Z");
    expect(isFreshFeeObservation(observation.validUntil, 1_000_000)).toBe(true);
    expect(isFreshFeeObservation(observation.validUntil, 1_030_001)).toBe(false);
  });
});
