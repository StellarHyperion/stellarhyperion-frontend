import { afterEach, describe, expect, it, vi } from "vitest";
import { validateProviderFee } from "../src/lib/fee-schema";
import { createSingleFlightCache } from "../src/lib/single-flight";
import { GET as relayFee } from "../src/app/api/relay-fee/route";
import { GET as circleFee } from "../src/app/api/cctp-fee/route";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

describe("provider fee single-flight cache", () => {
  it("shares only matching requests for its explicit lifetime", async () => {
    vi.useFakeTimers();
    const cache = createSingleFlightCache<number>(2_000);
    const load = vi.fn(async () => 42);

    const first = cache("circle:USDC:sepolia", load);
    const concurrent = cache("circle:USDC:sepolia", load);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([42, 42]);
    await expect(cache("circle:USDC:sepolia", load)).resolves.toBe(42);
    expect(load).toHaveBeenCalledOnce();

    await expect(cache("circle:USDC:base-sepolia", load)).resolves.toBe(42);
    await expect(cache("axelar:XLM:ethereum-sepolia", load)).resolves.toBe(42);
    expect(load).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(cache("circle:USDC:sepolia", load)).resolves.toBe(42);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("does not retain rejected provider requests", async () => {
    const cache = createSingleFlightCache<number>(2_000);
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) {
        fail = false;
        throw new Error("provider unavailable");
      }
      return 7;
    });

    await expect(cache("axelar:XLM:ethereum-sepolia", load)).rejects.toThrow(
      "provider unavailable",
    );
    await expect(cache("axelar:XLM:ethereum-sepolia", load)).resolves.toBe(7);
    expect(load).toHaveBeenCalledTimes(2);
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
    const response = await relayFee(new Request("http://localhost/api/relay-fee"));
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
      provider: "Circle CCTP",
      lane: { source: "stellar-testnet", destination: "base-sepolia", route: 0 },
      observedAt: expect.any(String) as string,
      validUntil: expect.any(String) as string,
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

  it("coalesces same-lane requests without coupling client cancellation or other lanes", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const urls: string[] = [];
    const upstreamSignals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        if (init?.signal) upstreamSignals.push(init.signal);
        await waiting;
        return url.includes("iris-api-sandbox")
          ? new Response(
              JSON.stringify([
                { finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 101 } },
              ]),
            )
          : new Response('"1000"');
      }),
    );

    const cancelledClient = new AbortController();
    const cancelled = circleFee(
      new Request("http://localhost/api/cctp-fee?destination=sepolia", {
        signal: cancelledClient.signal,
      }),
    );
    const sameLane = circleFee(new Request("http://localhost/api/cctp-fee?destination=sepolia"));
    const differentDestination = circleFee(
      new Request("http://localhost/api/cctp-fee?destination=arc-testnet"),
    );
    const differentCurrency = relayFee(new Request("http://localhost/api/relay-fee"));
    cancelledClient.abort();
    await Promise.resolve();

    expect(urls).toHaveLength(3);
    expect(new Set(urls).size).toBe(3);
    expect(upstreamSignals.every((signal) => !signal.aborted)).toBe(true);

    release();
    const responses = await Promise.all([
      cancelled,
      sameLane,
      differentDestination,
      differentCurrency,
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(await responses[0].json()).toMatchObject({
      token: "USDC",
      destination: "sepolia",
    });
    expect(await responses[2].json()).toMatchObject({
      token: "USDC",
      destination: "arc-testnet",
    });
    expect(await responses[3].json()).toMatchObject({
      token: "XLM",
      destination: "ethereum-sepolia",
    });
  });
});
