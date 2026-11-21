import { afterEach, describe, expect, it, vi } from "vitest";
import { USDC, XLM } from "../src/contracts/assets";
import { TESTNET } from "../src/config/testnet";
import {
  checkpointForAsset,
  parseCheckpoint,
  saveCheckpoint,
  getTransferCheckpoint,
  type TransferCheckpoint,
} from "../src/contracts/checkpoint";

const checkpoint: TransferCheckpoint = {
  router: TESTNET.router,
  token: TESTNET.token,
  account: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  destination: "sepolia",
  route: 1,
  bridgeAmount: "9007199254740993123456789",
  stage: "bridge",
  txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  source: { id: XLM.id, code: XLM.code, issuer: XLM.issuer },
};

function required(value: TransferCheckpoint | null): TransferCheckpoint {
  if (!value) throw new Error("Expected saved checkpoint");
  return value;
}

function createStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  };
  return storage;
}

afterEach(() => {
  if (typeof localStorage !== "undefined") localStorage.clear();
  saveCheckpoint(null);
  vi.unstubAllGlobals();
});

describe("pending transfer checkpoints", () => {
  it("persists the actual hash, exact amount, and token identity for recovery after reload", () => {
    const storage = createStorage();
    vi.stubGlobal("localStorage", storage);

    saveCheckpoint(checkpoint);

    expect(parseCheckpoint(storage.getItem("hyperion.testnet.pending-transfer"))).toEqual({
      ...checkpoint,
      schemaVersion: 1,
      revision: 1,
    });
  });

  it("retains a legacy conversion hash without guessing its original source asset", () => {
    const legacy = { ...checkpoint, stage: "conversion" as const, source: undefined };
    const parsed = parseCheckpoint(JSON.stringify(legacy));
    expect(parsed).toEqual(legacy);
    expect(checkpointForAsset(parsed, XLM)).toBeNull();
  });

  it("keeps a saved original intent when a newly selected asset does not match it", () => {
    const storage = createStorage();
    vi.stubGlobal("localStorage", storage);
    const original = {
      ...checkpoint,
      stage: "conversion" as const,
      source: {
        id: XLM.id,
        code: XLM.code,
        issuer: XLM.issuer,
      },
    };
    saveCheckpoint(original);
    expect(checkpointForAsset(original, USDC)).toBeNull();
    expect(checkpointForAsset(original, { ...XLM, code: "OTHER" })).toBeNull();
    expect(parseCheckpoint(storage.getItem("hyperion.testnet.pending-transfer"))).toEqual({
      ...original,
      schemaVersion: 1,
      revision: 1,
    });
    expect(() => {
      saveCheckpoint({ ...original, source: USDC });
    }).toThrow("previous transaction");
    expect(() => {
      saveCheckpoint({ ...original, stage: "bridge", txHash: "b".repeat(64), source: USDC });
    }).toThrow("previous transaction");
    expect(parseCheckpoint(storage.getItem("hyperion.testnet.pending-transfer"))).toEqual({
      ...original,
      schemaVersion: 1,
      revision: 1,
    });
  });

  it("refuses a stale reset after another tab changes the source binding for the same hash", () => {
    const storage = createStorage();
    vi.stubGlobal("localStorage", storage);
    const original = {
      ...checkpoint,
      stage: "conversion" as const,
      source: {
        id: XLM.id,
        code: XLM.code,
        issuer: XLM.issuer,
      },
    };
    saveCheckpoint(original);
    const changed = { ...original, source: { id: USDC.id, code: USDC.code, issuer: USDC.issuer } };
    storage.setItem("hyperion.testnet.pending-transfer", JSON.stringify(changed));
    expect(() => {
      saveCheckpoint(null, original);
    }).toThrow("changed in another tab");
    expect(parseCheckpoint(storage.getItem("hyperion.testnet.pending-transfer"))).toEqual(changed);
  });

  it("refuses a JSON numeric amount that has already lost integer precision", () => {
    expect(
      parseCheckpoint(
        JSON.stringify({ ...checkpoint, bridgeAmount: Number(checkpoint.bridgeAmount) }),
      ),
    ).toBeNull();
  });
  it("retains compatibility with existing checkpoints while rejecting a different token", () => {
    expect(parseCheckpoint(JSON.stringify({ ...checkpoint, token: undefined }))).toEqual(
      checkpoint,
    );
    expect(parseCheckpoint(JSON.stringify({ ...checkpoint, token: "different-token" }))).toBeNull();
  });

  it("preserves a pending hash's original router and token across deployment revisions", () => {
    const original = {
      ...checkpoint,
      router: TESTNET.token,
      token: TESTNET.router,
    };
    const parsed = required(parseCheckpoint(JSON.stringify(original)));
    expect(parsed.router).toBe(original.router);
    expect(parsed.token).toBe(original.token);
    expect(parsed.txHash).toBe(original.txHash);
    expect(JSON.parse(checkpointIdentity(parsed)).slice(0, 2)).toEqual([
      original.router,
      original.token,
    ]);
  });

  it("does not assign the new token to a legacy checkpoint from another router", () => {
    const legacy = { ...checkpoint, router: TESTNET.token, token: undefined };
    const parsed = required(parseCheckpoint(JSON.stringify(legacy)));
    expect(parsed.router).toBe(legacy.router);
    expect(parsed.token).toBeUndefined();
    expect(parsed.txHash).toBe(legacy.txHash);
  });

  it("preserves source transaction identity when promoting conversion recovery to bridge recovery", () => {
    const storage = createStorage();
    vi.stubGlobal("localStorage", storage);
    const conversion = { ...checkpoint, stage: "conversion" as const };
    saveCheckpoint(conversion);

    saveCheckpoint(
      { ...conversion, stage: "bridge", txHash: "a".repeat(64) },
      required(getTransferCheckpoint()),
    );

    expect(parseCheckpoint(storage.getItem("hyperion.testnet.pending-transfer"))).toMatchObject({
      ...conversion,
      schemaVersion: 1,
      revision: 2,
      stage: "bridge",
      txHash: "a".repeat(64),
    });
  });

  it("rejects a same-identity stale reset and preserves the latest committed revision", () => {
    const storage = createStorage();
    vi.stubGlobal("localStorage", storage);
    const original = required(saveCheckpoint(checkpoint));
    const latest = { ...original, revision: 2 };
    storage.setItem("hyperion.testnet.pending-transfer", JSON.stringify(latest));
    expect(() => saveCheckpoint(null, original)).toThrow("changed in another tab");
    expect(getTransferCheckpoint()).toEqual(latest);
  });

  it("rejects an old revision even after clearing and restoring the identical signed hash", () => {
    vi.stubGlobal("localStorage", createStorage());
    const saved = required(saveCheckpoint(checkpoint));
    saveCheckpoint(null, saved);
    const restored = required(saveCheckpoint(checkpoint));
    expect(restored.revision).toBe(3);
    expect(() => saveCheckpoint(null, saved)).toThrow("changed in another tab");
    expect(getTransferCheckpoint()).toEqual(restored);
  });

  it("does not increment revisions for repeated signed progress callbacks", () => {
    vi.stubGlobal("localStorage", createStorage());
    const saved = required(saveCheckpoint(checkpoint));
    expect(saveCheckpoint(checkpoint)).toEqual(saved);
    expect(getTransferCheckpoint()?.revision).toBe(1);
  });

  it("requires the current revision before promoting a conversion hash", () => {
    vi.stubGlobal("localStorage", createStorage());
    const saved = required(saveCheckpoint({ ...checkpoint, stage: "conversion" }));
    expect(() => saveCheckpoint({ ...checkpoint, txHash: "b".repeat(64) })).toThrow(
      "latest revision",
    );
    expect(getTransferCheckpoint()).toEqual(saved);
  });

  it.each([2, "1", null])(
    "retains an unsupported version %s instead of replacing or clearing it",
    (schemaVersion) => {
      const storage = createStorage();
      vi.stubGlobal("localStorage", storage);
      const raw = JSON.stringify({ ...checkpoint, schemaVersion, revision: 1 });
      storage.setItem("hyperion.testnet.pending-transfer", raw);
      expect(parseCheckpoint(raw)).toBeNull();
      expect(() => saveCheckpoint(checkpoint)).toThrow("unsupported recovery version");
      expect(() => saveCheckpoint(null)).toThrow("unsupported recovery version");
      expect(storage.getItem("hyperion.testnet.pending-transfer")).toBe(raw);
    },
  );

  it.each([undefined, 0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid versioned revision %s without guessing",
    (revision) => {
      expect(
        parseCheckpoint(JSON.stringify({ ...checkpoint, schemaVersion: 1, revision })),
      ).toBeNull();
    },
  );

  it("migrates a valid legacy record only on a guarded successful mutation", () => {
    const storage = createStorage();
    vi.stubGlobal("localStorage", storage);
    const legacy = { ...checkpoint, stage: "conversion" as const };
    const raw = JSON.stringify(legacy);
    storage.setItem("hyperion.testnet.pending-transfer", raw);
    expect(getTransferCheckpoint()).toEqual(legacy);
    expect(storage.getItem("hyperion.testnet.pending-transfer")).toBe(raw);
    const next = required(
      saveCheckpoint({ ...legacy, stage: "bridge", txHash: "b".repeat(64) }, legacy),
    );
    expect(next).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      account: legacy.account,
      recipient: legacy.recipient,
      bridgeAmount: legacy.bridgeAmount,
    });
  });
});
