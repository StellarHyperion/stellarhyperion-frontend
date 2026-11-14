import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getCctpFee } from "../src/app/api/cctp-fee/route";
import { GET as getRelayFee } from "../src/app/api/relay-fee/route";
import { TESTNET } from "../src/config/testnet";
import {
  FEE_QUOTE_TTL_MS,
  createSingleFlightCoalescer,
  feeQuoteKey,
  isAbortError,
  relayBudget,
  resetFeeQuoteCache,
} from "../src/lib/relay-budget";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  resetFeeQuoteCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Fee quote single-flight coalescing primitive", () => {
  it("coalesces concurrent identical reads, clones payloads, and expires after the explicit lifetime", async () => {
    let clock = 1_000;
    const coalescer = createSingleFlightCoalescer<{ amount: string; token: string }>({
      ttlMs: FEE_QUOTE_TTL_MS,
      now: () => clock,
    });
    const gate = deferred<{ amount: string; token: string }>();
    const load = vi.fn(() => gate.promise);
    const key = feeQuoteKey({
      provider: "axelar-its",
      source: "stellar-2026-q1-2",
      destination: "sepolia:ethereum-sepolia",
      token: "XLM",
      issuer: null,
      decimals: 7,
    });

    const first = coalescer.coalesce(key, load);
    const second = coalescer.coalesce(key, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(coalescer.size()).toEqual({ cached: 0, inFlight: 1 });

    gate.resolve({ amount: "1100", token: "XLM" });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ amount: "1100", token: "XLM" });
    expect(secondResult).toEqual({ amount: "1100", token: "XLM" });

    // Caller mutation must never corrupt shared state or sibling callers.
    firstResult.amount = "0";
    expect(secondResult.amount).toBe("1100");

    clock += FEE_QUOTE_TTL_MS - 1;
    const cachedResult = await coalescer.coalesce(key, load);
    expect(cachedResult).toEqual({ amount: "1100", token: "XLM" });
    expect(load).toHaveBeenCalledTimes(1);

    clock += 2;
    const freshLoad = vi.fn(() => Promise.resolve({ amount: "1320", token: "XLM" }));
    const refreshedResult = await coalescer.coalesce(key, freshLoad);
    expect(refreshedResult).toEqual({ amount: "1320", token: "XLM" });
    expect(freshLoad).toHaveBeenCalledTimes(1);
  });

  it("never partitions different destinations, currencies, or token issuers into the same entry", () => {
    const xlmSepolia = feeQuoteKey({
      provider: "axelar-its",
      source: "stellar-2026-q1-2",
      destination: "sepolia:ethereum-sepolia",
      token: "XLM",
      issuer: null,
      decimals: 7,
    });
    const usdcSepolia = feeQuoteKey({
      provider: "circle-cctp",
      source: "domain:27",
      destination: "sepolia:domain:0",
      token: "USDC",
      issuer: TESTNET.usdcIssuer,
      decimals: 7,
    });
    const usdcBaseSepolia = feeQuoteKey({
      provider: "circle-cctp",
      source: "domain:27",
      destination: "base-sepolia:domain:6",
      token: "USDC",
      issuer: TESTNET.usdcIssuer,
      decimals: 7,
    });
    const usdcOtherIssuer = feeQuoteKey({
      provider: "circle-cctp",
      source: "domain:27",
      destination: "sepolia:domain:0",
      token: "USDC",
      issuer: TESTNET.reader,
      decimals: 7,
    });

    expect(new Set([xlmSepolia, usdcSepolia, usdcBaseSepolia, usdcOtherIssuer]).size).toBe(4);
  });

  it("evicts failed upstream reads immediately instead of caching unhealthy entries", async () => {
    const coalescer = createSingleFlightCoalescer<{ amount: string }>({ ttlMs: FEE_QUOTE_TTL_MS });
    const key = "circle-cctp|domain:27|sepolia:domain:0|USDC|issuer|7";
    let calls = 0;
    const load = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("upstream 503"));
      return Promise.resolve({ amount: "8800" });
    });

    await expect(coalescer.coalesce(key, load)).rejects.toThrow("upstream 503");
    expect(coalescer.size()).toEqual({ cached: 0, inFlight: 0 });

    const recovered = await coalescer.coalesce(key, load);
    expect(recovered).toEqual({ amount: "8800" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("isolates individual client cancellation without aborting sibling subscribers", async () => {
    const coalescer = createSingleFlightCoalescer<{ amount: string }>({ ttlMs: FEE_QUOTE_TTL_MS });
    const key = "axelar-its|stellar-2026-q1-2|sepolia|XLM|native|7";
    const gate = deferred<{ amount: string }>();
    let upstreamAborted = false;

    const load = vi.fn((signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        upstreamAborted = true;
      });
      return gate.promise;
    });

    const controllerA = new AbortController();
    const controllerB = new AbortController();

    const requestA = coalescer.coalesce(key, load, { signal: controllerA.signal });
    const requestB = coalescer.coalesce(key, load, { signal: controllerB.signal });

    controllerA.abort();
    await expect(requestA).rejects.toSatisfy(isAbortError);
    expect(upstreamAborted).toBe(false);

    gate.resolve({ amount: "2200" });
    await expect(requestB).resolves.toEqual({ amount: "2200" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("aborts an abandoned flight when its sole subscriber cancels and starts clean for the next subscriber", async () => {
    const coalescer = createSingleFlightCoalescer<{ amount: string }>({ ttlMs: FEE_QUOTE_TTL_MS });
    const key = "circle-cctp|domain:27|arc-testnet:domain:26|USDC|issuer|7";
    let firstSignalAborted = false;

    const firstLoad = vi.fn(
      (signal: AbortSignal) =>
        new Promise<{ amount: string }>((_, reject) => {
          signal.addEventListener("abort", () => {
            firstSignalAborted = true;
            reject(new Error("aborted upstream"));
          });
        }),
    );

    const controller = new AbortController();
    const cancelled = coalescer.coalesce(key, firstLoad, { signal: controller.signal });
    controller.abort();

    await expect(cancelled).rejects.toSatisfy(isAbortError);
    expect(firstSignalAborted).toBe(true);
    expect(coalescer.size()).toEqual({ cached: 0, inFlight: 0 });

    const secondLoad = vi.fn(() => Promise.resolve({ amount: "4400" }));
    await expect(coalescer.coalesce(key, secondLoad)).resolves.toEqual({ amount: "4400" });
    expect(secondLoad).toHaveBeenCalledTimes(1);
  });
});

describe("Next.js fee quote endpoints", () => {
  it("keeps concurrent destinations and currencies strictly isolated across relay-fee and cctp-fee", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("axelarscan.io")) {
        return Promise.resolve(new Response('"955529"', { status: 200 }));
      }
      if (url.includes("/fees/27/0?")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 50_000 } },
            ]),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/fees/27/6?")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 12_000 } },
            ]),
            { status: 200 },
          ),
        );
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const [xlmA, xlmB, cctpSepoliaA, cctpSepoliaB, cctpBase] = await Promise.all([
      getRelayFee(new Request("http://localhost/api/relay-fee?destination=sepolia")),
      getRelayFee(new Request("http://localhost/api/relay-fee")),
      getCctpFee(new Request("http://localhost/api/cctp-fee?destination=sepolia")),
      getCctpFee(new Request("http://localhost/api/cctp-fee?destination=sepolia")),
      getCctpFee(new Request("http://localhost/api/cctp-fee?destination=base-sepolia")),
    ]);

    // Exactly one upstream call per unique (provider, destination, currency) tuple.
    expect(fetcher).toHaveBeenCalledTimes(3);

    const xlmBodyA = (await xlmA.json()) as Record<string, unknown>;
    const xlmBodyB = (await xlmB.json()) as Record<string, unknown>;
    const sepoliaBody = (await cctpSepoliaA.json()) as Record<string, unknown>;
    const sepoliaBodyDup = (await cctpSepoliaB.json()) as Record<string, unknown>;
    const baseBody = (await cctpBase.json()) as Record<string, unknown>;

    expect(xlmBodyA).toEqual({
      amount: String(relayBudget(955529n)),
      estimatedAmount: "955529",
      token: "XLM",
      issuer: null,
      decimals: 7,
    });
    expect(xlmBodyB).toEqual(xlmBodyA);

    expect(sepoliaBody).toEqual({
      amount: String(relayBudget(50_000n) * 10n),
      estimatedAmount: "500000",
      token: "USDC",
      issuer: TESTNET.usdcIssuer,
      decimals: 7,
      finality: 2000,
    });
    expect(sepoliaBodyDup).toEqual(sepoliaBody);

    expect(baseBody).toEqual({
      amount: String(relayBudget(12_000n) * 10n),
      estimatedAmount: "120000",
      token: "USDC",
      issuer: TESTNET.usdcIssuer,
      decimals: 7,
      finality: 2000,
    });
    expect(sepoliaBody.amount).not.toBe(baseBody.amount);
    expect(xlmBodyA.token).not.toBe(sepoliaBody.token);
  });

  it("exposes only independently supported testnet lanes", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const unsupportedIts = await getRelayFee(
      new Request("http://localhost/api/relay-fee?destination=base-sepolia"),
    );
    expect(unsupportedIts.status).toBe(400);

    const unknownRelay = await getRelayFee(
      new Request("http://localhost/api/relay-fee?destination=mainnet"),
    );
    expect(unknownRelay.status).toBe(400);

    const unknownCctp = await getCctpFee(
      new Request("http://localhost/api/cctp-fee?destination=mainnet"),
    );
    expect(unknownCctp.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never substitutes zero or caches failed upstream responses", async () => {
    let attempt = 0;
    const fetcher = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) return Promise.resolve(new Response('"0"', { status: 200 }));
      if (attempt === 2) return Promise.resolve(new Response("unavailable", { status: 503 }));
      return Promise.resolve(new Response('"100000"', { status: 200 }));
    });
    vi.stubGlobal("fetch", fetcher);

    const zeroQuote = await getRelayFee(new Request("http://localhost/api/relay-fee"));
    expect(zeroQuote.status).toBe(503);

    const failedQuote = await getRelayFee(new Request("http://localhost/api/relay-fee"));
    expect(failedQuote.status).toBe(503);

    const healthyQuote = await getRelayFee(new Request("http://localhost/api/relay-fee"));
    expect(healthyQuote.status).toBe(200);
    expect(await healthyQuote.json()).toEqual({
      amount: "110000",
      estimatedAmount: "100000",
      token: "XLM",
      issuer: null,
      decimals: 7,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("preserves a sibling client's valid HTTP response when another client cancels mid-flight", async () => {
    const gate = deferred<Response>();
    const fetcher = vi.fn(() => gate.promise);
    vi.stubGlobal("fetch", fetcher);

    const abortA = new AbortController();
    const reqA = new Request("http://localhost/api/cctp-fee?destination=sepolia", {
      signal: abortA.signal,
    });
    const reqB = new Request("http://localhost/api/cctp-fee?destination=sepolia");

    const pendingA = getCctpFee(reqA);
    const pendingB = getCctpFee(reqB);

    abortA.abort();
    const resA = await pendingA;
    expect(resA.status).toBe(499);

    gate.resolve(
      new Response(
        JSON.stringify([{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 25_000 } }]),
        { status: 200 },
      ),
    );
    const resB = await pendingB;
    expect(resB.status).toBe(200);
    expect(await resB.json()).toEqual({
      amount: String(relayBudget(25_000n) * 10n),
      estimatedAmount: "250000",
      token: "USDC",
      issuer: TESTNET.usdcIssuer,
      decimals: 7,
      finality: 2000,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
