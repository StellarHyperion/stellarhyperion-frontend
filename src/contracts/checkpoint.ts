import { useMemo, useSyncExternalStore } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { getClaimSettlementCheckpoint } from "./claim-checkpoint";
import { TESTNET, destinationFor, type BridgeRoute, type DestinationKey } from "../config/testnet";
import { stellarAsset, type SourceAsset } from "./assets";

export type CheckpointSource = Pick<SourceAsset, "id" | "code" | "issuer">;

export interface TransferCheckpoint {
  router: string;
  token?: string;
  account: string;
  recipient: string;
  destination: DestinationKey;
  route: BridgeRoute;
  bridgeAmount: string;
  stage: "conversion" | "bridge";
  txHash: string;
  /** The exact source asset (code + issuer) this recovery data was converted from. */
  source?: CheckpointSource;
}
const key = "hyperion.testnet.pending-transfer";
const event = "hyperion:pending-transfer";
let probeGeneration = 0;
export interface CheckpointStorageDiagnostics {
  readonly available: boolean;
  readonly persistent: boolean | null;
  readonly kind: "transaction-recovery";
  readonly reason: string | null;
}

export function inspectCheckpointStorage(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): CheckpointStorageDiagnostics {
  const probeKey = `${key}.probe.${Date.now()}.${++probeGeneration}.${Math.random().toString(36).slice(2)}`;
  try {
    storage.setItem(probeKey, "ok");
    const retained = storage.getItem(probeKey) === "ok";
    storage.removeItem(probeKey);
    return {
      available: retained,
      persistent: retained ? null : false,
      kind: "transaction-recovery",
      reason: retained ? null : "The browser did not retain the recovery probe.",
    };
  } catch {
    return {
      available: false,
      persistent: false,
      kind: "transaction-recovery",
      reason: "Browser recovery storage is blocked or full.",
    };
  } finally {
    try {
      storage.removeItem(probeKey);
    } catch {
      /* Storage failure is reported above. */
    }
  }
}

export function assertCheckpointStorage(): void {
  if (typeof window === "undefined")
    throw new Error("Transaction recovery storage is unavailable.");
  let diagnostics: CheckpointStorageDiagnostics;
  try {
    diagnostics = inspectCheckpointStorage(window.localStorage);
  } catch {
    throw new Error(
      "Browser recovery storage is blocked. No transaction will be signed or broadcast.",
    );
  }
  if (!diagnostics.available)
    throw new Error(`${diagnostics.reason} No transaction will be signed or broadcast.`);
}
let memoryCheckpoint: string | null = null;
let checkpointPersistenceFailed = false;
function snapshot(): string | null {
  if (checkpointPersistenceFailed) return memoryCheckpoint;
  try {
    return typeof localStorage === "undefined" ? memoryCheckpoint : localStorage.getItem(key);
  } catch {
    return memoryCheckpoint;
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
/**
 * Validates and normalizes the source asset a checkpoint claims to have converted from.
 * Reuses `stellarAsset`'s identity checks so a checkpoint can never carry a corrupted or
 * spoofed code/issuer pairing: an invalid identity throws, which the caller treats as a
 * corrupted recovery record.
 */
function checkpointSource(value: unknown): CheckpointSource {
  if (!value || typeof value !== "object") throw new Error("Missing source asset.");
  const candidate = value as { id?: unknown; code?: unknown; issuer?: unknown };
  if (typeof candidate.id !== "string" || typeof candidate.code !== "string")
    throw new Error("Invalid source asset.");
  if (candidate.issuer !== null && typeof candidate.issuer !== "string")
    throw new Error("Invalid source asset issuer.");
  const source: CheckpointSource = {
    id: candidate.id,
    code: candidate.code,
    issuer: candidate.issuer,
  };
  stellarAsset(source);
  return source;
}
export function parseCheckpoint(raw: string | null): TransferCheckpoint | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as {
      router: string;
      token?: string;
      account: string;
      recipient: string;
      destination: string;
      route: number;
      bridgeAmount: string;
      stage: string;
      txHash: string;
      source?: unknown;
    };
    if (
      typeof value.router !== "string" ||
      typeof value.account !== "string" ||
      typeof value.recipient !== "string" ||
      typeof value.bridgeAmount !== "string" ||
      typeof value.txHash !== "string" ||
      value.router !== TESTNET.router ||
      (value.token !== undefined && value.token !== TESTNET.token) ||
      !StrKey.isValidEd25519PublicKey(value.account) ||
      !/^0x[0-9a-fA-F]{40}$/.test(value.recipient) ||
      /^0x0{40}$/.test(value.recipient) ||
      !/^[0-9a-f]{64}$/.test(value.txHash) ||
      !/^\d+$/.test(value.bridgeAmount) ||
      BigInt(value.bridgeAmount) <= 0n ||
      (value.route !== 0 && value.route !== 1) ||
      (value.stage !== "conversion" && value.stage !== "bridge")
    )
      return null;
    const source = value.source === undefined ? undefined : checkpointSource(value.source);
    destinationFor(value.destination);
    return {
      router: value.router,
      token: TESTNET.token,
      account: value.account,
      recipient: value.recipient,
      bridgeAmount: value.bridgeAmount,
      txHash: value.txHash,
      destination: destinationFor(value.destination).key,
      route: value.route,
      stage: value.stage,
      ...(source ? { source } : {}),
    };
  } catch {
    return null;
  }
}

