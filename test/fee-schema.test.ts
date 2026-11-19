import { afterEach, describe, expect, it, vi } from "vitest";
import { validateProviderFee } from "../src/lib/fee-schema";
import { GET as relayFee } from "../src/app/api/relay-fee/route";
import { GET as circleFee } from "../src/app/api/cctp-fee/route";
afterEach(() => vi.unstubAllGlobals());

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
    { amount: "0" },
    { amount: "9".repeat(100000) },
    { amount: String(1n << 127n) },
  ])("rejects incompatible fee metadata: %j", (change) => {
    expect(() =>
      validateProviderFee(
        { ...valid, ...change },
        { token: "XLM", destination: "ethereum-sepolia" },
      ),
    ).toThrow("schema validation");
  });
});

describe("live provider endpoint schema boundaries", () => {
  it("rejects Circle finality metadata on an Axelar signing budget", () => {
    expect(() =>
      validateProviderFee(
        {
          amount: "1100",
          estimatedAmount: "1000",
          token: "XLM",
          decimals: 7,
          destination: "ethereum-sepolia",
          finality: 2000,
        },
        { token: "XLM", destination: "ethereum-sepolia" },
      ),
    ).toThrow("Provider fee finality is invalid.");
  });
  it("rejects an oversized Axelar scalar with a bounded public error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('"' + "9".repeat(100000) + '"')));
    const response = await relayFee();
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error.length).toBeLessThan(120);
    expect(body).not.toHaveProperty("amount");
  });
  it("keeps finalized Circle estimates in exact Stellar units and the selected destination", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify([{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 101 } }]),
          ),
        ),
    );
    const response = await circleFee(
      new Request("http://localhost/api/cctp-fee?destination=base-sepolia"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      amount: "1120",
      estimatedAmount: "1010",
      token: "USDC",
      decimals: 7,
      destination: "base-sepolia",
      finality: 2000,
    });
  });
  it("requires finalized Circle metadata and rejects incompatible forwarding shapes", async () => {
    expect(() =>
      validateProviderFee(
        {
          amount: "1100",
          estimatedAmount: "1000",
          token: "USDC",
          decimals: 7,
          destination: "base-sepolia",
          finality: 1000,
        },
        { token: "USDC", destination: "base-sepolia" },
      ),
    ).toThrow(/finality/);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify([{ finalityThreshold: 2000, minimumFee: 0, forwardFee: null }]),
          ),
        ),
    );
    expect(
      (await circleFee(new Request("http://localhost/api/cctp-fee?destination=sepolia"))).status,
    ).toBe(503);
  });
});
