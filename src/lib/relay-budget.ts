/** Ten percent headroom, rounded up in the rail's representable fee units. */
export function relayBudget(estimate: bigint, quantum = 1n): bigint {
  if (estimate <= 0n || quantum <= 0n) throw new Error("A positive live fee estimate is required.");
  return ((estimate * 110n + 100n * quantum - 1n) / (100n * quantum)) * quantum;
}

export const MAX_RETRY_AFTER_SECONDS = 60;

/** Parse provider cooldown metadata without allowing an unbounded client delay. */
export function boundedRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isInteger(seconds) && seconds >= 0) return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil((timestamp - now) / 1000)));
}

export function cctpMinimumReceived(netAmount: bigint, forwardingBudget: bigint): bigint {
  if (netAmount <= 0n || forwardingBudget <= 0n || forwardingBudget % 10n !== 0n)
    throw new Error("Circle forwarding budget has invalid precision.");
  const forwardingUnits = forwardingBudget / 10n;
  if (forwardingUnits >= netAmount)
    throw new Error("Increase the amount to cover Circle's destination forwarding fee.");
  return netAmount - forwardingUnits;
}