// Returns true only when the checkpoint still describes the same account, destination, route,
// amount and intent as the current session. A different account or intent means a saved
// confirmation must never be reapplied to a new transfer.
export function checkpointMatches(
  checkpoint: TransferCheckpoint,
  context: Pick<
    TransferCheckpoint,
    "account" | "recipient" | "destination" | "route" | "bridgeAmount" | "stage" | "source"
  >,
): boolean {
  return (
    checkpoint.account === context.account &&
    checkpoint.recipient === context.recipient &&
    checkpointSourceIdentity(checkpoint.source) === checkpointSourceIdentity(context.source) &&
    checkpoint.destination === context.destination &&
    checkpoint.route === context.route &&
    checkpoint.bridgeAmount === context.bridgeAmount &&
    checkpoint.stage === context.stage
  );
}

/**
 * Decides whether existing recovery data still applies to a given source asset selection.
 * A checkpoint only ever belongs to the exact asset (code + issuer) it was converted from;
 * once the user selects a different asset, the previous intent's recovery data must not be
 * carried over, so this returns `null` instead of the stale checkpoint.
 */
export function checkpointForAsset(
  checkpoint: TransferCheckpoint | null,
  asset: CheckpointSource,
): TransferCheckpoint | null {
  if (!checkpoint?.source) return null;
  if (
    checkpoint.source.id !== asset.id ||
    checkpoint.source.code !== asset.code ||
    checkpoint.source.issuer !== asset.issuer
  )
    return null;
  return checkpoint;
}

