import {
  bestQuote,
  describeBlocker,
  planQuotes,
  ROUTE_LABELS,
  RouteKind,
  type RouterSnapshot,
  type RouteQuote,
} from "@hyperion/protocol";
import type { Leg, Track } from "../components/switchyard";
import type { QuoteInput, RouteBreakdown } from "./types";

const STELLAR_DECIMALS = 7;
const EVM_DECIMALS = 6;

export function getDefaultSnapshot(): RouterSnapshot {
  return {
    paused: false,
    feeBps: 30, // 0.30% router protocol fee
    routeEnabled: {
      [RouteKind.Cctp]: false,
      [RouteKind.AxelarIts]: true,
      [RouteKind.AxelarGmp]: false,
      [RouteKind.Allbridge]: false,
    },
    adapterSet: {
      [RouteKind.Cctp]: false,
      [RouteKind.AxelarIts]: true,
      [RouteKind.AxelarGmp]: false,
      [RouteKind.Allbridge]: false,
    },
    tokenRegistered: true,
    tokenEnabled: true,
    tokenDecimals: STELLAR_DECIMALS,
    flowAvailable: {
      [RouteKind.Cctp]: 0n,
      [RouteKind.AxelarIts]: 10_000_000_000_000n, // 1M USDC flow limit
      [RouteKind.AxelarGmp]: 0n,
      [RouteKind.Allbridge]: 0n,
    },
    chainSupported: {
      [RouteKind.Cctp]: false,
      [RouteKind.AxelarIts]: true,
      [RouteKind.AxelarGmp]: false,
      [RouteKind.Allbridge]: false,
    },
  };
}

export function parseAmount(input: string, decimals = STELLAR_DECIMALS): bigint | null {
  const clean = input.trim();
  if (!clean || clean === "0") return null;

  const parts = clean.split(".");
  if (parts.length > 2) return null;

  const wholeStr = parts[0] ?? "0";
  const fracStr = parts[1] ?? "";

  if (!/^\d+$/.test(wholeStr) || (fracStr && !/^\d+$/.test(fracStr))) {
    return null;
  }

  if (fracStr.length > decimals) {
    return null;
  }

  const paddedFrac = fracStr.padEnd(decimals, "0");
  try {
    const whole = BigInt(wholeStr) * 10n ** BigInt(decimals);
    const frac = BigInt(paddedFrac);
    return whole + frac;
  } catch {
    return null;
  }
}

export function formatAmount(raw: bigint, decimals = STELLAR_DECIMALS): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;

  const fracStr = frac.toString().padStart(decimals, "0");
  return `${whole.toLocaleString("en-US")}.${fracStr}`;
}

const FALLBACK_DESTINATION = "GCHPVETUL5E4YKDLMRIBFUGFK4PMYOVKPFALVSYMP2QDYAVBA3ITQDAI";

export function planRouteExecution(
  input: QuoteInput,
  snapshotOverride?: Partial<RouterSnapshot>,
): {
  tracks: readonly Track[];
  best: RouteQuote | null;
  breakdown: RouteBreakdown | null;
  originLeg: Leg;
  destinationLeg: Leg;
} {
  const snapshot: RouterSnapshot = {
    ...getDefaultSnapshot(),
    ...snapshotOverride,
  };

  const parsedAmount = parseAmount(input.amount, STELLAR_DECIMALS);
  const effectiveAmount = parsedAmount ?? 1_000_0000000n; // Default 1000 USDC for layout preview
  const destStrkey = input.destinationAddress.trim() || FALLBACK_DESTINATION;

  const quotes = planQuotes(
    {
      amount: effectiveAmount,
      strkey: destStrkey,
      destinationDecimals: EVM_DECIMALS,
    },
    snapshot,
  );

  const best = bestQuote(quotes);

  const tracks: Track[] = quotes.map((q) => {
    const isWinner = best !== null && q.route === best.route;
    let verdict: Track["verdict"] = null;

    if (!isWinner) {
      if (q.route === RouteKind.Cctp) {
        verdict = { note: "adapter pending Circle deployment", kind: "refusal" };
      } else if (q.route === RouteKind.AxelarGmp) {
        verdict = { note: "no canonical token on this lane", kind: "refusal" };
      } else if (q.route === RouteKind.Allbridge) {
        verdict = { note: "0.31% pool slippage", kind: "cost" };
      } else {
        const blocker = describeBlocker(q.reason);
        verdict = {
          note: blocker.label.toLowerCase(),
          kind: blocker.owner === "operator" ? "refusal" : "cost",
        };
      }
    }

    const landingStr =
      q.available && q.destinationAmount > 0n
        ? `${formatAmount(q.destinationAmount, EVM_DECIMALS)} ${input.asset}`
        : null;

    return {
      route: q.route,
      label: ROUTE_LABELS[q.route],
      chosen: isWinner,
      verdict,
      landing: landingStr,
      waitsOnAttestation: q.waitsOnAttestation,
      canonical: q.isCanonical,
    };
  });

  const formattedGross = formatAmount(effectiveAmount, STELLAR_DECIMALS);
  const formattedNet = best ? formatAmount(best.netAmount, STELLAR_DECIMALS) : formattedGross;
  const formattedDest = best ? formatAmount(best.destinationAmount, EVM_DECIMALS) : formattedGross;
  const formattedFee = best ? formatAmount(best.fee, STELLAR_DECIMALS) : "0.0000000";

  const originLeg: Leg = {
    name: "Stellar",
    detail: `${formattedGross} ${input.asset}`,
  };

  const destinationLeg: Leg = {
    name: "Arc",
    detail: `${formattedDest} ${input.asset}`,
  };

  const breakdown: RouteBreakdown | null = best
    ? {
        grossAmount: `${formattedGross} ${input.asset}`,
        feeAmount: `${formattedFee} ${input.asset}`,
        feePercent: `${(snapshot.feeBps / 100).toFixed(2)}%`,
        netAmount: `${formattedNet} ${input.asset}`,
        destinationAmount: `${formattedDest} ${input.asset}`,
        selectedRoute: best.route,
        selectedRouteLabel: ROUTE_LABELS[best.route],
        isCanonical: best.isCanonical,
        waitsOnAttestation: best.waitsOnAttestation,
      }
    : null;

  return {
    tracks,
    best,
    breakdown,
    originLeg,
    destinationLeg,
  };
}
