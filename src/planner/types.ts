import type { RouteKind, RouteQuote } from "@hyperion/protocol";
import type { Leg, Track } from "../components/switchyard";

export interface QuoteInput {
  amount: string;
  originChain: string;
  destinationChain: string;
  destinationAddress: string;
  asset: string;
  slippageBps: number;
}

export interface RouteBreakdown {
  grossAmount: string;
  feeAmount: string;
  feePercent: string;
  netAmount: string;
  destinationAmount: string;
  selectedRoute: RouteKind | null;
  selectedRouteLabel: string | null;
  isCanonical: boolean;
  waitsOnAttestation: boolean;
}

export interface PlannerState {
  input: QuoteInput;
  status: "idle" | "quoting" | "quoted" | "error";
  tracks: readonly Track[];
  bestQuote: RouteQuote | null;
  breakdown: RouteBreakdown | null;
  originLeg: Leg;
  destinationLeg: Leg;
  errorMessage: string | null;
}
