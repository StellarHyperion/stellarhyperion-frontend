export type FeeProvider = "axelar" | "circle";

function drift(provider: FeeProvider, version: string, reason: string): null {
  console.warn("[fee-schema-drift]", { provider, version, reason });
  return null;
}

export function parseAxelarFee(value: unknown): bigint | null {
  const raw = typeof value === "string" ? value.trim().replace(/^"(\d+)"$/, "$1") : null;
  if (!raw || !/^\d+$/.test(raw) || BigInt(raw) <= 0n)
    return drift("axelar", "estimateITSFee", "expected positive integer fee");
  return BigInt(raw);
}

export function parseCircleFee(value: unknown): bigint | null {
  if (!Array.isArray(value)) return drift("circle", "v2", "expected fee array");
  const entry = value.find((candidate) => {
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
  }) as { forwardFee: { med: number } } | undefined;
  if (!entry) return drift("circle", "v2", "no finalized forwarding estimate");
  return BigInt(entry.forwardFee.med);
}
