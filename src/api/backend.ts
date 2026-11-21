import { parseTransferProof, type TransferProof } from "../lib/transfer-proof";

import { TESTNET, destinationFor } from "../config/testnet";
import type { LocalTransferReference } from "../lib/local-transfers";
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

export interface ProofRevision {
  readonly status: "valid" | "reconciled" | "invalidated";
  readonly previousTxHash: string | null;
  readonly replacementTxHash: string | null;
  readonly reason: string | null;
}

export interface FormattedTransfer {
  readonly id: string;
  readonly stage: TransferLifecycleStage;
  readonly route: number;
  readonly origin: {
    readonly chain: string;
    readonly nonce: string;
    readonly sender: string;
    readonly token: string;
    /** Optional deployment identity supplied by newer indexer contracts. */
    readonly router?: string | null;
    readonly revision?: string | null;
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
    readonly representation?: string | null;
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
    /** Indexer-reported claim data; recovery verifies claim and custody directly on chain. */
    readonly id: string;
    readonly settled: boolean;
    /** Claims without provenance remain visible but are not linked to supported on-chain recovery. */
    readonly deployment?: {
      readonly chain: string;
      readonly router: string;
      readonly revision: string;
    } | null;
  } | null;
  readonly proofRevision?: ProofRevision | null;
}

export interface TransfersResponse {
  readonly transfers: readonly FormattedTransfer[];
  readonly limit: number;
  readonly offset: number;
  readonly count: number;
  /** Keyset pagination fields are optional while older indexers still return offsets. */
  readonly cursor?: string | null;
  readonly nextCursor?: string | null;
  readonly previousCursor?: string | null;
  readonly hasMore?: boolean;
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

/** Normalize the current response and the original `data`-array response.
 * Missing optional evidence stays null; it is never inferred from another field.
 */
export function normalizeTransfersResponse(value: unknown): TransfersResponse {
  if (!value || typeof value !== "object")
    throw new Error("The transfer indexer returned invalid data.");
  const input = value as Record<string, unknown>;
  const rows = Array.isArray(input.transfers) ? input.transfers : input.data;
  if (!Array.isArray(rows)) throw new Error("The transfer indexer returned invalid data.");
  const transfers = rows.map((row) => {
    if (!row || typeof row !== "object")
      throw new Error("The transfer indexer returned an invalid record.");
    const transfer = row as Record<string, unknown>;
    const origin = transfer.origin;
    const destination = transfer.destination;
    if (!origin || typeof origin !== "object" || !destination || typeof destination !== "object")
      throw new Error("The transfer indexer returned an incomplete record.");
    return {
      ...transfer,
      origin: {
        ...origin,
        symbol: (origin as Record<string, unknown>).symbol ?? null,
        decimals: (origin as Record<string, unknown>).decimals ?? null,
      },
      destination: {
        ...destination,
        token: (destination as Record<string, unknown>).token ?? null,
        amount: (destination as Record<string, unknown>).amount ?? null,
        symbol: (destination as Record<string, unknown>).symbol ?? null,
        decimals: (destination as Record<string, unknown>).decimals ?? null,
        block: (destination as Record<string, unknown>).block ?? null,
        txHash: (destination as Record<string, unknown>).txHash ?? null,
        deliveredAt: (destination as Record<string, unknown>).deliveredAt ?? null,
      },
      rail: transfer.rail ?? null,
      claim: transfer.claim ?? null,
    } as FormattedTransfer;
  });
  return {
    ...input,
    transfers,
    limit: typeof input.limit === "number" ? input.limit : transfers.length,
    offset: typeof input.offset === "number" ? input.offset : 0,
    count: typeof input.count === "number" ? input.count : transfers.length,
    ...(input.coverage ? { coverage: input.coverage } : {}),
  };
}

export interface TransfersQuery {
  readonly originChain?: string;
  readonly destinationChain?: string;
  readonly route?: string;
  readonly sender?: string;
  readonly recipient?: string;
  readonly limit?: string;
  readonly offset?: string;
  readonly cursor?: string;
  readonly search?: string;
}

export interface TransferFilters {
  readonly asset?: string;
  readonly deployment?: string;
}

export function filterTransfers(
  transfers: readonly FormattedTransfer[],
  filters: TransferFilters,
): readonly FormattedTransfer[] {
  const asset = filters.asset?.trim();
  const deployment = filters.deployment?.trim();
  return transfers.filter((transfer) => {
    const assetMatches =
      !asset ||
      [transfer.origin.token, transfer.destination.token]
        .filter((value): value is string => Boolean(value))
        .some((value) =>
          /^0x/i.test(value) ? value.toLowerCase() === asset.toLowerCase() : value === asset,
        );
    const deploymentMatches =
      !deployment ||
      [transfer.origin.router, transfer.origin.revision]
        .filter((value): value is string => Boolean(value))
        .some((value) =>
          /^0x/i.test(value) || /^[0-9a-f]{64}$/i.test(value)
            ? value.toLowerCase() === deployment.toLowerCase()
            : value === deployment,
        );
    return assetMatches && deploymentMatches;
  });
}

export interface TransferRequestOptions {
  readonly signal?: AbortSignal | TransferRequestOptions;
}

interface CachedResponse {
  readonly etag: string;
  readonly value: unknown;
}

const responseCache = new Map<string, CachedResponse>();

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

function request<T>(path: string, notFoundIsNull?: false, signal?: AbortSignal | TransferRequestOptions): Promise<T>;
function request<T>(path: string, notFoundIsNull: true, signal?: AbortSignal | TransferRequestOptions): Promise<T | null>;
async function request<T>(
  path: string,
  notFoundIsNull = false,
  signal?: AbortSignal | TransferRequestOptions,
): Promise<T | null> {
  signal = signal && "signal" in signal ? signal.signal : signal as AbortSignal | undefined;
  const base = getApiBaseUrl();
  if (!base) throw new Error("Transfer history is unavailable: no indexer is configured.");
  const url = `${base}${path}`;
  const cached = responseCache.get(url);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cached) headers["If-None-Match"] = cached.etag;
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "The transfer indexer is unreachable. On-chain transfers and claims still work.",
    );
  }
  if (response.status === 304 && cached) return cached.value as T;
  if (response.status === 404 && notFoundIsNull) {
    responseCache.delete(url);
    return null;
  }
  if (!response.ok)
    throw new Error(
      `The transfer indexer returned HTTP ${response.status}. No sample records are shown.`,
    );
  const value = (await response.json()) as T;
  const etag = response.headers.get("ETag");
  if (etag) responseCache.set(url, { etag, value });
  else responseCache.delete(url);
  return value;
}

