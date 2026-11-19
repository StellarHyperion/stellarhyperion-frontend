import { describe, expect, it } from "vitest";
import { conversionPathIssue } from "../src/contracts/assets";

describe("conversion diagnostics", () => {
  it("distinguishes liquidity, malformed, unsupported, and temporary failures", () => {
    expect(conversionPathIssue(new Error("No liquid XLM path is available."))).toBe("no-liquidity");
    expect(conversionPathIssue(new Error("Invalid Stellar path asset."))).toBe("malformed-path");
    expect(conversionPathIssue(new Error("Trustline is frozen by the issuer."))).toBe("unsupported");
    expect(conversionPathIssue(new Error("Horizon is unavailable."))).toBe("temporary");
  });
});
