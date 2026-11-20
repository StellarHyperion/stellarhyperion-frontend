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

export function isFreshFeeObservation(validUntil: string, now = Date.now()): boolean {
  const expiry = Date.parse(validUntil);
  return Number.isFinite(expiry) && expiry >= now && expiry - now <= FEE_OBSERVATION_MAX_AGE_MS;
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
