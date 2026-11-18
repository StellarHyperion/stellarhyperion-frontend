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
const probeKey = `${key}.probe`;
export interface CheckpointStorageDiagnostics {
  readonly available: boolean;
  readonly persistent: boolean;
  readonly kind: "transaction-recovery";
  readonly reason: string | null;
}

export function inspectCheckpointStorage(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): CheckpointStorageDiagnostics {
  try {
    storage.setItem(probeKey, "ok");
    const persistent = storage.getItem(probeKey) === "ok";
    storage.removeItem(probeKey);
    return {
      available: persistent,
      persistent,
      kind: "transaction-recovery",
      reason: persistent ? null : "The browser did not retain the recovery probe.",
    };
  } catch {
    return {
      available: false,
      persistent: false,
      kind: "transaction-recovery",
      reason: "Browser recovery storage is blocked or full.",
    };
  }
}

export function assertCheckpointStorage(): void {
  if (typeof window === "undefined") throw new Error("Transaction recovery storage is unavailable.");
  const diagnostics = inspectCheckpointStorage(window.localStorage);
  if (!diagnostics.available)
    throw new Error(`${diagnostics.reason} No transaction will be signed or broadcast.`);
}
function snapshot(): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
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
export function saveCheckpoint(value: TransferCheckpoint | null) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    throw new Error("Browser storage is unavailable. The next transaction was not submitted.");
  }
  window.dispatchEvent(new Event(event));
}
export function useTransferCheckpoint(): TransferCheckpoint | null {
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  return useMemo(() => parseCheckpoint(raw), [raw]);
}
