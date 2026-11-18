import { beforeEach, describe, expect, it, vi } from "vitest";
import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { TESTNET } from "../src/config/testnet";
import { createSigningCoordinator, walletAddress, walletSign } from "../src/wallets/stellar/sdk";

const api = vi.hoisted(() => ({
  freighter: {
    isConnected: vi.fn(),
    getAddress: vi.fn(),
    requestAccess: vi.fn(),
    getNetworkDetails: vi.fn(),
    signTransaction: vi.fn(),
  },
  albedo: { publicKey: vi.fn(), tx: vi.fn() },
  xbull: { connect: vi.fn(), sign: vi.fn(), closeConnections: vi.fn() },
  lobstr: { isConnected: vi.fn(), getPublicKey: vi.fn(), signTransaction: vi.fn() },
}));
vi.mock("@stellar/freighter-api", () => api.freighter);
vi.mock("@albedo-link/intent", () => ({ default: api.albedo }));
vi.mock("@creit.tech/xbull-wallet-connect", () => ({
  xBullWalletConnect: class {
    connect = api.xbull.connect;
    sign = api.xbull.sign;
    closeConnections = api.xbull.closeConnections;
  },
}));
vi.mock("@lobstrco/signer-extension-api", () => api.lobstr);

const signer = Keypair.random();
function envelope() {
  const tx = new TransactionBuilder(new Account(signer.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: TESTNET.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(60)
    .build();
  const original = tx.toXdr();
  tx.sign(signer);
  return { original, signed: tx.toXdr() };
}
beforeEach(() => {
  vi.clearAllMocks();
  api.freighter.isConnected.mockResolvedValue({ isConnected: true });
  api.freighter.getAddress.mockResolvedValue({ address: signer.publicKey() });
  api.freighter.requestAccess.mockResolvedValue({ address: signer.publicKey() });
  api.freighter.getNetworkDetails.mockResolvedValue({
    networkPassphrase: TESTNET.networkPassphrase,
  });
  api.lobstr.isConnected.mockResolvedValue(true);
  api.lobstr.getPublicKey.mockResolvedValue(signer.publicKey());
});
describe("Direct Stellar wallet adapters", () => {
  it("serializes signing requests and releases ownership after cancellation", async () => {
    let cancel!: (error: Error) => void;
    const coordinator = createSigningCoordinator();
    const first = coordinator.run(
      { operation: "conversion", account: signer.publicKey() },
      () => new Promise<never>((_, reject) => (cancel = reject)),
    );

    expect(coordinator.pending).toEqual({
      operation: "conversion",
      account: signer.publicKey(),
    });
    await expect(
      coordinator.run({ operation: "bridge", account: signer.publicKey() }, () =>
        Promise.resolve("not reached"),
      ),
    ).rejects.toThrow("conversion signing request is already waiting");

    cancel(new Error("Request declined"));
    await expect(first).rejects.toThrow("Request declined");
    expect(coordinator.pending).toBeNull();
    await expect(
      coordinator.run({ operation: "bridge", account: signer.publicKey() }, () =>
        Promise.resolve("available"),
      ),
    ).resolves.toBe("available");
  });

  it("rejects stale approval provenance before opening a wallet prompt", async () => {
    await expect(
      walletSign("freighter", envelope().original, signer.publicKey(), {
        account: Keypair.random().publicKey(),
        network: TESTNET.networkPassphrase,
        operation: "bridge",
      }),
    ).rejects.toThrow("account changed");
    expect(api.freighter.signTransaction).not.toHaveBeenCalled();
  });
  it("restores Freighter with silent lookup and requests access only for explicit connection", async () => {
    expect(await walletAddress("freighter", false)).toBe(signer.publicKey());
    expect(api.freighter.requestAccess).not.toHaveBeenCalled();
    expect(await walletAddress("freighter")).toBe(signer.publicKey());
    expect(api.freighter.requestAccess).toHaveBeenCalledOnce();
  });
  it("preserves an explicit wallet rejection", async () => {
    api.freighter.requestAccess.mockResolvedValue({
      address: "",
      error: { message: "Request declined" },
    });
    await expect(walletAddress("freighter")).rejects.toThrow("Request declined");
  });
  it("rejects a Freighter network switch before requesting a signature", async () => {
    api.freighter.getNetworkDetails.mockResolvedValue({
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    });
    await expect(walletSign("freighter", envelope().original, signer.publicKey())).rejects.toThrow(
      "Testnet",
    );
    expect(api.freighter.signTransaction).not.toHaveBeenCalled();
  });
  it("rejects a Freighter account switch before requesting a signature", async () => {
    api.freighter.getAddress.mockResolvedValue({ address: Keypair.random().publicKey() });
    await expect(walletSign("freighter", envelope().original, signer.publicKey())).rejects.toThrow(
      "account changed",
    );
    expect(api.freighter.signTransaction).not.toHaveBeenCalled();
  });
  it("passes the account and Testnet network to Freighter and verifies its signed envelope", async () => {
    const { original, signed } = envelope();
    api.freighter.signTransaction.mockResolvedValue({ signedTxXdr: signed });
    expect(await walletSign("freighter", original, signer.publicKey())).toEqual({
      signedTxXdr: signed,
    });
    expect(api.freighter.signTransaction).toHaveBeenCalledWith(original, {
      address: signer.publicKey(),
      networkPassphrase: TESTNET.networkPassphrase,
    });
  });
  it("asks Albedo to sign on Testnet without submitting", async () => {
    const { original, signed } = envelope();
    api.albedo.tx.mockResolvedValue({ signed_envelope_xdr: signed });
    expect(await walletSign("albedo", original, signer.publicKey())).toEqual({
      signedTxXdr: signed,
    });
    expect(api.albedo.tx).toHaveBeenCalledWith({
      xdr: original,
      pubkey: signer.publicKey(),
      network: "testnet",
      submit: false,
    });
  });
  it("passes xBull the exact account/network and closes its connections", async () => {
    const { original, signed } = envelope();
    api.xbull.sign.mockResolvedValue(signed);
    expect(await walletSign("xbull", original, signer.publicKey())).toEqual({
      signedTxXdr: signed,
    });
    expect(api.xbull.sign).toHaveBeenCalledWith({
      xdr: original,
      publicKey: signer.publicKey(),
      network: TESTNET.networkPassphrase,
    });
    expect(api.xbull.closeConnections).toHaveBeenCalledOnce();
  });
  it("closes xBull connections after cancellation", async () => {
    api.xbull.connect.mockRejectedValue(new Error("Request declined"));
    await expect(walletAddress("xbull")).rejects.toThrow("declined");
    expect(api.xbull.closeConnections).toHaveBeenCalledOnce();
  });
  it("rejects a LOBSTR account switch before requesting a signature", async () => {
    api.lobstr.getPublicKey.mockResolvedValue(Keypair.random().publicKey());
    await expect(walletSign("lobstr", envelope().original, signer.publicKey())).rejects.toThrow(
      "account changed",
    );
    expect(api.lobstr.signTransaction).not.toHaveBeenCalled();
  });
  it("cryptographically checks LOBSTR's signature even though its API has no network option", async () => {
    const { original, signed } = envelope();
    api.lobstr.signTransaction.mockResolvedValue(signed);
    expect(await walletSign("lobstr", original, signer.publicKey())).toEqual({
      signedTxXdr: signed,
    });
    api.lobstr.signTransaction.mockResolvedValue(original);
    await expect(walletSign("lobstr", original, signer.publicKey())).rejects.toThrow(
      "did not sign",
    );
  });
});
