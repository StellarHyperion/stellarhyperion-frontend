import { useMemo, useSyncExternalStore } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { getClaimSettlementCheckpoint } from "./claim-checkpoint";
import {
  TESTNET,
  STELLAR_DEPLOYMENT,
  destinationFor,
  type BridgeRoute,
  type DestinationKey,
} from "../config/testnet";
import { stellarAsset, type SourceAsset } from "./assets";

export type CheckpointSource = Pick<SourceAsset, "id" | "code" | "issuer">;

export interface TransferCheckpoint {
  /** Versioned storage format. Legacy records migrate on a successful guarded write. */
  schemaVersion?: 1;
  /** Monotonic revision used to reject stale tab writers. */
  revision?: number;
  router: string;
  networkPassphrase?: string;
  chain?: string;
  deploymentCommit?: string;
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
const revisionKey = `${key}.revision`;
let memoryRevision = 0;
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
  const recoveryError = storageRecoveryError();
  if (recoveryError) throw new Error(recoveryError);
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
  if (!raw || raw.length > 16384) return null;
  try {
    const value = JSON.parse(raw) as {
      schemaVersion?: number;
      revision?: number;
      router: string;
      networkPassphrase?: string;
      chain?: string;
      deploymentCommit?: string;
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
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) return null;
    if (
      (value.schemaVersion === 1 &&
        (!Number.isSafeInteger(value.revision) || (value.revision ?? 0) <= 0)) ||
      (value.schemaVersion === undefined && value.revision !== undefined)
    )
      return null;
    if (
      typeof value.router !== "string" ||
      typeof value.account !== "string" ||
      typeof value.recipient !== "string" ||
      typeof value.bridgeAmount !== "string" ||
      typeof value.txHash !== "string" ||
      (value.networkPassphrase !== undefined &&
        (typeof value.networkPassphrase !== "string" || value.networkPassphrase.length > 256)) ||
      (value.chain !== undefined && (typeof value.chain !== "string" || value.chain.length > 64)) ||
      (value.deploymentCommit !== undefined &&
        (typeof value.deploymentCommit !== "string" ||
          !/^[0-9a-f]{7,40}$/i.test(value.deploymentCommit))) ||
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
    const { schemaVersion, revision } = value;
    return {
      router: value.router,
      ...(value.networkPassphrase === undefined
        ? {}
        : { networkPassphrase: value.networkPassphrase }),
      ...(value.chain === undefined ? {} : { chain: value.chain }),
      ...(value.deploymentCommit === undefined ? {} : { deploymentCommit: value.deploymentCommit }),
      ...(schemaVersion === undefined ? {} : { schemaVersion: 1 as const }),
      ...(revision === undefined ? {} : { revision }),
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

/** Legacy records still require independently checked Testnet transaction evidence. */
export function checkpointNetworkMatches(value: TransferCheckpoint): boolean {
  return (
    value.router === TESTNET.router &&
    (value.token === undefined || value.token === TESTNET.token) &&
    (value.networkPassphrase === undefined ||
      value.networkPassphrase === TESTNET.networkPassphrase) &&
    (value.chain === undefined || value.chain === "stellar-testnet") &&
    (value.deploymentCommit === undefined ||
      value.deploymentCommit === STELLAR_DEPLOYMENT.deploymentCommit)
  );
}

export type CheckpointComparison = "same" | "conflict";
export function compareCheckpoints(
  left: TransferCheckpoint,
  right: TransferCheckpoint,
): CheckpointComparison {
  // Neither a matching hash nor a conversion/bridge stage pair establishes matching evidence.
  return checkpointIdentity(left) === checkpointIdentity(right) ? "same" : "conflict";
}

/** Project an explicit allowlist; imported status and extra payloads never establish confirmation. */
export function exportCheckpoint(value: TransferCheckpoint): string {
  const publicValue = parseCheckpoint(
    JSON.stringify({
      schemaVersion: value.schemaVersion,
      revision: value.revision,
      router: value.router,
      token: value.token,
      account: value.account,
      recipient: value.recipient,
      destination: value.destination,
      route: value.route,
      bridgeAmount: value.bridgeAmount,
      stage: value.stage,
      txHash: value.txHash,
      source: value.source,
      networkPassphrase: value.networkPassphrase,
      chain: value.chain,
      deploymentCommit: value.deploymentCommit,
    }),
  );
  if (!publicValue)
    throw new Error("Recovery metadata is invalid. The saved checkpoint is unchanged.");
  return JSON.stringify({ exportVersion: 1, sourceStatus: "unknown", ...publicValue });
}

/** Read-only candidate: callers must check network, envelope and result before accepting evidence. */
export function importCheckpoint(raw: string): TransferCheckpoint | null {
  if (raw.length > 16384) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      !("exportVersion" in value) ||
      value.exportVersion !== 1
    )
      return null;
    return parseCheckpoint(raw);
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
    checkpointNetworkMatches(checkpoint) &&
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
    checkpoint.networkPassphrase ?? TESTNET.networkPassphrase,
    checkpoint.chain ?? "stellar-testnet",
    checkpoint.deploymentCommit ?? STELLAR_DEPLOYMENT.deploymentCommit,
    checkpoint.token ?? TESTNET.token,
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
let checkpointLockHeld = false;

function storageRecoveryError(): string | null {
  if (checkpointPersistenceFailed)
    return "Recovery storage failed. Keep this tab open and retain the signed hash. Restore browser storage before continuing.";
  let raw: string | null;
  try {
    raw = typeof localStorage === "undefined" ? memoryCheckpoint : localStorage.getItem(key);
  } catch {
    return "Recovery storage cannot be read. Keep the saved transaction and restore browser storage before signing.";
  }
  if (!raw) return null;
  const parsed = parseCheckpoint(raw);
  if (parsed)
    return checkpointNetworkMatches(parsed)
      ? null
      : "This saved transaction belongs to another network or router deployment. Reconnect to its original deployment; its exact checkpoint is preserved.";
  try {
    const record = JSON.parse(raw) as {
      schemaVersion?: unknown;
      router?: unknown;
      token?: unknown;
    } | null;
    if (
      record &&
      ((typeof record.router === "string" && record.router !== TESTNET.router) ||
        (typeof record.token === "string" && record.token !== TESTNET.token))
    )
      return "This saved transaction belongs to another router or token deployment. Reconnect to its original deployment; its exact checkpoint is preserved.";
    if (record?.schemaVersion !== undefined && record.schemaVersion !== 1)
      return "This saved transaction uses an unsupported recovery version. Keep its data and open it with the compatible app before signing another transaction.";
  } catch {
    /* Malformed unresolved records must remain intact. */
  }
  return "The saved recovery record cannot be safely migrated. Keep its data and resolve the original transaction before signing another.";
}
export function useCheckpointStorageError(): string | null {
  return useSyncExternalStore(subscribe, storageRecoveryError, () => null);
}
function announceCheckpoint() {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(event));
  }
}

/** All browser mutations share one Web Lock, including recovery resets. */
export async function commitCheckpoint(
  value: TransferCheckpoint | null,
  expected?: TransferCheckpoint,
): Promise<TransferCheckpoint | null> {
  if (typeof window === "undefined") return saveCheckpoint(value, expected);
  const locks = (navigator as { locks?: LockManager }).locks;
  if (!locks)
    throw new Error(
      "This browser cannot coordinate recovery tabs. Use a supported browser before signing.",
    );
  return locks.request("hyperion.testnet.checkpoint-write", () => {
    checkpointLockHeld = true;
    try {
      return saveCheckpoint(value, expected);
    } finally {
      checkpointLockHeld = false;
    }
  });
}

export function saveCheckpoint(
  value: TransferCheckpoint | null,
  expected?: TransferCheckpoint,
): TransferCheckpoint | null {
  if (typeof window !== "undefined" && !checkpointLockHeld)
    throw new Error(
      "Recovery changes require the shared browser lock. No transaction was submitted.",
    );
  const raw = snapshot();
  if (checkpointPersistenceFailed && typeof localStorage !== "undefined") {
    let persisted: string | null;
    try {
      persisted = localStorage.getItem(key);
    } catch {
      throw new Error("Recovery storage cannot be read. Keep the signed transaction.");
    }
    if (persisted && persisted !== memoryCheckpoint)
      throw new Error(
        "Recovery storage and the retained signed hash conflict. Keep both records and resolve their outcomes before continuing.",
      );
  }
  const existing = parseCheckpoint(raw);
  if (raw && !existing)
    throw new Error(
      storageRecoveryError() ?? "The saved recovery record cannot be safely migrated.",
    );
  if (value && !parseCheckpoint(JSON.stringify(value)))
    throw new Error("Invalid recovery data. No transaction was submitted.");
  if (
    (existing && !checkpointNetworkMatches(existing)) ||
    (value && !checkpointNetworkMatches(value))
  )
    throw new Error(
      "The saved transaction belongs to another network or deployment. Its checkpoint was preserved.",
    );
  if (
    expected &&
    (!existing ||
      checkpointIdentity(existing) !== checkpointIdentity(expected) ||
      (existing.revision ?? 0) !== (expected.revision ?? 0))
  )
    throw new Error("The pending transaction changed in another tab. Check its current outcome.");
  if (
    existing &&
    !expected &&
    (!value || checkpointIdentity(value) !== checkpointIdentity(existing))
  )
    throw new Error(
      "A previous transaction remains pending. Read its latest revision before changing it.",
    );
  // Progress/account-switch callbacks can repeat the same signed checkpoint safely.
  if (
    !checkpointPersistenceFailed &&
    existing &&
    value &&
    checkpointIdentity(value) === checkpointIdentity(existing)
  )
    return existing;
  let committedRevision = memoryRevision;
  if (typeof localStorage !== "undefined") {
    const storedRevision = localStorage.getItem(revisionKey);
    if (storedRevision !== null) {
      if (!/^\d+$/.test(storedRevision) || !Number.isSafeInteger(Number(storedRevision)))
        throw new Error(
          "Recovery revision data is invalid. Keep the original record before continuing.",
        );
      committedRevision = Number(storedRevision);
    } else committedRevision = 0;
  }
  const revision = Math.max(committedRevision, existing?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision))
    throw new Error("Recovery revision exhausted. Keep the original record before continuing.");
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
  const next = value
    ? existing && checkpointIdentity(value) === checkpointIdentity(existing)
      ? existing
      : { ...value, schemaVersion: 1 as const, revision }
    : null;
  if (next) memoryCheckpoint = JSON.stringify(next);
  try {
    if (typeof window !== "undefined" && typeof localStorage === "undefined")
      throw new Error("Transaction recovery storage is unavailable.");
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(revisionKey, String(revision));
      if (localStorage.getItem(revisionKey) !== String(revision))
        throw new Error("Recovery revision did not persist.");
      if (next) {
        const serialized = JSON.stringify(next);
        localStorage.setItem(key, serialized);
        if (localStorage.getItem(key) !== serialized)
          throw new Error("Recovery checkpoint did not persist.");
      } else {
        localStorage.removeItem(key);
        if (localStorage.getItem(key) !== null)
          throw new Error("Recovery checkpoint was not removed.");
      }
    }
    memoryRevision = revision;
    checkpointPersistenceFailed = false;
  } catch {
    checkpointPersistenceFailed = true;
    announceCheckpoint();
    throw new Error("Browser storage is unavailable. The next transaction was not submitted.");
  }
  if (!next) memoryCheckpoint = null;
  announceCheckpoint();
  return next;
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
  expected?: TransferCheckpoint,
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
  if (!StrKey.isValidEd25519PublicKey(ownership.account))
    throw new Error("Invalid account ownership. Reconnect the original wallet before signing.");
  return new Promise<OperationLease>((resolve, reject) => {
    void locks
      .request("hyperion.testnet.transfer-signing", { ifAvailable: true }, async (globalLock) => {
        if (!globalLock)
          throw new Error("Another tab is signing. Finish or recover it before trying again.");
        await locks.request(
          `hyperion.testnet.account.${ownership.account}`,
          { ifAvailable: true },
          async (accountLock) => {
            if (!accountLock)
              throw new Error(
                "Another tab owns this account. Finish or recover its transfer before signing.",
              );
            const recoveryError = storageRecoveryError();
            if (recoveryError) throw new Error(recoveryError);
            if (getClaimSettlementCheckpoint())
              throw new Error(
                "A signed claim settlement is unresolved. Check it before another transfer.",
              );
            const checkpoint = getTransferCheckpoint();
            if (expected) {
              if (
                !checkpoint ||
                expected.stage !== "conversion" ||
                ownership.stage !== "bridge" ||
                !checkpointNetworkMatches(expected) ||
                checkpointIdentity(checkpoint) !== checkpointIdentity(expected) ||
                (checkpoint.revision ?? 0) !== (expected.revision ?? 0) ||
                !checkpointMatches(expected, {
                  ...ownership,
                  stage: "conversion",
                  source: expected.source,
                })
              )
                throw new Error(
                  "The original conversion checkpoint changed. Check its outcome before continuing.",
                );
            } else if (checkpoint) {
              throw new Error(
                `A signed transfer is unresolved (checkpoint ${checkpoint.txHash}). Check its status before signing another transfer.`,
              );
            }
            // A released Web Lock proves the old tab no longer holds signing ownership.
            // Reclaim only ownership metadata; never clear or expire a signed checkpoint.
            let owner: OperationOwnership;
            ownershipLockHeld = true;
            try {
              owner = claimOperationOwnership(ownership);
            } finally {
              ownershipLockHeld = false;
            }
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
                try {
                  releaseOperationOwnership(owner.id);
                } finally {
                  release();
                }
              },
            });
            await held;
          },
        );
      })
      .catch(reject);
  });
}
let ownershipLockHeld = false;

