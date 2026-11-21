import { useMemo, useSyncExternalStore } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { assertCheckpointStorage, getTransferCheckpoint } from "./checkpoint";
import { TESTNET } from "../config/testnet";

export interface ClaimSettlementIdentity {
  claimId: string;
  recipient: string;
  token: string;
  amount: string;
}
export interface ClaimSettlementCheckpoint extends ClaimSettlementIdentity {
  router: string;
  account: string;
  txHash: string;
  /** New batch records retain each exact identity; old single-claim records remain readable. */
  claims?: readonly ClaimSettlementIdentity[];
  chain?: "stellar-testnet";
  deploymentHash?: string;
}
const key = "hyperion.testnet.pending-claim-settlement";
const event = "hyperion:pending-claim-settlement";
const unavailable = "!storage-unavailable:";
let memory: string | null = null;
let persistenceFailed = false;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validIdentity(value: unknown): value is ClaimSettlementIdentity {
  return (
    record(value) &&
    typeof value.claimId === "string" &&
    /^[1-9]\d{0,19}$/.test(value.claimId) &&
    BigInt(value.claimId) <= (1n << 64n) - 1n &&
    typeof value.recipient === "string" &&
    StrKey.isValidEd25519PublicKey(value.recipient) &&
    typeof value.token === "string" &&
    StrKey.isValidContract(value.token) &&
    typeof value.amount === "string" &&
    /^[1-9]\d{0,38}$/.test(value.amount) &&
    BigInt(value.amount) <= (1n << 127n) - 1n
  );
}
export function claimSettlementIdentities(
  checkpoint: ClaimSettlementCheckpoint,
): readonly ClaimSettlementIdentity[] {
  return checkpoint.claims ?? [checkpoint];
}
export function parseClaimSettlementCheckpoint(
  raw: string | null,
): ClaimSettlementCheckpoint | null {
  if (!raw || raw.length > 16384) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !record(value) ||
      value.router !== TESTNET.router ||
      typeof value.account !== "string" ||
      !StrKey.isValidEd25519PublicKey(value.account) ||
      typeof value.txHash !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(value.txHash) ||
      (value.chain !== undefined && value.chain !== "stellar-testnet") ||
      (value.deploymentHash !== undefined &&
        (typeof value.deploymentHash !== "string" || !/^[0-9a-f]{64}$/.test(value.deploymentHash)))
    )
      return null;
    const identities: unknown[] = Array.isArray(value.claims)
      ? value.claims
      : value.claims === undefined
        ? [
            {
              claimId: value.claimId,
              recipient: value.recipient,
              token: value.token,
              amount: value.amount,
            },
          ]
        : [];
    if (identities.length < 1 || identities.length > 20 || !identities.every(validIdentity))
      return null;
    const first = identities[0];
    if (
      !first ||
      new Set(identities.map((claim) => claim.claimId)).size !== identities.length ||
      value.claimId !== identities.map((claim) => claim.claimId).join(",") ||
      value.recipient !== first.recipient ||
      value.token !== first.token ||
      value.amount !== identities.reduce((sum, claim) => sum + BigInt(claim.amount), 0n).toString()
    )
      return null;
    return {
      router: value.router,
      account: value.account,
      txHash: value.txHash.toLowerCase(),
      claimId: identities.map((claim) => claim.claimId).join(","),
      recipient: first.recipient,
      token: first.token,
      amount: identities.reduce((sum, claim) => sum + BigInt(claim.amount), 0n).toString(),
      ...(value.claims === undefined ? {} : { claims: identities }),
      ...(value.chain === undefined ? {} : { chain: "stellar-testnet" as const }),
      ...(typeof value.deploymentHash === "string" ? { deploymentHash: value.deploymentHash } : {}),
    };
  } catch {
    return null;
  }
}
function snapshot(): string {
  if (persistenceFailed) return unavailable + (memory ?? "");
  try {
    if (typeof localStorage === "undefined") return unavailable + (memory ?? "");
    return localStorage.getItem(key) ?? "";
  } catch {
    return unavailable + (memory ?? "");
  }
}
function state(raw: string): {
  checkpoint: ClaimSettlementCheckpoint | null;
  blocked: string | null;
} {
  const blockedStorage = raw.startsWith(unavailable);
  const value = blockedStorage ? raw.slice(unavailable.length) : raw;
  const checkpoint = parseClaimSettlementCheckpoint(value);
  return {
    checkpoint,
    blocked: blockedStorage
      ? "Claim recovery storage is unavailable. No settlement will be signed or broadcast."
      : value && !checkpoint
        ? "Saved claim recovery data could not be verified. Keep its public hash and recover it before signing."
        : null,
  };
}
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(event, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(event, listener);
  };
}
function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(event));
}
export function useClaimSettlementCheckpoint() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "");
  return useMemo(() => state(raw), [raw]);
}
export function getClaimSettlementCheckpoint(): ClaimSettlementCheckpoint | null {
  const current = state(snapshot());
  if (current.blocked) throw new Error(current.blocked);
  return current.checkpoint;
}
export function claimSettlementCheckpointIdentity(value: ClaimSettlementCheckpoint): string {
  return JSON.stringify([
    value.router,
    value.account,
    value.txHash.toLowerCase(),
    value.chain ?? "stellar-testnet",
    value.deploymentHash ?? null,
    claimSettlementIdentities(value).map((claim) => [
      claim.claimId,
      claim.recipient,
      claim.token,
      claim.amount,
    ]),
  ]);
}
export function saveClaimSettlementCheckpoint(
  value: ClaimSettlementCheckpoint | null,
  expected?: ClaimSettlementCheckpoint,
): void {
  const current = getClaimSettlementCheckpoint();
  if (current) {
    const match = value ?? expected;
    if (
      !match ||
      claimSettlementCheckpointIdentity(current) !== claimSettlementCheckpointIdentity(match)
    )
      throw new Error("Another signed settlement is unresolved. Its checkpoint was preserved.");
  } else if (!value && expected) {
    return;
  }
  const serialized = value ? JSON.stringify(value) : null;
  if (serialized && !parseClaimSettlementCheckpoint(serialized))
    throw new Error("The signed claim identity could not be saved. Nothing was broadcast.");
  try {
    if (typeof localStorage === "undefined") throw new Error("Storage unavailable");
    if (serialized) {
      memory = serialized;
      localStorage.setItem(key, serialized);
    } else localStorage.removeItem(key);
    if (localStorage.getItem(key) !== serialized)
      throw new Error("Storage did not retain recovery");
    memory = serialized;
    persistenceFailed = false;
  } catch {
    persistenceFailed = true;
    throw new Error("Claim recovery storage is unavailable. Settlement was not broadcast.");
  } finally {
    notify();
  }
}
/** Hold the same account-operation lock used by bridge signing through settlement confirmation. */
export async function acquireClaimSettlementLease(
  account: string,
): Promise<{ release: () => void }> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks)
    throw new Error("This browser cannot coordinate settlement tabs. Signing is unavailable.");
  if (!StrKey.isValidEd25519PublicKey(account))
    throw new Error("Reconnect the original account before settling a claim.");
  return new Promise((resolve, reject) => {
    void locks
      .request("hyperion.testnet.transfer-signing", { ifAvailable: true }, async (lock) => {
        if (!lock)
          throw new Error("Another tab is signing. Finish or recover it before settlement.");
        await locks.request(
          `hyperion.testnet.account.${account}`,
          { ifAvailable: true },
          async (accountLock) => {
            if (!accountLock)
              throw new Error(
                "Another tab owns this account. Recover its operation before settling a claim.",
              );
            assertCheckpointStorage();
            if (getTransferCheckpoint())
              throw new Error(
                "A signed transfer is unresolved. Check its outcome before settling a claim.",
              );
            if (getClaimSettlementCheckpoint())
              throw new Error(
                "A signed settlement is unresolved. Check its outcome before signing again.",
              );
            let release!: () => void;
            const held = new Promise<void>((done) => {
              release = done;
            });
            resolve({ release });
            await held;
          },
        );
      })
      .catch(reject);
  });
}
