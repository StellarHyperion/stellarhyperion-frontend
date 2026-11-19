/** Ten percent headroom, rounded up in the rail's representable fee units. */
export function relayBudget(estimate: bigint, quantum = 1n): bigint {
  if (estimate <= 0n || quantum <= 0n) throw new Error("A positive live fee estimate is required.");
  return ((estimate * 110n + 100n * quantum - 1n) / (100n * quantum)) * quantum;
}

/** Convert Circle's conservative forwarding budget into Stellar's seven-decimal units. */
export function cctpMinimumReceived(netAmount: bigint, forwardingBudget: bigint): bigint {
  if (netAmount <= 0n || forwardingBudget <= 0n || forwardingBudget % 10n !== 0n)
    throw new Error("Circle forwarding budget has invalid precision.");
  const forwardingUnits = forwardingBudget / 10n;
  if (forwardingUnits >= netAmount)
    throw new Error("Increase the amount to cover Circle's destination forwarding fee.");
  return netAmount - forwardingUnits;
}
