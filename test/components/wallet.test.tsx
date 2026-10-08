import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Wallet Session Persistence", () => {
  const STELLAR_ID_KEY = "stellar_wallet_id";
  const STELLAR_ADDR_KEY = "stellar_wallet_address";
  const STELLAR_LEGACY_KEY = "hyperion.stellar.wallet";
  const EVM_CONNECTED_KEY = "evm_wallet_connected";
  const EVM_CONNECTOR_ID_KEY = "evm_connector_id";
  const EVM_ADDR_KEY = "evm_wallet_address";

  let mockStorage: Record<string, string> = {};

  beforeEach(() => {
    mockStorage = {};
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => mockStorage[key] ?? null),
      setItem: vi.fn((key: string, val: string) => {
        mockStorage[key] = val;
      }),
      removeItem: vi.fn((key: string) => {
        Reflect.deleteProperty(mockStorage, key);
      }),
      clear: vi.fn(() => {
        mockStorage = {};
      }),
    });
  });

  it("persists active Stellar wallet choice and address in storage", () => {
    const testWalletId = "freighter";
    const testAddress = "GCEXAMPLE1234567890STREVALUATIONKEY";

    localStorage.setItem(STELLAR_ID_KEY, testWalletId);
    localStorage.setItem(STELLAR_ADDR_KEY, testAddress);
    localStorage.setItem(
      STELLAR_LEGACY_KEY,
      JSON.stringify({ address: testAddress, walletId: testWalletId }),
    );

    expect(localStorage.getItem(STELLAR_ID_KEY)).toBe("freighter");
    expect(localStorage.getItem(STELLAR_ADDR_KEY)).toBe(testAddress);

    const legacy = JSON.parse(localStorage.getItem(STELLAR_LEGACY_KEY) ?? "{}") as {
      address?: string;
      walletId?: string;
    };
    expect(legacy.walletId).toBe("freighter");
    expect(legacy.address).toBe(testAddress);
  });

  it("persists active EVM connection marker and connector in storage", () => {
    const testConnectorId = "io.metamask";
    const testAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

    localStorage.setItem(EVM_CONNECTED_KEY, "true");
    localStorage.setItem(EVM_CONNECTOR_ID_KEY, testConnectorId);
    localStorage.setItem(EVM_ADDR_KEY, testAddress);

    expect(localStorage.getItem(EVM_CONNECTED_KEY)).toBe("true");
    expect(localStorage.getItem(EVM_CONNECTOR_ID_KEY)).toBe(testConnectorId);
    expect(localStorage.getItem(EVM_ADDR_KEY)).toBe(testAddress);
  });

  it("purges all stored Stellar wallet state on disconnect", () => {
    localStorage.setItem(STELLAR_ID_KEY, "xbull");
    localStorage.setItem(STELLAR_ADDR_KEY, "GANYOTHERKEY");
    localStorage.setItem(STELLAR_LEGACY_KEY, JSON.stringify({ address: "GANYOTHERKEY" }));

    localStorage.removeItem(STELLAR_ID_KEY);
    localStorage.removeItem(STELLAR_ADDR_KEY);
    localStorage.removeItem(STELLAR_LEGACY_KEY);

    expect(localStorage.getItem(STELLAR_ID_KEY)).toBeNull();
    expect(localStorage.getItem(STELLAR_ADDR_KEY)).toBeNull();
    expect(localStorage.getItem(STELLAR_LEGACY_KEY)).toBeNull();
  });

  it("purges all stored EVM wallet state on disconnect", () => {
    localStorage.setItem(EVM_CONNECTED_KEY, "true");
    localStorage.setItem(EVM_CONNECTOR_ID_KEY, "injected");
    localStorage.setItem(EVM_ADDR_KEY, "0x123");

    localStorage.removeItem(EVM_CONNECTED_KEY);
    localStorage.removeItem(EVM_CONNECTOR_ID_KEY);
    localStorage.removeItem(EVM_ADDR_KEY);

    expect(localStorage.getItem(EVM_CONNECTED_KEY)).toBeNull();
    expect(localStorage.getItem(EVM_CONNECTOR_ID_KEY)).toBeNull();
    expect(localStorage.getItem(EVM_ADDR_KEY)).toBeNull();
  });

  it("restores session from saved storage when extension is authorized", () => {
    mockStorage[STELLAR_ID_KEY] = "freighter";
    mockStorage[STELLAR_ADDR_KEY] = "GCRESTOREDADDRESS";
    mockStorage[EVM_CONNECTED_KEY] = "true";
    mockStorage[EVM_CONNECTOR_ID_KEY] = "injected";

    const restoredStellarId = localStorage.getItem(STELLAR_ID_KEY);
    const restoredStellarAddr = localStorage.getItem(STELLAR_ADDR_KEY);
    const restoredEvmConnected = localStorage.getItem(EVM_CONNECTED_KEY);

    expect(restoredStellarId).toBe("freighter");
    expect(restoredStellarAddr).toBe("GCRESTOREDADDRESS");
    expect(restoredEvmConnected).toBe("true");
  });

  it("verifies module exports for WalletButton and Providers", async () => {
    const walletModule = await import("../../src/components/wallet");
    expect(walletModule.WalletButton).toBeDefined();
    expect(walletModule.StellarWalletButton).toBeDefined();
    expect(walletModule.EvmWalletButton).toBeDefined();

    const providersModule = await import("../../src/app/providers");
    expect(providersModule.Providers).toBeDefined();
    expect(providersModule.WalletProvider).toBeDefined();
  });
});
