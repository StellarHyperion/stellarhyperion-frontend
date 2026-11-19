import { describe, expect, it, vi } from "vitest";
import { assertPublicConfiguration, publicEndpoint } from "../src/config/public-boundary";
import { parseAxelarFee, parseCircleFee } from "../src/lib/fee-schema";

describe("runtime configuration and fee schemas", () => {
  it("rejects credentials at the public boundary", () => {
    expect(() => assertPublicConfiguration({ NEXT_PUBLIC_API_TOKEN: "hidden" })).toThrow();
    expect(() => assertPublicConfiguration({ NEXT_PUBLIC_RPC_URL: "ghp_not-a-token" })).toThrow();
    expect(publicEndpoint("NEXT_PUBLIC_RPC_URL", "https://rpc.example")).toBe(
      "https://rpc.example",
    );
  });
  it("fails closed for unknown provider schemas", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseAxelarFee({ result: "100" })).toBeNull();
    expect(parseCircleFee([{ finalityThreshold: 1000 }])).toBeNull();
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
  it("preserves valid integer provider estimates", () => {
    expect(parseAxelarFee('"100"')).toBe(100n);
    expect(
      parseCircleFee([{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 7 } }]),
    ).toBe(7n);
  });
});
