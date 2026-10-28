/**
 * Backend REST API client for Hyperion transfer tracking and claims.
 *
 * Communicates with the Fastify backend endpoints:
 * - GET /v1/transfers
 * - GET /v1/transfers/by-tx/:txHash
 *
 * Reports indexer failures explicitly. Transfer execution uses Stellar RPC directly.
 */

export type TransferLifecycleStage =
  | "initiated"
  | "attesting"
  | "attested"
  | "delivering"
  | "delivered"
  | "parked"
  | "settled"
  | "failed";

export interface FormattedTransfer {
  readonly id: string;
  readonly stage: TransferLifecycleStage;
  readonly route: number;
  readonly origin: {
    readonly chain: string;
    readonly nonce: string;
    readonly sender: string;
    readonly token: string;
    readonly symbol?: string | null;
    readonly decimals?: number | null;
    readonly grossAmount: string;
    readonly fee: string;
    readonly netAmount: string;
    readonly block: string;
    readonly txHash: string;
    readonly observedAt: string;
  };
  readonly destination: {
    readonly chain: string;
    readonly recipient: string;
    readonly delivered: boolean;
    readonly block: string | null;
    readonly txHash: string | null;
    readonly deliveredAt: string | null;
  };
  readonly rail: {
    readonly status: string | null;
    readonly railStatus: string | null;
    readonly reference: string | null;
    readonly attestedAt: string | null;
    readonly lastError: string | null;
  } | null;
  readonly claim: {
    readonly id: string;
    readonly settled: boolean;
  } | null;
}

export interface TransfersResponse {
  readonly transfers: readonly FormattedTransfer[];
  readonly limit: number;
  readonly offset: number;
  readonly count: number;
}

export interface TransfersQuery {
  readonly originChain?: string;
  readonly destinationChain?: string;
  readonly route?: string;
  readonly sender?: string;
  readonly recipient?: string;
  readonly limit?: string;
  readonly offset?: string;
  readonly search?: string;
}

export function getRouteName(route: number): string {
  switch (route) {
    case 0:
      return "CCTP";
    case 1:
      return "Axelar ITS";
    case 2:
      return "Axelar GMP";
    case 3:
      return "Allbridge";
    default:
      return `Route ${route}`;
  }
}

function getApiBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_HYPERION_API_URL ??
    process.env.NEXT_PUBLIC_HYPERION_INDEXER_URL ??
    ""
  ).replace(/\/$/, "");
}

function request<T>(path: string): Promise<T>;
function request<T>(path: string, notFoundIsNull: true): Promise<T | null>;
async function request<T>(path: string, notFoundIsNull = false): Promise<T | null> {
  const base = getApiBaseUrl();
  if (!base) throw new Error("Transfer history is unavailable: no indexer is configured.");
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "The transfer indexer is unreachable. On-chain transfers and claims still work.",
    );
  }
  if (response.status === 404 && notFoundIsNull) return null;
  if (!response.ok)
    throw new Error(
      `The transfer indexer returned HTTP ${response.status}. No sample records are shown.`,
    );
  return (await response.json()) as T;
}

function params(query?: object): string {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {}))
    if (value !== undefined && value !== "") values.set(key, String(value));
  const encoded = values.toString();
  return encoded ? `?${encoded}` : "";
}
export async function fetchTransfers(query?: TransfersQuery): Promise<TransfersResponse> {
  return await request<TransfersResponse>(`/v1/transfers${params(query)}`);
}
export function fetchTransferByTx(hash: string): Promise<FormattedTransfer | null> {
  return request<FormattedTransfer>(`/v1/transfers/by-tx/${encodeURIComponent(hash)}`, true);
}
