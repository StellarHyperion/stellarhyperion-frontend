import { describe, expect, it } from "vitest";
import {
  feeObservation,
  isFreshFeeObservation,
  validateFeeObservation,
} from "../src/lib/relay-budget";
import { quoteFreshness } from "../src/contracts/stellar";

const now = Date.UTC(2026, 10, 20, 12);
const expected = { token: "XLM", destination: "ethereum-sepolia", route: 1 } as const;
const observation = (serverNow = now) => ({
  provider: "Axelar ITS",
  token: "XLM",
  decimals: 7,
  lane: { source: "stellar-testnet", destination: "ethereum-sepolia", route: 1 },
  ...feeObservation(serverNow),
});

describe("bounded, lane-bound provider observations", () => {
  it("preserves server provenance and shortens the local deadline by the full clock allowance", () => {
    const result = validateFeeObservation(observation(), expected, now);
    expect(result.observedAt).toBe("2026-11-20T12:00:00.000Z");
    expect(result.validUntil).toBe("2026-11-20T12:00:30.000Z");
    expect(result.clientValidUntil).toBe("2026-11-20T12:00:25.000Z");
    expect(isFreshFeeObservation(result, now + 24_999)).toBe(true);
    expect(isFreshFeeObservation(result, now + 25_000)).toBe(false);
    expect(
      quoteFreshness({ observedAt: result.receivedAt, feeObservation: result }, now + 25_000),
    ).toBe("stale");
    expect(Object.isFrozen(result.lane)).toBe(true);
  });
  it.each([-5_000, 0, 5_000])(
    "handles a bounded server clock offset of %i ms conservatively",
    (offset) => {
      const result = validateFeeObservation(observation(now + offset), expected, now);
      expect(Date.parse(result.clientValidUntil)).toBeLessThanOrEqual(now + offset + 25_000);
      expect(isFreshFeeObservation(result, now)).toBe(true);
    },
  );
  it.each([
    { observedAt: "2026-11-20T11:59:54.999Z", validUntil: "2026-11-20T12:00:24.999Z" },
    { observedAt: "2026-11-20T12:00:05.001Z", validUntil: "2026-11-20T12:00:35.001Z" },
    { observedAt: "2026-11-20T11:59:25.000Z", validUntil: "2026-11-20T11:59:55.000Z" },
    { validUntil: "2026-11-20T12:00:30.001Z" },
    { validUntil: "2026-11-20T12:00:00.000Z" },
    { observedAt: "not-a-date" },
    { observedAt: "2026-02-30T12:00:00.000Z" },
    { validUntil: undefined },
    { observedAt: "2026-11-20T12:00:00Z" },
  ])("rejects stale, unbounded or malformed provenance %j", (mutation) => {
    expect(() => validateFeeObservation({ ...observation(), ...mutation }, expected, now)).toThrow(
      /expired|clock/,
    );
  });
  it.each([
    { provider: "https://secret.example/api?key=private" },
    { token: "USDC" },
    { decimals: 6 },
    { lane: { source: "stellar-mainnet", destination: "ethereum-sepolia", route: 1 } },
    { lane: { source: "stellar-testnet", destination: "base-sepolia", route: 1 } },
    { lane: { source: "stellar-testnet", destination: "ethereum-sepolia", route: 0 } },
    { lane: undefined },
  ])("refuses provider, currency and lane substitution %j", (mutation) => {
    expect(() => validateFeeObservation({ ...observation(), ...mutation }, expected, now)).toThrow(
      /match/,
    );
  });
  it("does not revive an observation if the local clock moves backwards", () => {
    expect(
      isFreshFeeObservation(validateFeeObservation(observation(), expected, now), now - 1),
    ).toBe(false);
  });
});