function params(query?: object): string {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {}))
    if (value !== undefined && value !== "") values.set(key, String(value));
  const encoded = values.toString();
  return encoded ? `?${encoded}` : "";
}
export async function fetchTransfers(
  query?: TransfersQuery,
  signal?: AbortSignal | TransferRequestOptions,
): Promise<TransfersResponse> {
  return normalizeTransfersResponse(await request<unknown>(`/v1/transfers${params(query)}`, false, signal));
}
export async function fetchClaims(query?: ClaimsQuery): Promise<ClaimsResponse> {
  return await request<ClaimsResponse>(`/v1/claims${params(query)}`);
}

export async function fetchIndexerMetrics(signal?: AbortSignal | TransferRequestOptions): Promise<IndexerMetrics> {
  return await request<IndexerMetrics>("/v1/metrics", false, signal);
}

export function fetchTransferByTx(
  hash: string,
  signal?: AbortSignal | TransferRequestOptions,
): Promise<FormattedTransfer | null> {
  if (!/^[0-9a-f]{64}$/i.test(hash))
    return Promise.reject(new Error("Enter a 64-character Stellar transaction hash."));
  return request<FormattedTransfer>(`/v1/transfers/by-tx/${hash.toLowerCase()}`, true, signal);
}

export async function fetchTransferEvidence(
  transfer: FormattedTransfer,
  signal?: AbortSignal | TransferRequestOptions,
): Promise<TransferProof> {
  if (!/^[1-9][0-9]{0,18}$/.test(transfer.id) || BigInt(transfer.id) > 9223372036854775807n)
    throw new Error("Detailed proof lookup is unavailable for this transfer identifier.");
  const value = await request<unknown>(`/v1/transfers/${transfer.id}/evidence`, false, signal);
  return parseTransferProof(value, transfer);
}

export interface ReconciliationResult {
  readonly reference: LocalTransferReference;
  readonly transfer: FormattedTransfer | null;
  readonly error: string | null;
}

export function localTransferMatches(
  reference: LocalTransferReference,
  record: FormattedTransfer,
): boolean {
  const checkpoint = reference.checkpoint;
  return (
    record.origin.chain === "stellar-testnet" &&
    record.origin.sender === checkpoint.account &&
    record.origin.txHash.toLowerCase() === checkpoint.txHash &&
    record.origin.token ===
      (checkpoint.token ?? (checkpoint.router === TESTNET.router ? TESTNET.token : "")) &&
    record.origin.router === checkpoint.router &&
    record.route === checkpoint.route &&
    record.destination.recipient.toLowerCase() === checkpoint.recipient.toLowerCase() &&
    record.destination.chain === destinationFor(checkpoint.destination).key
  );
}

/** Compatibility fallback: the current backend has by-tx reads, no bulk endpoint. */
export async function reconcileTransfers(
  account: string,
  references: readonly LocalTransferReference[],
  signal?: AbortSignal | TransferRequestOptions,
): Promise<ReconciliationResult[]> {
  const selected = references
    .filter(
      (ref) =>
        ref.checkpoint.account === account &&
        ref.checkpoint.stage === "bridge" &&
        /^[0-9a-f]{64}$/.test(ref.checkpoint.txHash),
    )
    .filter(
      (ref, index, all) =>
        all.findIndex((other) => other.checkpoint.txHash === ref.checkpoint.txHash) === index,
    )
    .slice(0, 20);
  const results: ReconciliationResult[] = selected.map((reference) => ({
    reference,
    transfer: null,
    error: "Lookup pending.",
  }));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, selected.length) }, async () => {
      while (next < selected.length) {
        const index = next++;
        const reference = selected[index];
        if (!reference) continue;
        try {
          if (signal?.aborted) throw new Error("Local source lookup cancelled.");
          const record = await fetchTransferByTx(reference.checkpoint.txHash, signal);
          const matches = record !== null && localTransferMatches(reference, record);
          results[index] = {
            reference,
            transfer: matches ? record : null,
            error:
              record && !matches
                ? "Indexer identity does not match this local source reference."
                : null,
          };
        } catch (cause) {
          results[index] = {
            reference,
            transfer: null,
            error: cause instanceof Error ? cause.message : "Lookup failed.",
          };
        }
      }
    }),
  );
  return results;
}