export function getTransferCheckpoint(): TransferCheckpoint | null {
  return parseCheckpoint(snapshot());
}
function checkpointSourceIdentity(source: CheckpointSource | undefined): string {
  return JSON.stringify([source?.id ?? null, source?.code ?? null, source?.issuer ?? null]);
}
export function checkpointIdentity(checkpoint: TransferCheckpoint): string {
  return JSON.stringify([
    checkpoint.router,
    checkpoint.account,
    checkpoint.recipient,
    checkpoint.destination,
    checkpoint.route,
    checkpoint.bridgeAmount,
    checkpoint.stage,
    checkpoint.txHash,
    checkpoint.source?.id ?? null,
    checkpoint.source?.code ?? null,
    checkpoint.source?.issuer ?? null,
  ]);
}
export function saveCheckpoint(value: TransferCheckpoint | null, expected?: TransferCheckpoint) {
  const existing = parseCheckpoint(snapshot());
  if (expected && (!existing || checkpointIdentity(existing) !== checkpointIdentity(expected)))
    throw new Error("The pending transaction changed in another tab. Check its current outcome.");
  if (
    value &&
    existing &&
    ((value.txHash === existing.txHash &&
      checkpointIdentity(value) !== checkpointIdentity(existing)) ||
      (value.txHash !== existing.txHash &&
        !(
          existing.stage === "conversion" &&
          value.stage === "bridge" &&
          existing.account === value.account &&
          existing.recipient === value.recipient &&
          existing.destination === value.destination &&
          existing.route === value.route &&
          existing.bridgeAmount === value.bridgeAmount &&
          checkpointSourceIdentity(existing.source) === checkpointSourceIdentity(value.source)
        )))
  )
    throw new Error(
      "A previous transaction remains pending. Check its outcome before submitting another.",
    );
  if (value) memoryCheckpoint = JSON.stringify(value);
  try {
    if (typeof window !== "undefined" && typeof localStorage === "undefined")
      throw new Error("Transaction recovery storage is unavailable.");
    if (typeof localStorage !== "undefined") {
      if (value) {
        const serialized = JSON.stringify(value);
        localStorage.setItem(key, serialized);
        if (localStorage.getItem(key) !== serialized)
          throw new Error("Recovery checkpoint did not persist.");
      } else {
        localStorage.removeItem(key);
        if (localStorage.getItem(key) !== null)
          throw new Error("Recovery checkpoint was not removed.");
      }
    }
    checkpointPersistenceFailed = false;
  } catch {
    checkpointPersistenceFailed = true;
    throw new Error("Browser storage is unavailable. The next transaction was not submitted.");
  }
  if (!value) memoryCheckpoint = null;
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new Event(event));
    } catch {
      /* ignore */
    }
  }
}
export function useTransferCheckpoint(): TransferCheckpoint | null {
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  return useMemo(() => parseCheckpoint(raw), [raw]);
}

export {
  parseClaimSettlementCheckpoint,
  getClaimSettlementCheckpoint,
  saveClaimSettlementCheckpoint,
  useClaimSettlementCheckpoint,
  acquireClaimSettlementLease,
  claimSettlementIdentities,
  claimSettlementCheckpointIdentity,
  type ClaimSettlementCheckpoint,
  type ClaimSettlementIdentity,
} from "./claim-checkpoint";

export interface OperationOwnership {
  id: string;
  account: string;
  recipient: string;
  destination: DestinationKey;
  route: BridgeRoute;
  bridgeAmount: string;
  stage: "conversion" | "bridge";
  timestamp: number;
}
const ownershipKey = "hyperion.testnet.operation-ownership";
const ownershipEvent = "hyperion:operation-ownership";

let memoryOwnership: string | null = null;
const OWNERSHIP_TTL_MS = 15 * 60 * 1000;

export interface OperationLease extends OperationOwnership {
  release(): void;
}

/** Hold the browser's cross-tab lock until signing and broadcast have finished. */
export async function acquireOperationOwnership(
  ownership: Parameters<typeof claimOperationOwnership>[0],
): Promise<OperationLease> {
  if (typeof window === "undefined") {
    const owner = claimOperationOwnership(ownership);
    return {
      ...owner,
      release: () => {
        releaseOperationOwnership(owner.id);
      },
    };
  }
  const locks = (navigator as { locks?: LockManager }).locks;
  if (!locks) {
    throw new Error(
      "This browser cannot coordinate transfer tabs. Use a supported browser before signing.",
    );
  }
  return new Promise<OperationLease>((resolve, reject) => {
    void locks
      .request("hyperion.testnet.transfer-signing", { ifAvailable: true }, async (lock) => {
        if (!lock) {
          const current = getOperationOwnership();
          throw new Error(
            `Another tab owns this transfer (checkpoint ${current?.id ?? "unavailable"}). Finish or recover it before trying again.`,
          );
        }
        if (getClaimSettlementCheckpoint())
          throw new Error(
            "A signed claim settlement is unresolved. Check it before another transfer.",
          );
        const checkpoint = getTransferCheckpoint();
        if (checkpoint) {
          throw new Error(
            `A signed transfer is unresolved (checkpoint ${checkpoint.txHash}). Check its status before signing another transfer.`,
          );
        }
        const owner = claimOperationOwnership(ownership);
        let release!: () => void;
        const held = new Promise<void>((done) => {
          release = done;
        });
        let released = false;
        resolve({
          ...owner,
          release: () => {
            if (released) return;
            released = true;
            releaseOperationOwnership(owner.id);
            release();
          },
        });
        await held;
      })
      .catch(reject);
  });
}

