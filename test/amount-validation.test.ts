import { describe, expect, it } from "vitest";
import { validateAmount } from "../src/lib/amount-validation";

describe("validateAmount", () => {
  it("keeps exact integer units without normalizing the input", () => {
    expect(validateAmount("1.0000001")).toEqual({ valid: true, units: 10000001n });
  });
  it("reports precision and empty-input errors", () => {
    expect(validateAmount("1.00000001")).toMatchObject({ valid: false });
    expect(validateAmount("")).toEqual({ valid: false, message: "Enter an amount to send." });
  });
  it("rejects zero and values beyond the Stellar asset limit", () => {
    expect(validateAmount("0")).toEqual({
      valid: false,
      message: "Enter an amount greater than zero.",
    });
    expect(validateAmount("922337203685.4775808")).toEqual({
      valid: false,
      message: "Amount exceeds Stellar's asset limit.",
    });
  });
});
