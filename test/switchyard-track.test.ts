import { describe, expect, it } from "vitest";
import { RouteKind } from "@hyperion/protocol";
import { planRouteExecution } from "../src/planner/quotes";
import { Switchyard } from "../src/components/switchyard";
import { Track } from "../src/components/switchyard/Track";
import { Switchyard as YardSwitchyard } from "../src/components/yard";
import { Track as YardTrack } from "../src/components/yard/Track";

describe("Switchyard Track Inspection & Tooltips", () => {
  it("attaches detailed inspection breakdown to each planned track", () => {
    const plan = planRouteExecution({
      amount: "1000",
      originChain: "stellar-testnet",
      destinationChain: "arc-testnet",
      destinationAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      asset: "USDC",
      slippageBps: 50,
    });

    expect(plan.tracks).toHaveLength(4);

    for (const track of plan.tracks) {
      expect(track.inspection).toBeDefined();
      expect(track.inspection?.quotedFee).toBeTruthy();
      expect(track.inspection?.netAmountOut).toBeTruthy();
      expect(track.inspection?.disqualificationCode).toBeTruthy();
      expect(track.inspection?.disqualificationReason).toBeTruthy();
      expect(track.inspection?.headroom).toBeTruthy();
      expect(track.inspection?.latencyEstimate).toBeTruthy();
    }
  });

  it("assigns winning inspection status to the selected rail", () => {
    const plan = planRouteExecution({
      amount: "1000",
      originChain: "stellar-testnet",
      destinationChain: "arc-testnet",
      destinationAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      asset: "USDC",
      slippageBps: 50,
    });

    const winningTrack = plan.tracks.find((t) => t.chosen);
    expect(winningTrack).toBeDefined();
    expect(winningTrack?.route).toBe(RouteKind.AxelarIts);
    expect(winningTrack?.inspection?.disqualificationCode).toBe("WINNING_RAIL");
    expect(winningTrack?.inspection?.netAmountOut).toBe("997.000000 USDC");
    expect(winningTrack?.inspection?.quotedFee).toBe("3.0000000 USDC");
  });

  it("assigns specific disqualification codes and headroom to losing rails", () => {
    const plan = planRouteExecution({
      amount: "1000",
      originChain: "stellar-testnet",
      destinationChain: "arc-testnet",
      destinationAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      asset: "USDC",
      slippageBps: 50,
    });

    const cctpTrack = plan.tracks.find((t) => t.route === RouteKind.Cctp);
    expect(cctpTrack).toBeDefined();
    expect(cctpTrack?.inspection?.disqualificationCode).toBe("REFUSAL_ADAPTER_PENDING");
    expect(cctpTrack?.inspection?.disqualificationReason).toContain("Circle CCTP adapter");

    const gmpTrack = plan.tracks.find((t) => t.route === RouteKind.AxelarGmp);
    expect(gmpTrack).toBeDefined();
    expect(gmpTrack?.inspection?.disqualificationCode).toBe("REFUSAL_NON_CANONICAL");

    const allbridgeTrack = plan.tracks.find((t) => t.route === RouteKind.Allbridge);
    expect(allbridgeTrack).toBeDefined();
    expect(allbridgeTrack?.inspection?.disqualificationCode).toBe("COST_POOL_SLIPPAGE");
  });

  it("exports Track and Switchyard components across switchyard and yard paths", () => {
    expect(Track).toBeDefined();
    expect(Switchyard).toBeDefined();
    expect(YardTrack).toBeDefined();
    expect(YardSwitchyard).toBeDefined();
  });
});
