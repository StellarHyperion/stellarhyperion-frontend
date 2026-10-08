/**
 * What the switchyard needs to know about a rail.
 *
 * Shaped after `RouteQuote` from the protocol package rather than after this component's
 * convenience. The page passes quotes through almost untouched, which is what keeps the drawing
 * honest: if the yard shows a track as the winner, it is because the router priced it that way,
 * not because a presentation layer decided it looked better.
 */
import type { RouteKind } from "@hyperion/protocol";

/** Why a rail is not carrying this transfer, in the few words that fit next to a track. */
export interface TrackVerdict {
  /** Mono, short, and specific. "waits 13m on attestation" rather than "slower". */
  readonly note: string;
  /**
   * Whether the note describes a cost or a refusal.
   *
   * A rail that merely costs more is still a rail. A rail that cannot carry this transfer at all
   * is a different thing, and the yard draws them differently rather than greying both out.
   */
  readonly kind: "cost" | "refusal";
}

export interface TrackInspection {
  readonly quotedFee: string;
  readonly netAmountOut: string;
  readonly disqualificationCode: string;
  readonly disqualificationReason: string;
  readonly headroom: string;
  readonly latencyEstimate?: string;
}

export interface Track {
  readonly route: RouteKind;
  /** The rail's name, as a person would say it. */
  readonly label: string;
  /** Whether the router would actually use this one. Exactly one track may be chosen. */
  readonly chosen: boolean;
  /** Null when the rail is available and simply lost on price. */
  readonly verdict: TrackVerdict | null;
  /** What lands, already formatted. The yard never does arithmetic. */
  readonly landing: string | null;
  /** True for a rail whose second leg waits on an attestation somebody has to fetch. */
  readonly waitsOnAttestation: boolean;
  /** True for the rail that moves the asset itself rather than a representation of it. */
  readonly canonical: boolean;
  /** Detailed breakdown for inspection popovers. */
  readonly inspection?: TrackInspection;
}

export interface Leg {
  /** The chain's name. */
  readonly name: string;
  /** The asset and amount, already formatted, shown in mono under the name. */
  readonly detail: string;
}

export type YardState =
  /** Nothing has been asked yet. Tracks sit dormant and no winner is drawn. */
  | "idle"
  /** A quote is in flight. The yard says so without pretending to know the answer. */
  | "pricing"
  /** Quotes resolved and one track won. */
  | "resolved"
  /** Every rail refused. The yard shows why rather than showing nothing. */
  | "blocked";
