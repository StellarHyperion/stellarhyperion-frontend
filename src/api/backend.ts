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
    readonly token?: string | null;
    readonly amount?: string | null;
    readonly symbol?: string | null;
    readonly decimals?: number | null;
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
    /** Claims without provenance remain visible but cannot be offered for settlement. */
    readonly deployment?: {
      readonly chain: string;
      readonly router: string;
      readonly revision: string;
    } | null;
  } | null;
}

export interface TransfersResponse {
  readonly transfers: readonly FormattedTransfer[];
  readonly limit: number;
  readonly offset: number;
  readonly count: number;
  /** Optional until the backend implements scoped historical coverage metadata. */
  readonly coverage?: TransferCoverage;
}

export interface TransferCoverage {
  readonly complete?: boolean;
  readonly oldestObservedAt?: string | null;
  readonly newestObservedAt?: string | null;
  readonly reason?: string | null;
}

export interface IndexerCursor {
  readonly chain: string;
  readonly block: string;
  readonly hash: string | null;
  readonly updatedAt: string;
}

export interface IndexerMetrics {
  readonly service: string;
  readonly network: string;
  readonly uptimeSeconds: number;
  readonly transfers: {
    readonly totalOutbound: number;
    readonly totalInbound: number;
  };
  readonly claims: {
    readonly total: number;
    readonly settled: number;
    readonly unsettled: number;
  };
  readonly railAttestations: Readonly<Record<string, number>>;
  readonly cursors: readonly IndexerCursor[];
}

const STALE_AFTER_MS = 10 * 60 * 1000;
export type CursorFreshness = "fresh" | "delayed" | "stale" | "unknown";

export function cursorFreshness(cursor: IndexerCursor | null, now = Date.now()): CursorFreshness {
  if (!cursor) return "unknown";
  const updatedAt = Date.parse(cursor.updatedAt);
  if (!Number.isFinite(updatedAt)) return "unknown";
  const age = Math.max(0, now - updatedAt);
  if (age <= STALE_AFTER_MS) return "fresh";
  if (age <= STALE_AFTER_MS * 3) return "delayed";
  return "stale";
}

export interface FormattedClaim {
  readonly id: string;
  readonly chain: string;
  readonly claimId: string;
  readonly recipient: string;
  readonly token: string;
  readonly amount: string;
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: string;
  readonly settled: boolean;
  readonly createdAt: string;
  readonly observedAt: string;
}

export interface ClaimsResponse {
  readonly claims: readonly FormattedClaim[];
  readonly limit: number;
  readonly offset: number;
  readonly count: number;
}

export interface ClaimsQuery {
  readonly chain?: string;
  readonly recipient?: string;
  readonly settled?: string;
  readonly limit?: string;
  readonly offset?: string;
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
export async function fetchClaims(query?: ClaimsQuery): Promise<ClaimsResponse> {
  return await request<ClaimsResponse>(`/v1/claims${params(query)}`);
}

export async function fetchIndexerMetrics(): Promise<IndexerMetrics> {
  return await request<IndexerMetrics>("/v1/metrics");
}

export function fetchTransferByTx(hash: string): Promise<FormattedTransfer | null> {
  return request<FormattedTransfer>(`/v1/transfers/by-tx/${encodeURIComponent(hash)}`, true);
}
