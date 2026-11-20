import { formatUnits } from "@hyperion/protocol";
import { destinationDecimals } from "../config/testnet";

/**
 * Field-level comparison between a reviewed bridge quote and the quote refreshed immediately
 * before signing. Decisions are driven by exact base-unit integers; display strings are
 * presentation only and must never feed back into materiality.
 */
export interface ComparableQuote {
  route: number;
  destination: string;
  adapter: string;
  requestedAmount: bigint;
  grossAmount: bigint;
  fee: bigint;
  destinationAmount: bigint;
  relayGas: bigint;
  estimatedRelayGas?: bigint;
  ledger: number;
}

export type QuoteDiffDirection = "better" | "worse" | "changed";

export type QuoteDiffFieldKey =
  | "route"
  | "destination"
  | "adapter"
  | "requestedAmount"
  | "grossAmount"
  | "fee"
  | "minimum"
  | "providerBudget"
  | "estimatedProviderBudget"
  | "ledger";

export interface QuoteDiffField {
  key: QuoteDiffFieldKey;
  label: string;
  /** Exact reviewed value. Integers are base units; configuration values stay as reported. */
  reviewed: bigint | string | number;
  /** Exact refreshed value. */
  refreshed: bigint | string | number;
  /** Exact refreshed minus reviewed base units, or null for non-integer configuration. */
  delta: bigint | null;
  unit: string | null;
  direction: QuoteDiffDirection;
  /** A material field that moves against the reviewed intent requires explicit re-review. */
  material: boolean;
  reviewedDisplay: string;
  refreshedDisplay: string;
}

export interface QuoteDiff {
  changed: boolean;
  /** Any field worsened, or the route configuration changed. */
  materialWorsening: boolean;
  /** At least one field improved without worsening. */
  improved: boolean;
  fields: QuoteDiffField[];
}

/**
 * Format base units at the asset's own precision. `cap` only shortens the display string so a
 * test or caller can prove that decisions do not depend on formatted rounding.
 */
