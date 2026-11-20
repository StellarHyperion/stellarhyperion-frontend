/** Ten percent headroom, rounded up in the rail's representable fee units. */
export function relayBudget(estimate: bigint, quantum = 1n): bigint {
  if (estimate <= 0n || quantum <= 0n) throw new Error("A positive live fee estimate is required.");
  return ((estimate * 110n + 100n * quantum - 1n) / (100n * quantum)) * quantum;
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
