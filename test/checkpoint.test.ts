import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTNET } from "../src/config/testnet";
import { XLM } from "../src/contracts/assets";
import {
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
