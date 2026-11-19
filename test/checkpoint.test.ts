import { afterEach, describe, expect, it, vi } from "vitest";
import { USDC, XLM } from "../src/contracts/assets";
import { TESTNET } from "../src/config/testnet";
import {
  checkpointForAsset,
  parseCheckpoint,
  saveCheckpoint,
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
  saveCheckpoint(null);
  vi.unstubAllGlobals();
});

describe("pending transfer checkpoints", () => {
  it("persists the actual hash, exact amount, and token identity for recovery after reload", () => {
    const storage = createStorage();
    vi.stubGlobal("localStorage", storage);

    saveCheckpoint(checkpoint);

    expect(parseCheckpoint(storage.getItem("hyperion.testnet.pending-transfer"))).toEqual(
      checkpoint,
    );
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
    expect(parseCheckpoint(storage.getItem("hyperion.testnet.pending-transfer"))).toEqual(original);
    expect(() => {
      saveCheckpoint({ ...original, source: USDC });
    }).toThrow("previous transaction");
    expect(() => {
      saveCheckpoint({ ...original, stage: "bridge", txHash: "b".repeat(64), source: USDC });
    }).toThrow("previous transaction");
    expect(parseCheckpoint(storage.getItem("hyperion.testnet.pending-transfer"))).toEqual(original);
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

  it("preserves source transaction identity when promoting conversion recovery to bridge recovery", () => {
    const storage = createStorage();
    vi.stubGlobal("localStorage", storage);
    const conversion = { ...checkpoint, stage: "conversion" as const };
    saveCheckpoint(conversion);

    saveCheckpoint({ ...conversion, stage: "bridge", txHash: "a".repeat(64) });

    expect(parseCheckpoint(storage.getItem("hyperion.testnet.pending-transfer"))).toEqual({
      ...conversion,
      stage: "bridge",
      txHash: "a".repeat(64),
    });
  });
});
