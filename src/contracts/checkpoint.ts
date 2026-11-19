import { useMemo, useSyncExternalStore } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { TESTNET, destinationFor, type BridgeRoute, type DestinationKey } from "../config/testnet";

export interface TransferCheckpoint {
  router: string;
  account: string;
  recipient: string;
  destination: DestinationKey;
  route: BridgeRoute;
  bridgeAmount: string;
  stage: "conversion" | "bridge";
  txHash: string;
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
export function parseCheckpoint(raw: string | null): TransferCheckpoint | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as {
      router: string;
      account: string;
      recipient: string;
      destination: string;
      route: number;
      bridgeAmount: string;
      stage: string;
      txHash: string;
    };
    if (
      value.router !== TESTNET.router ||
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

// Returns true only when the checkpoint still describes the same account, destination, route,
// amount and intent as the current session. A different account or intent means a saved
// confirmation must never be reapplied to a new transfer.
export function checkpointMatches(
  checkpoint: TransferCheckpoint,
  context: Pick<TransferCheckpoint, "account" | "destination" | "route" | "bridgeAmount" | "stage">,
): boolean {
  return (
    checkpoint.account === context.account &&
    checkpoint.destination === context.destination &&
    checkpoint.route === context.route &&
    checkpoint.bridgeAmount === context.bridgeAmount &&
    checkpoint.stage === context.stage
  );
}
export function saveCheckpoint(value: TransferCheckpoint | null) {
  const existing = parseCheckpoint(snapshot());
  if (
    value &&
    existing &&
    value.txHash !== existing.txHash &&
    !(
      existing.stage === "conversion" &&
      value.stage === "bridge" &&
      existing.account === value.account &&
      existing.recipient === value.recipient &&
      existing.destination === value.destination &&
      existing.route === value.route &&
      existing.bridgeAmount === value.bridgeAmount
    )
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
