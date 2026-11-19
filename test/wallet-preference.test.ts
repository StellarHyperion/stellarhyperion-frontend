import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRecognizedWalletPreference,
  readWalletPreference,
  saveWalletPreference,
} from "../src/wallets/stellar/preference";

const walletKey = "hyperion.stellar.walletId";
const checkpointKey = "hyperion.testnet.pending-transfer";
const state = new Map<string, string>();
const storage = {
  getItem: vi.fn((key: string) => state.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => state.set(key, value)),
  removeItem: vi.fn((key: string) => state.delete(key)),
};

beforeEach(() => {
  state.clear();
  storage.getItem.mockReset().mockImplementation((key) => state.get(key) ?? null);
  storage.setItem.mockReset().mockImplementation((key, value) => state.set(key, value));
  storage.removeItem.mockReset().mockImplementation((key) => state.delete(key));
  vi.stubGlobal("localStorage", storage);
});

describe("Stellar wallet preference storage", () => {
  it("reads a supported wallet preference", () => {
    state.set(walletKey, "albedo");

    expect(readWalletPreference()).toEqual({ id: "albedo", error: null });
    expect(isRecognizedWalletPreference("albedo")).toBe(true);
  });

  it("allows clearing the preference without removing an unresolved transfer checkpoint", () => {
    state.set(walletKey, "albedo");
    state.set(checkpointKey, "unresolved-checkpoint");

    expect(saveWalletPreference(null)).toBeNull();

    expect(state.has(walletKey)).toBe(false);
    expect(state.get(checkpointKey)).toBe("unresolved-checkpoint");
  });

  it("reports storage failures without preventing wallet access", () => {
    storage.setItem.mockImplementation(() => {
      throw new Error("storage is disabled");
    });

    expect(saveWalletPreference("albedo")).toMatch(/Could not update/);
    expect(isRecognizedWalletPreference("albedo")).toBe(true);
  });

  it("keeps the saved preference and checkpoint when clearing storage fails", () => {
    state.set(walletKey, "albedo");
    state.set(checkpointKey, "unresolved-checkpoint");
    storage.removeItem.mockImplementation(() => {
      throw new Error("storage is disabled");
    });
    expect(saveWalletPreference(null)).toMatch(/Could not update/);
    expect(state.get(walletKey)).toBe("albedo");
    expect(state.get(checkpointKey)).toBe("unresolved-checkpoint");
  });

  it("reports failures reading the saved preference", () => {
    storage.getItem.mockImplementation(() => {
      throw new Error("storage is disabled");
    });

    expect(readWalletPreference()).toEqual({
      id: null,
      error: "Could not read the saved wallet preference. You can still connect a wallet.",
    });
  });

  it("reports unknown stored wallet IDs so users can clear them", () => {
    state.set(walletKey, "unknown-wallet");

    const preference = readWalletPreference();
    expect(preference).toEqual({ id: "unknown-wallet", error: null });
    expect(isRecognizedWalletPreference(preference.id)).toBe(false);
  });
});