export function parseOwnership(raw: string | null): OperationOwnership | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as {
      id: string;
      account: string;
      recipient: string;
      destination: string;
      route: number;
      bridgeAmount: string;
      stage: string;
      timestamp: number;
    };
    if (
      typeof value.id !== "string" ||
      !value.id ||
      !StrKey.isValidEd25519PublicKey(value.account) ||
      !/^0x[0-9a-fA-F]{40}$/.test(value.recipient) ||
      /^0x0{40}$/.test(value.recipient) ||
      !/^\d+$/.test(value.bridgeAmount) ||
      BigInt(value.bridgeAmount) <= 0n ||
      (value.route !== 0 && value.route !== 1) ||
      (value.stage !== "conversion" && value.stage !== "bridge") ||
      !Number.isSafeInteger(value.timestamp) ||
      value.timestamp < 0
    ) {
      return null;
    }
    destinationFor(value.destination);
    return {
      ...value,
      destination: destinationFor(value.destination).key,
      route: value.route,
      stage: value.stage,
    };
  } catch {
    return null;
  }
}

export function getOperationOwnership(): OperationOwnership | null {
  try {
    if (typeof localStorage !== "undefined") {
      return parseOwnership(localStorage.getItem(ownershipKey));
    }
    return parseOwnership(memoryOwnership);
  } catch {
    return parseOwnership(memoryOwnership);
  }
}

export function claimOperationOwnership(
  ownership: Omit<OperationOwnership, "id" | "timestamp"> & {
    id?: string;
    timestamp?: number;
  },
): OperationOwnership {
  if (typeof window !== "undefined" && typeof localStorage === "undefined")
    throw new Error("Browser storage is unavailable. Review the transfer again before signing.");
  const id =
    ownership.id ??
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  const record: OperationOwnership = {
    ...ownership,
    id,
    timestamp: ownership.timestamp ?? Date.now(),
  };
  const serialized = JSON.stringify(record);
  const storedOwnership =
    typeof localStorage !== "undefined" && typeof localStorage.getItem === "function"
      ? localStorage.getItem(ownershipKey)
      : memoryOwnership;
  const current = parseOwnership(storedOwnership);
  if (current && current.id !== record.id && Date.now() - current.timestamp < OWNERSHIP_TTL_MS) {
    throw new Error(
      `Another tab owns this transfer (checkpoint ${current.id}). Finish or recover it before trying again.`,
    );
  }
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(ownershipKey, serialized);
    }
  } catch {
    throw new Error("Browser storage is unavailable. Review the transfer again before signing.");
  }
  memoryOwnership = serialized;
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new Event(ownershipEvent));
    } catch {
      /* ignore */
    }
  }
  return record;
}

export function releaseOperationOwnership(id?: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      if (id) {
        const current = parseOwnership(localStorage.getItem(ownershipKey));
        if (current && current.id !== id) return;
      }
      localStorage.removeItem(ownershipKey);
    }
  } catch {
    /* browser storage unavailable */
  }
  if (!id || (memoryOwnership && parseOwnership(memoryOwnership)?.id === id)) {
    memoryOwnership = null;
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new Event(ownershipEvent));
    } catch {
      /* ignore */
    }
  }
}
