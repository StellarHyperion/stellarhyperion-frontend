import { describe, expect, it } from "vitest";
import { RouteKind } from "@hyperion/protocol";
import {
  calculateMinAmountOut,
  formatAmount,
  getDefaultSnapshot,
  parseAmount,
  planRouteExecution,
} from "../src/planner/quotes";

describe("Route Planner Arithmetic & Parsing", () => {
  it("parses whole amounts into 7-decimal Stellar stroops", () => {
    expect(parseAmount("100")).toBe(100_0000000n);
    expect(parseAmount("1")).toBe(1_0000000n);
    expect(parseAmount("5000")).toBe(5000_0000000n);
  });

  it("parses fractional amounts up to exact precision", () => {
    expect(parseAmount("100.5")).toBe(100_5000000n);
    expect(parseAmount("100.1234567")).toBe(100_1234567n);
  });

  it("rejects over-precision, negative numbers, and non-numeric inputs", () => {
    expect(parseAmount("100.12345678")).toBeNull();
    expect(parseAmount("-50")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });

  it("formats 7-decimal and 6-decimal amounts with tabular comma separators", () => {
    expect(formatAmount(100_0000000n, 7)).toBe("100.0000000");
    expect(formatAmount(1234567_8900000n, 7)).toBe("1,234,567.8900000");
    expect(formatAmount(100_000000n, 6)).toBe("100.000000");
  });

  it("plans quote execution and picks winning rail with exact 30bps protocol fee", () => {
    const plan = planRouteExecution({
      amount: "1000",
      originChain: "stellar-testnet",
      destinationChain: "arc-testnet",
      destinationAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      asset: "USDC",
      slippageBps: 50,
    });

    expect(plan.best).not.toBeNull();
    expect(plan.best?.route).toBe(RouteKind.AxelarIts);
    expect(plan.best?.available).toBe(true);

    // 1000 USDC gross with 30 bps fee (0.30% = 3 USDC)
    expect(plan.breakdown).not.toBeNull();
    expect(plan.breakdown?.grossAmount).toBe("1,000.0000000 USDC");
    expect(plan.breakdown?.feeAmount).toBe("3.0000000 USDC");
    expect(plan.breakdown?.netAmount).toBe("997.0000000 USDC");
    expect(plan.breakdown?.destinationAmount).toBe("997.000000 USDC");
    expect(plan.breakdown?.minAmountOut).toBe("992.015000 USDC");
    expect(plan.breakdown?.minDestinationAmount).toBe(992015000n);

    // Tracks check
    expect(plan.tracks).toHaveLength(4);
    const winningTrack = plan.tracks.find((t) => t.chosen);
    expect(winningTrack).toBeDefined();
    expect(winningTrack?.route).toBe(RouteKind.AxelarIts);
    expect(winningTrack?.verdict).toBeNull();

    // Losing tracks carry descriptive refusal verdicts
    const cctpTrack = plan.tracks.find((t) => t.route === RouteKind.Cctp);
    expect(cctpTrack?.chosen).toBe(false);
    expect(cctpTrack?.verdict?.kind).toBe("refusal");
  });

  it("calculates minimum received amounts across slippage presets and custom inputs", () => {
    const netAmount = 1_000_000000n; // 1000 USDC with 6 decimals

    // 0.1% = 10 bps
    expect(calculateMinAmountOut(netAmount, 10)).toBe(999_000000n);
    // 0.5% = 50 bps
    expect(calculateMinAmountOut(netAmount, 50)).toBe(995_000000n);
    // 1.0% = 100 bps
    expect(calculateMinAmountOut(netAmount, 100)).toBe(990_000000n);
    // custom 250 bps
    expect(calculateMinAmountOut(netAmount, 250)).toBe(975_000000n);
    // custom 600 bps (> 500 bps)
    expect(calculateMinAmountOut(netAmount, 600)).toBe(940_000000n);
  });

  it("handles custom snapshot overrides", () => {
    const snapshot = getDefaultSnapshot();
    expect(snapshot.feeBps).toBe(30);
    expect(snapshot.routeEnabled[RouteKind.AxelarIts]).toBe(true);

    // If router is paused
    const pausedPlan = planRouteExecution(
      {
        amount: "100",
        originChain: "stellar-testnet",
        destinationChain: "arc-testnet",
        destinationAddress: "",
        asset: "USDC",
        slippageBps: 50,
      },
      { paused: true },
    );
    expect(pausedPlan.best).toBeNull();
    expect(pausedPlan.breakdown).toBeNull();
  });

  it("renders an invisible aria-live polite region for route planner announcements", async () => {
    const { RoutePlanner } = await import("../src/planner/RoutePlanner");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const plan = planRouteExecution({
      amount: "1000",
      originChain: "stellar-testnet",
      destinationChain: "arc-testnet",
      destinationAddress: "",
      asset: "USDC",
      slippageBps: 50,
    });

    const mockPlanner = {
      input: {
        amount: "1000",
        originChain: "stellar-testnet",
        destinationChain: "arc-testnet",
        destinationAddress: "",
        asset: "USDC",
        slippageBps: 50,
      },
      setAmount: () => undefined,
      setDestinationAddress: () => undefined,
      setSlippageBps: () => undefined,
      tracks: plan.tracks,
      selectedRoute: plan.best?.route ?? null,
      breakdown: plan.breakdown,
      originLeg: plan.originLeg,
      destinationLeg: plan.destinationLeg,
      state: "resolved" as const,
      resolutionId: "1000:",
    };

    const { createElement } = await import("react");
    const html = renderToStaticMarkup(createElement(RoutePlanner, { planner: mockPlanner }));
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain("visuallyHidden");
  });
});
