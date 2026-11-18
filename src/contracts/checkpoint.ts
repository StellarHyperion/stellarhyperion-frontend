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
let memoryCheckpoint: string | null = null;
function snapshot(): string | null {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(key);
    }
    return memoryCheckpoint;
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
export function saveCheckpoint(value: TransferCheckpoint | null, force = false) {
  if (value && !force) {
    const existing = parseCheckpoint(snapshot());
    if (
      existing &&
      existing.txHash !== value.txHash &&
      !(
        existing.stage === "conversion" &&
        value.stage === "bridge" &&
        existing.account === value.account
      )
    ) {
      throw new Error(
        "An unknown previous transaction is pending. Previous submissions remain pending rather than replaced.",
      );
    }
  }
  const serialized = value ? JSON.stringify(value) : null;
  try {
    if (typeof localStorage !== "undefined") {
      if (serialized) localStorage.setItem(key, serialized);
      else localStorage.removeItem(key);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("remain pending")) throw error;
    throw new Error("Browser storage is unavailable. The next transaction was not submitted.");
  }
  memoryCheckpoint = serialized;
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
      typeof value.timestamp !== "number"
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
    /* browser storage unavailable */
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
