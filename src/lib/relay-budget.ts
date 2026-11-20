/** Ten percent headroom, rounded up in the rail's representable fee units. */
export function relayBudget(estimate: bigint, quantum = 1n): bigint {
  if (estimate <= 0n || quantum <= 0n) throw new Error("A positive live fee estimate is required.");
  return ((estimate * 110n + 100n * quantum - 1n) / (100n * quantum)) * quantum;
}

export const FEE_OBSERVATION_MAX_AGE_MS = 30_000;

export function feeObservation(now = Date.now()): { observedAt: string; validUntil: string } {
  return {
    observedAt: new Date(now).toISOString(),
    validUntil: new Date(now + FEE_OBSERVATION_MAX_AGE_MS).toISOString(),
  };
}

export const MAX_FEE_CLOCK_SKEW_MS = 5_000;
export interface FeeObservation {
  readonly provider: "Axelar ITS" | "Circle CCTP";
  readonly token: "XLM" | "USDC";
  readonly decimals: 7;
  readonly lane: {
    readonly source: "stellar-testnet";
    readonly destination: string;
    readonly route: 0 | 1;
  };
  readonly observedAt: string;
  readonly validUntil: string;
  readonly receivedAt: string;
  /** Conservative local deadline: reserve the entire supported five-second clock skew. */
  readonly clientValidUntil: string;
}

function observationTime(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}

export function validateFeeObservation(
  value: unknown,
  expected: { token: "XLM" | "USDC"; destination: string; route: 0 | 1 },
  now = Date.now(),
): FeeObservation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Live fee observation metadata is unavailable. Refresh the quote.");
  const entry = value as Record<string, unknown>;
  const lane = entry.lane as Record<string, unknown> | null | undefined;
  const provider = expected.route === 0 ? "Circle CCTP" : "Axelar ITS";
  if (
    !lane ||
    typeof lane !== "object" ||
    Array.isArray(lane) ||
    entry.provider !== provider ||
    entry.token !== expected.token ||
    entry.decimals !== 7 ||
    lane.source !== "stellar-testnet" ||
    lane.destination !== expected.destination ||
    lane.route !== expected.route ||
    (expected.route === 0 ? expected.token !== "USDC" : expected.token !== "XLM")
  )
    throw new Error("Live fee observation does not match the reviewed provider, currency or lane.");
  const observed = observationTime(entry.observedAt);
  const expiry = observationTime(entry.validUntil);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(observed) ||
    !Number.isFinite(expiry) ||
    expiry <= observed ||
    expiry - observed > FEE_OBSERVATION_MAX_AGE_MS ||
    observed > now + MAX_FEE_CLOCK_SKEW_MS ||
    now - observed > MAX_FEE_CLOCK_SKEW_MS ||
    expiry - MAX_FEE_CLOCK_SKEW_MS <= now
  )
    throw new Error(
      "The live fee estimate expired or its clock differs by more than five seconds. Refresh the quote.",
    );
  return Object.freeze({
    provider,
    token: expected.token,
    decimals: 7,
    lane: Object.freeze({
      source: "stellar-testnet",
      destination: expected.destination,
      route: expected.route,
    }),
    observedAt: new Date(observed).toISOString(),
    validUntil: new Date(expiry).toISOString(),
    receivedAt: new Date(now).toISOString(),
    clientValidUntil: new Date(
      Math.min(expiry - MAX_FEE_CLOCK_SKEW_MS, now + FEE_OBSERVATION_MAX_AGE_MS),
    ).toISOString(),
  });
}

export function isFreshFeeObservation(observation: FeeObservation, now = Date.now()): boolean {
  const received = observationTime(observation.receivedAt);
  const deadline = observationTime(observation.clientValidUntil);
  return (
    Number.isFinite(now) &&
    received <= now &&
    deadline > now &&
    deadline - received <= FEE_OBSERVATION_MAX_AGE_MS
  );
}

export const MAX_RETRY_AFTER_SECONDS = 60;

/** Parse provider cooldown metadata without allowing an unbounded client delay. */
export function boundedRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isFinite(seconds)
      ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
      : MAX_RETRY_AFTER_SECONDS;
  }
  if (/^[+-]?[\d.]+$/.test(normalized)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil((timestamp - now) / 1000)));
}

/** Circle's approved budget uses Stellar seven-decimal USDC; the payout uses six. */
export function cctpPayoutBreakdown(destinationUnits: bigint, forwardingBudget: bigint) {
  if (destinationUnits <= 0n || forwardingBudget <= 0n || forwardingBudget % 10n !== 0n)
    throw new Error("Circle forwarding budget has invalid precision.");
  const destinationBudget = forwardingBudget / 10n;
  if (destinationBudget >= destinationUnits)
    throw new Error("Increase the amount to cover Circle's destination forwarding fee.");
  return { destinationBudget, minimumReceived: destinationUnits - destinationBudget };
}

/** Compatibility name; use the same exact full-budget payout calculation. */
export function cctpMinimumReceived(destinationUnits: bigint, forwardingBudget: bigint): bigint {
  return cctpPayoutBreakdown(destinationUnits, forwardingBudget).minimumReceived;
}

export const DEFAULT_FEE_COOLDOWN_SECONDS = 5;
export type FeeProvider = "relay" | "cctp";

/** One bounded entry per provider, shared across destinations and changing composer inputs. */
export function createFeeCooldown(now = Date.now) {
  const deadlines: Record<FeeProvider, number> = { relay: 0, cctp: 0 };
  return {
    remaining(provider: FeeProvider): number {
      return Math.max(
        0,
        Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil((deadlines[provider] - now()) / 1000)),
      );
    },
    block(provider: FeeProvider, header: string | null): number {
      const current = now();
      const seconds = Math.max(
        1,
        boundedRetryAfter(header, current) ?? DEFAULT_FEE_COOLDOWN_SECONDS,
      );
      deadlines[provider] = Math.max(deadlines[provider], current + seconds * 1000);
      return this.remaining(provider);
    },
  };
}

export class FeeUnavailableError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Live bridge pricing is rate-limited. Try again in ${retryAfterSeconds} seconds.`);
    this.name = "FeeUnavailableError";
  }
}