export function parseOwnership(raw: string | null): OperationOwnership | null {
  if (!raw || raw.length > 4096) return null;
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
      value.id.length > 128 ||
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
      id: value.id,
      account: value.account,
      recipient: value.recipient,
      bridgeAmount: value.bridgeAmount,
      timestamp: value.timestamp,
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
    account: ownership.account,
    recipient: ownership.recipient,
    destination: ownership.destination,
    route: ownership.route,
    bridgeAmount: ownership.bridgeAmount,
    stage: ownership.stage,
    id,
    timestamp: ownership.timestamp ?? Date.now(),
  };
  if (!parseOwnership(JSON.stringify(record)))
    throw new Error("Invalid account ownership metadata. Review the transfer again.");
  const serialized = JSON.stringify(record);
  const storedOwnership =
    typeof localStorage !== "undefined" && typeof localStorage.getItem === "function"
      ? localStorage.getItem(ownershipKey)
      : memoryOwnership;
  const current = parseOwnership(storedOwnership);
  if (storedOwnership && !current)
    throw new Error(
      "Saved account ownership is invalid. Keep recovery data and restore this browser before signing.",
    );
  if (
    !ownershipLockHeld &&
    current &&
    current.id !== record.id &&
    Date.now() - current.timestamp < OWNERSHIP_TTL_MS
  ) {
    throw new Error(
      `Another tab owns this transfer (checkpoint ${current.id}). Finish or recover it before trying again.`,
    );
  }
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(ownershipKey, serialized);
      if (localStorage.getItem(ownershipKey) !== serialized)
        throw new Error("Ownership did not persist.");
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
