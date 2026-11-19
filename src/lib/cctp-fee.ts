export interface FinalizedCctpFee {
  amount: bigint;
  finality: 2000;
}

export function selectFinalizedCctpFee(value: unknown): FinalizedCctpFee | null {
  if (!Array.isArray(value)) return null;
  const matches = value.filter((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const item = candidate as Record<string, unknown>;
    const forward = item.forwardFee;
    return (
      item.finalityThreshold === 2000 &&
      item.minimumFee === 0 &&
      !!forward &&
      typeof forward === "object" &&
      Number.isSafeInteger((forward as Record<string, unknown>).med) &&
      ((forward as Record<string, unknown>).med as number) > 0
    );
  });
  if (matches.length !== 1) return null;
  return {
    amount: BigInt((matches[0] as { forwardFee: { med: number } }).forwardFee.med),
    finality: 2000,
  };
}
