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
