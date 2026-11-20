import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUnits } from "@hyperion/protocol";
import { validateAmount } from "../src/lib/amount-validation";
import {
  amountLabel,
  formatMessage,
  message,
  phaseMessage,
  recoveryMessage,
  settlementPhaseMessage,
  type TranslationCatalog,
} from "../src/lib/messages";
import {
  detectRuntimeCapabilities,
  feeRouteCapabilityResponse,
  runtimeSigningAvailable,
} from "../src/lib/runtime-capabilities";
import { HEAD as relayHead } from "../src/app/api/relay-fee/route";
import { HEAD as cctpHead } from "../src/app/api/cctp-fee/route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("typed transaction messages", () => {
  it("falls back for missing, empty and failed translations without losing recovery guidance", () => {
    expect(formatMessage({}, "conversionUnknown")).toBe(message("conversionUnknown"));
    expect(formatMessage({ conversionUnknown: () => "  " }, "conversionUnknown")).toBe(
      message("conversionUnknown"),
    );
    expect(
      formatMessage(
        {
          conversionUnknown: () => {
            throw new Error("missing translation");
          },
        },
        "conversionUnknown",
      ),
    ).toBe(message("conversionUnknown"));
    expect(message("conversionUnknown")).toMatch(/does not establish broadcast or confirmation/);
    expect(formatMessage({ routeLoading: () => "Recherche du trajet" }, "routeLoading")).toBe(
      "Recherche du trajet",
    );
  });

  it("passes exact decimal strings and immutable unit identity to translated labels beyond Number precision", () => {
    const raw = 9_007_199_254_740_993_123n;
    const input = "900719925474.0993123";
    const translation = vi.fn(
      ({ amount, unit }: { amount: string; unit: string }) =>
        `${unit} : ${amount.replace(".", ",")}`,
    );
    const catalog: TranslationCatalog = { amountLabel: translation };
    expect(amountLabel(raw, 7, "USDC", catalog)).toBe("USDC : 900719925474,0993123");
    expect(translation).toHaveBeenCalledWith({ amount: input, unit: "USDC" });
    expect(parseUnits(input, 7)).toBe(raw);
    expect(() => parseUnits(input.replace(".", ","), 7)).toThrow();
    expect(amountLabel(1_000_001n, 6, "USDC")).toBe("1.000001 USDC");
    expect(amountLabel(1n, 7, "XLM")).toBe("0.0000001 XLM");
    expect(validateAmount("1.0000001", catalog)).toEqual({ valid: true, units: 10_000_001n });
    expect(
      validateAmount("1,0000001", { amountPrecision: () => "Utilisez un point pour les montants" }),
    ).toEqual({ valid: false, message: "Utilisez un point pour les montants" });
  });

  it("retains complete messages for every phase and every source recovery outcome", () => {
    for (const phase of ["preparing", "signing", "submitting", "pending", "confirmed"] as const) {
      expect(phaseMessage(phase)).not.toBe("");
      expect(settlementPhaseMessage(phase)).not.toBe("");
      expect(phaseMessage(phase, {})).toBe(phaseMessage(phase));
    }
    for (const stage of ["conversion", "bridge"] as const)
      for (const status of ["confirmed", "failed", "unknown", null] as const) {
        expect(recoveryMessage(stage, status)).not.toBe("");
        expect(recoveryMessage(stage, status, true)).not.toBe("");
      }
    expect(recoveryMessage("conversion", "confirmed")).toMatch(
      /separate transaction.*wallet approval/,
    );
    expect(recoveryMessage("bridge", "confirmed")).toMatch(
      /Destination delivery is tracked separately/,
    );
    expect(recoveryMessage("bridge", "unknown")).toMatch(/before approving another transfer/);
    expect(settlementPhaseMessage("confirmed")).toBe("Settlement confirmed on Stellar.");
  });
});

describe("independent runtime capability admission", () => {
  it("both real HEAD handlers return only public capability markers without provider calls", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const [head, route] of [
      [relayHead, "relay"],
      [cctpHead, "cctp"],
    ] as const) {
      const response = head();
      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
      expect(Object.fromEntries(response.headers)).toEqual({
        "cache-control": "no-store",
        "x-hyperion-fee-route": route,
        "x-hyperion-runtime": "next-server-v1",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("admits each proved endpoint independently and preserves read-only history if the other is missing", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url === "/api/relay-fee"
          ? feeRouteCapabilityResponse("relay")
          : new Response(null, { status: 404 }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await detectRuntimeCapabilities();
    expect(result).toEqual({
      routes: { relay: "available", cctp: "missing" },
      readOnlyHistory: true,
    });
    expect(runtimeSigningAvailable(result, 1)).toBe(true);
    expect(runtimeSigningAvailable(result, 0)).toBe(false);
    expect(runtimeSigningAvailable(result, 2)).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/relay-fee", "/api/cctp-fee"]);
  });

  it.each([200, 400, 405, 429, 500, 503])(
    "does not treat HTTP %s or generic host responses as available",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("generic host response", { status })),
      );
      const result = await detectRuntimeCapabilities();
      expect(result.routes).toEqual({ relay: "unknown", cctp: "unknown" });
      expect(runtimeSigningAvailable(result, 0)).toBe(false);
      expect(runtimeSigningAvailable(result, 1)).toBe(false);
      expect(result.readOnlyHistory).toBe(true);
    },
  );

  it("rejects another route's marker and a marker without a successful HEAD response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feeRouteCapabilityResponse("relay")));
    expect((await detectRuntimeCapabilities()).routes).toEqual({
      relay: "available",
      cctp: "unknown",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    expect((await detectRuntimeCapabilities()).routes).toEqual({
      relay: "unknown",
      cctp: "unknown",
    });
  });

  it("cancels both current reads and never starts a probe for an already canceled owner", async () => {
    const owner = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Canceled", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = detectRuntimeCapabilities(owner.signal);
    owner.abort();
    expect((await pending).routes).toEqual({ relay: "unknown", cctp: "unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await detectRuntimeCapabilities(owner.signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds a hanging lane by the shared five-second deadline while retaining the independently observed lane", async () => {
    vi.useFakeTimers();
    // Node's AbortSignal.timeout uses real time, so replace its timer with the controlled deadline.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, options: RequestInit) =>
        url === "/api/relay-fee"
          ? Promise.resolve(feeRouteCapabilityResponse("relay"))
          : new Promise<Response>((_resolve, reject) => {
              options.signal?.addEventListener(
                "abort",
                () => {
                  reject(new DOMException("Timed out", "TimeoutError"));
                },
                { once: true },
              );
            }),
      ),
    );
    const pending = detectRuntimeCapabilities();
    await Promise.resolve();
    await Promise.resolve();
    deadline.abort();
    expect((await pending).routes).toEqual({ relay: "available", cctp: "unknown" });
    expect(timeout).toHaveBeenCalledWith(5_000);
    timeout.mockRestore();
  });
});
