/**
 * A layout fixture. Not product data, and not pretending to be.
 *
 * The switchyard is driven by real quotes from the deployed router, and that wiring is the next
 * thing to land. Until then the page needs something with the right shape to lay out against,
 * because a component positioned with empty props positions itself wrong and nobody notices until
 * real data arrives and the annotations overlap.
 *
 * Everything below is stated as what it is. The numbers are plausible rather than measured, the
 * reasons are the reasons these rails actually lose, and this file is named `_fixtures` and
 * excluded from the route tree so it can never be mistaken for a data layer.
 */
import {
  ROUTE_LABELS,
  RouteKind,
  carriesPayload,
  isCanonical,
  waitsOnAttestation,
} from "@hyperion/protocol";

import type { Leg, Track } from "../../components/switchyard/index";

export const ORIGIN_LEG: Leg = {
  name: "Stellar",
  detail: "1,000.0000000 USDC",
};

export const DESTINATION_LEG: Leg = {
  name: "Arc",
  detail: "997.000000 USDC",
};

/**
 * Four rails, in the enum's own order, with the reason each loser lost.
 *
 * The reasons are the real ones. CCTP wins a dollar transfer because it burns and mints the actual
 * asset at no slippage, and the only thing it costs you is the attestation wait. ITS matches it on
 * canonicality and loses on destination gas. GMP can carry an instruction but has no registered
 * token to move here. Allbridge is the fast one and pays for it in pool slippage, which on a
 * thousand dollars is more than the attestation wait is worth.
 */
export const TRACKS: readonly Track[] = [
  {
    route: RouteKind.Cctp,
    label: ROUTE_LABELS[RouteKind.Cctp],
    chosen: true,
    verdict: null,
    landing: "997.000000 USDC",
    waitsOnAttestation: waitsOnAttestation(RouteKind.Cctp),
    canonical: isCanonical(RouteKind.Cctp),
  },
  {
    route: RouteKind.AxelarIts,
    label: ROUTE_LABELS[RouteKind.AxelarIts],
    chosen: false,
    verdict: { note: "destination gas, paid up front", kind: "cost" },
    landing: "996.142000 USDC",
    waitsOnAttestation: waitsOnAttestation(RouteKind.AxelarIts),
    canonical: isCanonical(RouteKind.AxelarIts),
  },
  {
    route: RouteKind.AxelarGmp,
    label: ROUTE_LABELS[RouteKind.AxelarGmp],
    chosen: false,
    verdict: { note: "no canonical token on this lane", kind: "refusal" },
    landing: null,
    waitsOnAttestation: waitsOnAttestation(RouteKind.AxelarGmp),
    canonical: isCanonical(RouteKind.AxelarGmp),
  },
  {
    route: RouteKind.Allbridge,
    label: ROUTE_LABELS[RouteKind.Allbridge],
    chosen: false,
    verdict: { note: "0.31% pool slippage", kind: "cost" },
    landing: "993.910000 USDC",
    waitsOnAttestation: waitsOnAttestation(RouteKind.Allbridge),
    canonical: isCanonical(RouteKind.Allbridge),
  },
];

/** Whether a muxed destination can be paid on each rail, which the destination leg explains. */
export const CARRIES_PAYLOAD = Object.fromEntries(
  TRACKS.map((track) => [track.route, carriesPayload(track.route)]),
) as Record<RouteKind, boolean>;
