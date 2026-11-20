import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET } from "../src/config/testnet";
import {
  acquireOperationOwnership,
  commitCheckpoint,
  getTransferCheckpoint,
  acquireClaimSettlementLease,
  exportCheckpoint,
  importCheckpoint,
  compareCheckpoints,
  type TransferCheckpoint,
} from "../src/contracts/checkpoint";

const account = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(34)).publicKey();
const intent = {
  account,
  recipient: "0x" + "a".repeat(40),
  destination: "sepolia" as const,
  route: 1 as const,
  bridgeAmount: "10000000",
  stage: "bridge" as const,
};
const pending: TransferCheckpoint = {
  ...intent,
  router: TESTNET.router,
  token: TESTNET.token,
  txHash: "a".repeat(64),
};
const key = "hyperion.testnet.pending-transfer";
let values: Map<string, string>;
let held: Set<string>;
beforeEach(() => {
  values = new Map();
  held = new Set();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
  Object.defineProperty(window, "localStorage", { value: localStorage });
  vi.stubGlobal("navigator", {
    locks: {
      request: async (name: string, options: unknown, callback?: (lock: unknown) => unknown) => {
        const action = callback ?? (options as (lock: unknown) => unknown);
        if (held.has(name)) return action(null);
        held.add(name);
        try {
          return await action({ name });
        } finally {
          held.delete(name);
        }
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser account signing ownership and durable preconditions", () => {
  it("holds account and common signing locks and rejects the second tab without queueing a signature", async () => {
    const owner = await acquireOperationOwnership(intent);
    expect(held.has(`hyperion.testnet.account.${account}`)).toBe(true);
    expect(held.has("hyperion.testnet.transfer-signing")).toBe(true);
    await expect(acquireOperationOwnership(intent)).rejects.toThrow("Another tab is signing");
    owner.release();
    owner.release();
    await vi.waitFor(() => {
      expect(held.size).toBe(0);
    });
    const next = await acquireOperationOwnership(intent);
    next.release();
  });
  it("recovers abandoned ownership immediately without deleting an unknown signed hash", async () => {
    values.set(
      "hyperion.testnet.operation-ownership",
      JSON.stringify({ ...intent, id: "crashed-tab", timestamp: Date.now() }),
    );
    values.set(key, JSON.stringify(pending));
    const original = values.get(key);
    await expect(acquireOperationOwnership(intent)).rejects.toThrow(
      "signed transfer is unresolved",
    );
    expect(values.get(key)).toBe(original);
    values.delete(key); // The test models an independently resolved operation, never a lease expiry.
    const owner = await acquireOperationOwnership(intent);
    expect(owner.id).not.toBe("crashed-tab");
    owner.release();
  });
  it("serializes continuation and rejects wrong-account, stale-revision and substituted-hash recovery", async () => {
    const conversion = {
      ...pending,
      stage: "conversion" as const,
      schemaVersion: 1 as const,
      revision: 7,
    };
    values.set(key, JSON.stringify(conversion));
    for (const expected of [
      { ...conversion, revision: 6 },
      { ...conversion, txHash: "b".repeat(64) },
    ])
      await expect(acquireOperationOwnership(intent, expected)).rejects.toThrow(
        "checkpoint changed",
      );
    await expect(
      acquireOperationOwnership({ ...intent, account: TESTNET.reader }, conversion),
    ).rejects.toThrow("checkpoint changed");
    const owner = await acquireOperationOwnership(intent, conversion);
    await expect(acquireOperationOwnership(intent, conversion)).rejects.toThrow(
      "Another tab is signing",
    );
    expect(values.get(key)).toBe(JSON.stringify(conversion));
    owner.release();
  });
  it("blocks missing lock support and silently discarded ownership storage", async () => {
    vi.stubGlobal("navigator", {});
    await expect(acquireOperationOwnership(intent)).rejects.toThrow("supported browser");
  });
  it("blocks silent ownership write loss before granting signing permission", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    await expect(acquireOperationOwnership(intent)).rejects.toThrow("storage is unavailable");
  });
  it("preserves wrong-network records and rejects clearing, replacing or continuing them", async () => {
    const other = { ...pending, networkPassphrase: "other network" };
    values.set(key, JSON.stringify(other));
    await expect(commitCheckpoint(null, other)).rejects.toThrow("another network");
    await expect(acquireOperationOwnership(intent)).rejects.toThrow("another network");
    expect(getTransferCheckpoint()).toEqual(other);
    expect(values.get(key)).toBe(JSON.stringify(other));
  });
});

describe("claim settlement shares durable account preconditions", () => {
  it("blocks settlement while another tab owns signing or an unknown transfer remains", async () => {
    const owner = await acquireOperationOwnership(intent);
    await expect(acquireClaimSettlementLease(account)).rejects.toThrow("Another tab is signing");
    owner.release();
    await vi.waitFor(() => {
      expect(held.size).toBe(0);
    });
    values.set(key, JSON.stringify(pending));
    await expect(acquireClaimSettlementLease(account)).rejects.toThrow(
      "signed transfer is unresolved",
    );
    expect(values.get(key)).toBe(JSON.stringify(pending));
  });
});

describe("read-only public recovery projection", () => {
  it("omits executable, secret, signature, status and arbitrary nested fields while retaining exact public identity", () => {
    const exportValue = exportCheckpoint({
      ...pending,
      signature: "private-fixture",
      secret: "private-fixture",
      sourceStatus: "confirmed",
      command: "submit",
    } as TransferCheckpoint);
    expect(exportValue).not.toContain("private-fixture");
    expect(exportValue).not.toContain("signature");
    expect(exportValue).not.toContain("command");
    expect((JSON.parse(exportValue) as { sourceStatus: unknown }).sourceStatus).toBe("unknown");
    expect(importCheckpoint(exportValue)).toEqual(pending);
    expect(values.size).toBe(0);
  });
  it("rejects oversized/malformed/future imports without storage mutations and preserves actual network metadata", () => {
    expect(importCheckpoint(" ".repeat(16385))).toBeNull();
    expect(importCheckpoint("null")).toBeNull();
    expect(importCheckpoint(JSON.stringify({ exportVersion: 2, ...pending }))).toBeNull();
    const other = { ...pending, networkPassphrase: "other network" };
    expect(importCheckpoint(exportCheckpoint(other))).toEqual(other);
    expect(values.size).toBe(0);
  });
  it("treats same-hash changed intent, changed deployment and distinct conversion/bridge hashes as conflicts", () => {
    for (const other of [
      { ...pending, bridgeAmount: "20000000" },
      { ...pending, recipient: "0x" + "b".repeat(40) },
      { ...pending, networkPassphrase: "other" },
      { ...pending, stage: "conversion" as const, txHash: "b".repeat(64) },
    ])
      expect(compareCheckpoints(pending, other)).toBe("conflict");
    expect(compareCheckpoints(pending, { ...pending, revision: 8 })).toBe("same");
  });
});
