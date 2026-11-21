import {
  compareCheckpoints,
  exportCheckpoint,
  importCheckpoint,
  checkpointNetworkMatches,
  type TransferCheckpoint,
} from "../contracts/checkpoint";
import { resolveCheckpointTransaction } from "../contracts/stellar";

export interface RecoveryAudit {
  auditVersion: 1;
  checkedAt: string;
  comparison: "same" | "conflict";
  unresolved: boolean;
  records: {
    metadata: string;
    status: "confirmed" | "failed" | "unknown";
    source: "rpc" | "horizon" | "unknown";
  }[];
}

function publicAudit(value: unknown): RecoveryAudit | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.auditVersion !== 1 ||
    typeof candidate.checkedAt !== "string" ||
    candidate.checkedAt.length > 32 ||
    !Number.isFinite(Date.parse(candidate.checkedAt)) ||
    (candidate.comparison !== "same" && candidate.comparison !== "conflict") ||
    !Array.isArray(candidate.records) ||
    candidate.records.length < 1 ||
    candidate.records.length > 2
  )
    return null;
  const records: RecoveryAudit["records"] = [];
  for (const item of candidate.records as unknown[]) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.metadata !== "string" ||
      (record.status !== "confirmed" &&
        record.status !== "failed" &&
        record.status !== "unknown") ||
      (record.source !== "rpc" && record.source !== "horizon" && record.source !== "unknown")
    )
      return null;
    const metadata = importCheckpoint(record.metadata);
    if (!metadata) return null;
    records.push({
      metadata: exportCheckpoint(metadata),
      status: record.status,
      source: record.source,
    });
  }
  return {
    auditVersion: 1,
    checkedAt: candidate.checkedAt,
    comparison: candidate.comparison,
    unresolved: records.some((record) => record.status === "unknown"),
    records,
  };
}

/** Inspect each distinct record independently; a timestamp never selects a winning transaction. */
export async function reconcileCheckpointImport(
  raw: string,
  current: TransferCheckpoint,
  signal?: AbortSignal,
): Promise<RecoveryAudit> {
  const candidate = importCheckpoint(raw);
  if (!candidate)
    throw new Error("Invalid recovery export. Use a version 1 metadata file under 16 KB.");
  if (!checkpointNetworkMatches(current) || !checkpointNetworkMatches(candidate))
    throw new Error(
      "The recovery records belong to another network or deployment. Reconnect to their original deployment before checking.",
    );
  const comparison = compareCheckpoints(current, candidate);
  const records = await Promise.all(
    (comparison === "same" ? [current] : [current, candidate]).map(async (value) => {
      const result = await resolveCheckpointTransaction(value, signal);
      return { metadata: exportCheckpoint(value), status: result.status, source: result.source };
    }),
  );
  if (signal?.aborted) throw new DOMException("Recovery comparison cancelled.", "AbortError");
  return {
    auditVersion: 1,
    checkedAt: new Date().toISOString(),
    comparison,
    unresolved: records.some((record) => record.status === "unknown"),
    records,
  };
}

/** Append only freshly obtained, bounded public evidence; never write the pending checkpoint. */
export async function retainRecoveryAudit(audit: RecoveryAudit): Promise<void> {
  const projected = publicAudit(audit);
  if (!projected)
    throw new Error("The recovery audit is invalid. Your original checkpoint is unchanged.");
  const serialized = JSON.stringify(projected);
  if (serialized.length > 40000)
    throw new Error("The recovery audit exceeds its public metadata limit.");
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks)
    throw new Error(
      "This browser cannot preserve recovery audits. Download the checked public summary.",
    );
  await locks.request("hyperion.testnet.recovery-audit", () => {
    const key = "hyperion.testnet.recovery-audit";
    const raw = localStorage.getItem(key);
    let previous: unknown = [];
    try {
      previous = raw ? JSON.parse(raw) : [];
    } catch {
      /* A corrupt audit cannot change pending recovery. */
    }
    const bounded =
      Array.isArray(previous) && (raw?.length ?? 0) <= 320000
        ? (previous as unknown[]).slice(-7).flatMap((value) => {
            const clean = publicAudit(value);
            return clean ? [clean] : [];
          })
        : [];
    const next = JSON.stringify([...bounded, projected]);
    localStorage.setItem(key, next);
    if (localStorage.getItem(key) !== next)
      throw new Error("The public recovery audit did not persist. Download the checked summary.");
  });
}
