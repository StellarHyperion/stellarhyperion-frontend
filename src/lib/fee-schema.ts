export interface ProviderFeeQuote {
  readonly amount: string;
  readonly estimatedAmount: string;
  readonly token: "XLM" | "USDC";
  readonly decimals: 7;
  readonly destination: string;
  readonly finality?: number;
  readonly provider?: string;
  readonly observedAt?: string;
  readonly validUntil?: string;
  readonly lane?: {
    readonly source: "stellar-testnet";
    readonly destination: string;
    readonly route: 0 | 1;
  };
}

const MAX_FEE = (1n << 127n) - 1n;

export function validateProviderFee(
  value: unknown,
  expected: {
    token: ProviderFeeQuote["token"];
    destination: string;
  },
): ProviderFeeQuote {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider fee response.");
  const entry = value as Record<string, unknown>;
  const amount = entry.amount;
  const estimatedAmount = entry.estimatedAmount;
  if (
    typeof amount !== "string" ||
    typeof estimatedAmount !== "string" ||
    amount.length > 39 ||
    estimatedAmount.length > 39 ||
    !/^\d+$/.test(amount) ||
    !/^\d+$/.test(estimatedAmount) ||
    BigInt(amount) <= 0n ||
    BigInt(estimatedAmount) <= 0n ||
    BigInt(estimatedAmount) > BigInt(amount) ||
    BigInt(amount) > MAX_FEE ||
    entry.token !== expected.token ||
    entry.decimals !== 7 ||
    entry.destination !== expected.destination
  )
    throw new Error("Provider fee response failed schema validation.");
  const finality = entry.finality;
  if (
    (expected.token === "USDC" && finality !== 2000) ||
    (expected.token === "XLM" && finality !== undefined)
  )
    throw new Error("Provider fee finality is invalid.");
  const lane = entry.lane;
  if (
    lane !== undefined &&
    (!lane ||
      typeof lane !== "object" ||
      Array.isArray(lane) ||
      (lane as Record<string, unknown>).source !== "stellar-testnet" ||
      (lane as Record<string, unknown>).destination !== expected.destination ||
      (lane as Record<string, unknown>).route !== (expected.token === "USDC" ? 0 : 1))
  )
    throw new Error("Provider fee lane is invalid.");
  return {
    amount,
    estimatedAmount,
    token: expected.token,
    decimals: 7,
    destination: expected.destination,
    ...(typeof finality === "number" ? { finality } : {}),
    ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}),
    ...(typeof entry.observedAt === "string" ? { observedAt: entry.observedAt } : {}),
    ...(typeof entry.validUntil === "string" ? { validUntil: entry.validUntil } : {}),
    ...(entry.lane && typeof entry.lane === "object" && !Array.isArray(entry.lane)
      ? { lane: entry.lane as NonNullable<ProviderFeeQuote["lane"]> }
      : {}),
  };
}