function formatUnitsDisplay(value: bigint, decimals: number, cap?: number): string {
  const full = formatUnits(value, decimals);
  if (cap === undefined || cap < 0) return full;
  const [whole = "", fraction] = full.split(".");
  if (!fraction || fraction.length <= cap) return full;
  const trimmed = fraction.slice(0, cap).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function compareQuotes(
  reviewed: ComparableQuote,
  refreshed: ComparableQuote,
  options: { displayDecimals?: number } = {},
): QuoteDiff {
  const cap = options.displayDecimals;
  // quoteTransfer already deducts Circle's full forwarding budget at destination precision.
  // This is the actual receive minimum; subtracting the budget again would misstate it.
  const reviewedMinimum = reviewed.destinationAmount;
  const refreshedMinimum = refreshed.destinationAmount;
  const minimumDecimals = destinationDecimals(refreshed.route);
  const minimumUnit = refreshed.route === 0 ? "USDC" : "USDC (ITS)";
  const providerUnit = refreshed.route === 0 ? "USDC" : "XLM";
  const fields: QuoteDiffField[] = [];

  const configuration = (
    key: QuoteDiffFieldKey,
    label: string,
    reviewedValue: bigint | string | number,
    refreshedValue: bigint | string | number,
    material = true,
  ) => {
    if (reviewedValue === refreshedValue) return;
    fields.push({
      key,
      label,
      reviewed: reviewedValue,
      refreshed: refreshedValue,
      delta:
        typeof reviewedValue === "bigint" && typeof refreshedValue === "bigint"
          ? refreshedValue - reviewedValue
          : null,
      unit: null,
      direction: "changed",
      material,
      reviewedDisplay: String(reviewedValue),
      refreshedDisplay: String(refreshedValue),
    });
  };

  const amount = (
    key: QuoteDiffFieldKey,
    label: string,
    reviewedValue: bigint,
    refreshedValue: bigint,
    decimals: number,
    unit: string,
    worseWhen: "higher" | "lower",
  ) => {
    if (reviewedValue === refreshedValue) return;
    const worse =
      worseWhen === "higher" ? refreshedValue > reviewedValue : refreshedValue < reviewedValue;
    fields.push({
      key,
      label,
      reviewed: reviewedValue,
      refreshed: refreshedValue,
      delta: refreshedValue - reviewedValue,
      unit,
      direction: worse ? "worse" : "better",
      material: worse,
      reviewedDisplay: `${formatUnitsDisplay(reviewedValue, decimals, cap)} ${unit}`,
      refreshedDisplay: `${formatUnitsDisplay(refreshedValue, decimals, cap)} ${unit}`,
    });
  };

  // Route configuration identity: any change needs explicit re-review.
  configuration("route", "Route", reviewed.route, refreshed.route);
  configuration("destination", "Destination", reviewed.destination, refreshed.destination);
  configuration("adapter", "Lane adapter", reviewed.adapter, refreshed.adapter);
  configuration(
    "requestedAmount",
    "Requested amount",
    reviewed.requestedAmount,
    refreshed.requestedAmount,
  );
  configuration("grossAmount", "Gross amount", reviewed.grossAmount, refreshed.grossAmount);

  amount("fee", "Hyperion fee", reviewed.fee, refreshed.fee, 7, "USDC", "higher");
  if (reviewed.route !== refreshed.route) {
    fields.push({
      key: "minimum",
      label: "Minimum received",
      reviewed: reviewedMinimum,
      refreshed: refreshedMinimum,
      delta: null,
      unit: null,
      direction: "changed",
      material: true,
      reviewedDisplay: `${formatUnitsDisplay(reviewedMinimum, destinationDecimals(reviewed.route), cap)} USDC${reviewed.route === 1 ? " (ITS)" : ""}`,
      refreshedDisplay: `${formatUnitsDisplay(refreshedMinimum, minimumDecimals, cap)} ${minimumUnit}`,
    });
  } else
    amount(
      "minimum",
      "Minimum received",
      reviewedMinimum,
      refreshedMinimum,
      minimumDecimals,
      minimumUnit,
      "lower",
    );
  if (reviewed.route !== refreshed.route) {
    fields.push({
      key: "providerBudget",
      label: "Provider budget",
      reviewed: reviewed.relayGas,
      refreshed: refreshed.relayGas,
      delta: null,
      unit: null,
      direction: "changed",
      material: true,
      reviewedDisplay: `${formatUnitsDisplay(reviewed.relayGas, 7, cap)} ${reviewed.route === 0 ? "USDC" : "XLM"}`,
      refreshedDisplay: `${formatUnitsDisplay(refreshed.relayGas, 7, cap)} ${providerUnit}`,
    });
  } else
    amount(
      "providerBudget",
      "Provider budget",
      reviewed.relayGas,
      refreshed.relayGas,
      7,
      providerUnit,
      "higher",
    );
  if (reviewed.route !== refreshed.route) {
    const previous = reviewed.estimatedRelayGas ?? reviewed.relayGas;
    const next = refreshed.estimatedRelayGas ?? refreshed.relayGas;
    fields.push({
      key: "estimatedProviderBudget",
      label: "Estimated provider budget",
      reviewed: previous,
      refreshed: next,
      delta: null,
      unit: null,
      direction: "changed",
      material: true,
      reviewedDisplay: `${formatUnitsDisplay(previous, 7, cap)} ${reviewed.route === 0 ? "USDC" : "XLM"}`,
      refreshedDisplay: `${formatUnitsDisplay(next, 7, cap)} ${providerUnit}`,
    });
  } else
    amount(
      "estimatedProviderBudget",
      "Estimated provider budget",
      reviewed.estimatedRelayGas ?? reviewed.relayGas,
      refreshed.estimatedRelayGas ?? refreshed.relayGas,
      7,
      providerUnit,
      "higher",
    );

  // A new ledger is expected on refresh and is informational only.
  configuration("ledger", "Quote ledger", reviewed.ledger, refreshed.ledger, false);

  return {
    changed: fields.length > 0,
    materialWorsening: fields.some((field) => field.material),
    improved:
      !fields.some((field) => field.material) &&
      fields.some((field) => field.direction === "better"),
    fields,
  };
}
