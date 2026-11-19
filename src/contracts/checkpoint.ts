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
const key = "hyperion.testnet.pending-transfers";
const event = "hyperion:pending-transfer";
type CheckpointStore = Record<string, TransferCheckpoint>;

function checkpointKey(value: Pick<TransferCheckpoint, "router" | "account">): string {
  return `${value.router}:${value.account}`;
}
function readStore(): CheckpointStore {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(
        Object.values(parsed)
          .map((value) => parseCheckpointValue(value))
          .filter((value): value is TransferCheckpoint => value !== null)
          .map((value) => [checkpointKey(value), value]),
      );
    }
    // Migrate the pre-account-scoped single checkpoint without dropping it.
    const legacy = localStorage.getItem("hyperion.testnet.pending-transfer");
    const value = legacy ? parseCheckpointValue(JSON.parse(legacy)) : null;
    return value ? { [checkpointKey(value)]: value } : {};
  } catch {
    return {};
  }
}
function snapshot(account?: string): string {
  const values = Object.values(readStore()).filter(
    (value) => !account || value.account === account,
  );
  return JSON.stringify(values);
}
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(event, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(event, listener);
  };
}
function parseCheckpointValue(value: unknown): TransferCheckpoint | null {
  try {
    if (!value || typeof value !== "object") return null;
    const input = value as {
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
      input.router !== TESTNET.router ||
      !StrKey.isValidEd25519PublicKey(input.account) ||
      !/^0x[0-9a-fA-F]{40}$/.test(input.recipient) ||
      /^0x0{40}$/.test(input.recipient) ||
      !/^[0-9a-f]{64}$/.test(input.txHash) ||
      !/^\d+$/.test(input.bridgeAmount) ||
      BigInt(input.bridgeAmount) <= 0n ||
      (input.route !== 0 && input.route !== 1) ||
      (input.stage !== "conversion" && input.stage !== "bridge")
    )
      return null;
    destinationFor(input.destination);
    return {
      ...input,
      destination: destinationFor(input.destination).key,
      route: input.route,
      stage: input.stage,
    };
  } catch {
    return null;
  }
}
export function parseCheckpoint(raw: string | null): TransferCheckpoint | null {
  if (!raw) return null;
  try {
    return parseCheckpointValue(JSON.parse(raw));
  } catch {
    return null;
  }
}
export function listCheckpoints(account?: string): TransferCheckpoint[] {
  return Object.values(readStore()).filter((value) => !account || value.account === account);
}
export function saveCheckpoint(value: TransferCheckpoint | null, account?: string) {
  try {
    const store = readStore();
    if (value) store[checkpointKey(value)] = value;
    else if (account) {
      for (const storedKey of Object.keys(store))
        if (store[storedKey]?.account === account) delete store[storedKey];
    } else localStorage.removeItem(key);
    if (value || account) localStorage.setItem(key, JSON.stringify(store));
  } catch {
    throw new Error("Browser storage is unavailable. The next transaction was not submitted.");
  }
  window.dispatchEvent(new Event(event));
}
export function useTransferCheckpoint(account?: string): TransferCheckpoint | null {
  const raw = useSyncExternalStore(
    subscribe,
    () => snapshot(account),
    () => "[]",
  );
  return useMemo(() => JSON.parse(raw)[0] ?? null, [raw]);
}
