import { describe, expect, it } from "vitest";
import { validateProviderFee } from "../src/lib/fee-schema";

describe("provider fee response schema", () => {
  const valid = {
    amount: "1100",
    estimatedAmount: "1000",
    token: "XLM",
    decimals: 7,
    destination: "ethereum-sepolia",
  };

  it("accepts bounded exact integer fixtures", () => {
    expect(validateProviderFee(valid, { token: "XLM", destination: "ethereum-sepolia" })).toEqual(
      valid,
    );
  });

  it.each([
    { token: "USDC" },
    { destination: "base-sepolia" },
    { amount: "1.2" },
    { estimatedAmount: "1200" },
    { decimals: 6 },
  ])("rejects incompatible fee metadata: %j", (change) => {
    expect(() =>
      validateProviderFee(
        { ...valid, ...change },
        { token: "XLM", destination: "ethereum-sepolia" },
      ),
    ).toThrow("schema validation");
  });
});
