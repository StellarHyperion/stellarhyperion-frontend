import { useMemo, useSyncExternalStore } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import {
  TESTNET,
  archivedRouterFor,
  destinationFor,
  type BridgeRoute,
  type DestinationKey,
} from "../config/testnet";

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
      !StrKey.isValidEd25519PublicKey(value.router) ||
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
export function getTransferCheckpoint(): TransferCheckpoint | null {
  return parseCheckpoint(snapshot());
}
export function saveCheckpoint(value: TransferCheckpoint | null, expectedTxHash?: string) {
  const existing = parseCheckpoint(snapshot());
  if (!value && expectedTxHash && existing?.txHash !== expectedTxHash)
    throw new Error("The pending transaction changed in another tab. Check its current outcome.");
  if (value && existing) {
    const sameTransfer =
      existing.router === value.router &&
      existing.account === value.account &&
      existing.recipient === value.recipient &&
      existing.destination === value.destination &&
      existing.route === value.route &&
      existing.bridgeAmount === value.bridgeAmount;
    const sameTransaction = value.txHash === existing.txHash;
    const conversionContinuation =
      !archivedRouterFor(existing.router) &&
      existing.stage === "conversion" &&
      value.stage === "bridge" &&
      sameTransfer;
    if (
      !sameTransfer ||
      (sameTransaction && value.stage !== existing.stage) ||
      (!sameTransaction && !conversionContinuation)
    )
      throw new Error(
        "A previous transaction remains pending. Check its outcome before submitting another.",
      );
  }
  if (value) memoryCheckpoint = JSON.stringify(value);
  try {
    if (typeof localStorage !== "undefined") {
      if (value) localStorage.setItem(key, JSON.stringify(value));
      else localStorage.removeItem(key);
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
