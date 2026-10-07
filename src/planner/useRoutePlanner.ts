"use client";

import { useMemo, useState } from "react";
import type { RouteKind } from "@hyperion/protocol";
import type { Leg, Track, YardState } from "../components/switchyard";
import { planRouteExecution } from "./quotes";
import type { QuoteInput, RouteBreakdown } from "./types";

const INITIAL_INPUT: QuoteInput = {
  amount: "1000",
  originChain: "stellar-testnet",
  destinationChain: "arc-testnet",
  destinationAddress: "",
  asset: "USDC",
  slippageBps: 50,
};

export interface RoutePlannerHook {
  input: QuoteInput;
  setAmount: (val: string) => void;
  setDestinationAddress: (val: string) => void;
  setSlippageBps: (bps: number) => void;
  tracks: readonly Track[];
  selectedRoute: RouteKind | null;
  breakdown: RouteBreakdown | null;
  originLeg: Leg;
  destinationLeg: Leg;
  state: YardState;
  resolutionId: string;
}

export function useRoutePlanner(): RoutePlannerHook {
  const [input, setInput] = useState<QuoteInput>(INITIAL_INPUT);

  const setAmount = (amount: string) => {
    setInput((prev) => ({ ...prev, amount }));
  };

  const setDestinationAddress = (destinationAddress: string) => {
    setInput((prev) => ({ ...prev, destinationAddress }));
  };

  const setSlippageBps = (slippageBps: number) => {
    setInput((prev) => ({ ...prev, slippageBps }));
  };

  const { tracks, best, breakdown, originLeg, destinationLeg } = useMemo(() => {
    return planRouteExecution(input);
  }, [input]);

  const resolutionId = `${input.amount}:${input.destinationAddress}`;
  const state: YardState = best !== null ? "resolved" : !input.amount ? "idle" : "blocked";

  return {
    input,
    setAmount,
    setDestinationAddress,
    setSlippageBps,
    tracks,
    selectedRoute: best?.route ?? null,
    breakdown,
    originLeg,
    destinationLeg,
    state,
    resolutionId,
  };
}
