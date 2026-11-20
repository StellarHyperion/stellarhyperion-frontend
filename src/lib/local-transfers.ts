import { useSyncExternalStore } from "react";
import {
  checkpointIdentity,
  parseCheckpoint,
  type TransferCheckpoint,
} from "../contracts/checkpoint";

export interface LocalTransferReference {
  readonly checkpoint: TransferCheckpoint;
  readonly sourceStatus: "unknown" | "confirmed" | "failed";
}
const key = "hyperion.testnet.local-transfer-references";
const event = "hyperion:local-transfers";

function snapshot(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function parseLocalTransfers(raw: string | null): LocalTransferReference[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as { schemaVersion?: unknown; references?: unknown };
    if (value.schemaVersion !== 1 || !Array.isArray(value.references)) return [];
    const references: LocalTransferReference[] = [];
    for (const entry of (value.references as unknown[]).slice(0, 20)) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as { checkpoint?: unknown; sourceStatus?: unknown };
      const checkpoint = parseCheckpoint(JSON.stringify(candidate.checkpoint));
      if (
        checkpoint?.stage !== "bridge" ||
        (candidate.sourceStatus !== "unknown" &&
          candidate.sourceStatus !== "confirmed" &&
          candidate.sourceStatus !== "failed")
      )
        continue;
      if (
        references.some(
          (ref) =>
            ref.checkpoint.account === checkpoint.account &&
            ref.checkpoint.txHash === checkpoint.txHash,
        )
      )
        continue;
      references.push({ checkpoint, sourceStatus: candidate.sourceStatus });
    }
    return references;
  } catch {
    return [];
  }
}
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(event, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(event, listener);
  };
}
export function useLocalTransfers(): string | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** A local observation retains its public source reference; it never proves delivery. */
export async function rememberLocalTransfer(reference: LocalTransferReference): Promise<void> {
  if (reference.checkpoint.stage !== "bridge" || typeof window === "undefined") return;
  const locks = (navigator as { locks?: LockManager }).locks;
  if (!locks) throw new Error("Browser recovery coordination is unavailable.");
  await locks.request("hyperion.testnet.local-transfer-write", () => {
    const raw = snapshot();
    // Preserve unsupported/malformed journals rather than silently replacing them.
    if (raw) {
      const existing = JSON.parse(raw) as { schemaVersion?: unknown; references?: unknown };
      if (existing.schemaVersion !== 1 || !Array.isArray(existing.references))
        throw new Error("Saved local history cannot be safely migrated. Keep its original data.");
    }
    const previous = parseLocalTransfers(raw);
    const same = previous.find(
      (ref) =>
        ref.checkpoint.account === reference.checkpoint.account &&
        ref.checkpoint.txHash === reference.checkpoint.txHash,
    );
    if (same && checkpointIdentity(same.checkpoint) !== checkpointIdentity(reference.checkpoint))
      throw new Error("Local source identity changed. Keep the original reference.");
    // A later missing/error lookup cannot downgrade an observed source confirmation.
    const current = same && reference.sourceStatus === "unknown" ? same : reference;
    const references = [current, ...previous.filter((ref) => ref !== same)].slice(0, 20);
    const serialized = JSON.stringify({ schemaVersion: 1, references });
    localStorage.setItem(key, serialized);
    if (localStorage.getItem(key) !== serialized)
      throw new Error("Local source history did not persist. Keep the recovery checkpoint.");
    window.dispatchEvent(new Event(event));
  });
}
