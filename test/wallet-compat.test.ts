/**
 * Adapter compatibility suite for all four Stellar wallet adapters.
 *
 * Table-driven tests verify that:
 *   - Accepted shapes return signed XDR and pass cryptographic verification.
 *   - Rejected shapes throw distinct, explicit errors.
 *   - Wallet signing functions are called exactly once per attempt.
 *   - Albedo is always called with submit: false.
 *   - Nothing in any adapter submits a transaction to the network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { Asset, Keypair } from "@stellar/stellar-sdk";
import { TESTNET } from "../src/config/testnet";
import { walletSign } from "../src/wallets/stellar/sdk";
import {
  buildPaymentFixture,
  buildV0SignedXdr,
  feeBumpWrapped,
  garbageXdr,
  identicalRebuildSignedXdr,
  signedByOtherKey,
  signedOverPublicNetwork,
  signedWithExtraSignatures,
  truncatedXdr,
  unsignedEcho,
  alteredAmountXdr,
  alteredAmountV0Xdr,
  alteredIssuerXdr,
  alteredMemoXdr,
  alteredFeeXdr,
  alteredDestinationXdr,
} from "./support/wallet-fixtures";

// ---------------------------------------------------------------------------
// Mock all four wallet adapters using the same approach as wallet-sdk.test.ts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shared fixture (one per test run, not per test, for performance)
// ---------------------------------------------------------------------------

const fixture = buildPaymentFixture();

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  api.freighter.isConnected.mockResolvedValue({ isConnected: true });
  api.freighter.getAddress.mockResolvedValue({ address: fixture.source.publicKey() });
  api.freighter.requestAccess.mockResolvedValue({ address: fixture.source.publicKey() });
  api.freighter.getNetworkDetails.mockResolvedValue({
    networkPassphrase: TESTNET.networkPassphrase,
  });
  api.lobstr.isConnected.mockResolvedValue(true);
  api.lobstr.getPublicKey.mockResolvedValue(fixture.source.publicKey());
});

// ---------------------------------------------------------------------------
// Helpers that set up each mock to return a given signed XDR
// ---------------------------------------------------------------------------

function mockFreighter(signedXdr: string) {
  api.freighter.signTransaction.mockResolvedValue({ signedTxXdr: signedXdr });
}

function mockAlbedo(signedXdr: string) {
  api.albedo.tx.mockResolvedValue({ signed_envelope_xdr: signedXdr });
}

function mockXbull(signedXdr: string) {
  api.xbull.sign.mockResolvedValue(signedXdr);
}

function mockLobstr(signedXdr: string) {
  api.lobstr.signTransaction.mockResolvedValue(signedXdr);
}

// ---------------------------------------------------------------------------
// Scan safety: no string in this file or the fixture file should look like a
// raw secret seed. Seeds are 56-character base32 strings starting with "S".
// ---------------------------------------------------------------------------

describe("Fixture scan safety", () => {
  it("contains no string that looks like a Stellar secret seed", async () => {
    // A secret seed is a 56-character strkey starting with S, encoding 32 bytes.
    // We read the fixture source file and this file and check for the pattern.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(import.meta.dirname, "..");
    const fixtureSource = fs.readFileSync(
      path.join(root, "test", "support", "wallet-fixtures.ts"),
      "utf8",
    );
    const thisSource = fs.readFileSync(path.join(root, "test", "wallet-compat.test.ts"), "utf8");
    const secretSeedPattern = /\bS[A-Z2-7]{55}\b/;
    expect(fixtureSource).not.toMatch(secretSeedPattern);
    expect(thisSource).not.toMatch(secretSeedPattern);
  });
});

// ---------------------------------------------------------------------------
// Accepted shapes: each should return the signed XDR and pass verification
// ---------------------------------------------------------------------------

describe("Accepted shapes: Freighter", () => {
  it("accepts a correctly signed envelope and verifies the hash and account", async () => {
    mockFreighter(fixture.signedXdr);
    const result = await walletSign("freighter", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: fixture.signedXdr });
    expect(api.freighter.signTransaction).toHaveBeenCalledOnce();
  });

  it("accepts an identical rebuild signed with the source key as a control", async () => {
    const rebuiltSigned = identicalRebuildSignedXdr(fixture);
    mockFreighter(rebuiltSigned);
    const result = await walletSign("freighter", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: rebuiltSigned });
    expect(api.freighter.signTransaction).toHaveBeenCalledOnce();
  });

  it("accepts a correctly signed V0 envelope matching the V1 transaction hash", async () => {
    const v0Signed = buildV0SignedXdr(fixture);
    mockFreighter(v0Signed);
    const result = await walletSign("freighter", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: v0Signed });
    expect(api.freighter.signTransaction).toHaveBeenCalledOnce();
  });

  it("accepts an envelope with extra signatures when the correct one is present", async () => {
    const withExtra = signedWithExtraSignatures(fixture.unsignedXdr, fixture.source);
    mockFreighter(withExtra);
    const result = await walletSign("freighter", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: withExtra });
    expect(api.freighter.signTransaction).toHaveBeenCalledOnce();
  });
});

describe("Accepted shapes: Albedo", () => {
  it("accepts a correctly signed envelope and verifies the hash and account", async () => {
    mockAlbedo(fixture.signedXdr);
    const result = await walletSign("albedo", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: fixture.signedXdr });
    expect(api.albedo.tx).toHaveBeenCalledOnce();
  });

  it("accepts an identical rebuild signed with the source key as a control", async () => {
    const rebuiltSigned = identicalRebuildSignedXdr(fixture);
    mockAlbedo(rebuiltSigned);
    const result = await walletSign("albedo", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: rebuiltSigned });
    expect(api.albedo.tx).toHaveBeenCalledOnce();
  });

  it("accepts a correctly signed V0 envelope matching the V1 transaction hash", async () => {
    const v0Signed = buildV0SignedXdr(fixture);
    mockAlbedo(v0Signed);
    const result = await walletSign("albedo", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: v0Signed });
    expect(api.albedo.tx).toHaveBeenCalledOnce();
  });

  it("is always called with submit: false", async () => {
    mockAlbedo(fixture.signedXdr);
    await walletSign("albedo", fixture.unsignedXdr, fixture.source.publicKey());
    expect(api.albedo.tx).toHaveBeenCalledWith(expect.objectContaining({ submit: false }));
  });

  it("accepts an envelope with extra signatures when the correct one is present", async () => {
    const withExtra = signedWithExtraSignatures(fixture.unsignedXdr, fixture.source);
    mockAlbedo(withExtra);
    const result = await walletSign("albedo", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: withExtra });
    expect(api.albedo.tx).toHaveBeenCalledOnce();
  });
});

describe("Accepted shapes: xBull", () => {
  it("accepts a correctly signed envelope and verifies the hash and account", async () => {
    mockXbull(fixture.signedXdr);
    const result = await walletSign("xbull", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: fixture.signedXdr });
    expect(api.xbull.sign).toHaveBeenCalledOnce();
  });

  it("accepts an identical rebuild signed with the source key as a control", async () => {
    const rebuiltSigned = identicalRebuildSignedXdr(fixture);
    mockXbull(rebuiltSigned);
    const result = await walletSign("xbull", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: rebuiltSigned });
    expect(api.xbull.sign).toHaveBeenCalledOnce();
  });

  it("accepts a correctly signed V0 envelope matching the V1 transaction hash", async () => {
    const v0Signed = buildV0SignedXdr(fixture);
    mockXbull(v0Signed);
    const result = await walletSign("xbull", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: v0Signed });
    expect(api.xbull.sign).toHaveBeenCalledOnce();
  });

  it("accepts an envelope with extra signatures when the correct one is present", async () => {
    const withExtra = signedWithExtraSignatures(fixture.unsignedXdr, fixture.source);
    mockXbull(withExtra);
    const result = await walletSign("xbull", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: withExtra });
    expect(api.xbull.sign).toHaveBeenCalledOnce();
  });
});

describe("Accepted shapes: LOBSTR", () => {
  it("accepts a correctly signed envelope and verifies the hash and account", async () => {
    mockLobstr(fixture.signedXdr);
    const result = await walletSign("lobstr", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: fixture.signedXdr });
    expect(api.lobstr.signTransaction).toHaveBeenCalledOnce();
  });

  it("accepts an identical rebuild signed with the source key as a control", async () => {
    const rebuiltSigned = identicalRebuildSignedXdr(fixture);
    mockLobstr(rebuiltSigned);
    const result = await walletSign("lobstr", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: rebuiltSigned });
    expect(api.lobstr.signTransaction).toHaveBeenCalledOnce();
  });

  it("accepts a correctly signed V0 envelope matching the V1 transaction hash", async () => {
    const v0Signed = buildV0SignedXdr(fixture);
    mockLobstr(v0Signed);
    const result = await walletSign("lobstr", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: v0Signed });
    expect(api.lobstr.signTransaction).toHaveBeenCalledOnce();
  });

  it("accepts an envelope with extra signatures when the correct one is present", async () => {
    const withExtra = signedWithExtraSignatures(fixture.unsignedXdr, fixture.source);
    mockLobstr(withExtra);
    const result = await walletSign("lobstr", fixture.unsignedXdr, fixture.source.publicKey());
    expect(result).toEqual({ signedTxXdr: withExtra });
    expect(api.lobstr.signTransaction).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Rejected shapes: table-driven across all four wallets
// ---------------------------------------------------------------------------

type WalletId = "freighter" | "albedo" | "xbull" | "lobstr";

/** Set up each wallet mock to return the given XDR, then call walletSign. */
async function attemptSign(
  walletId: WalletId,
  returnedXdr: string,
  originalXdr = fixture.unsignedXdr,
  signer = fixture.source.publicKey(),
): Promise<void> {
  switch (walletId) {
    case "freighter":
      mockFreighter(returnedXdr);
      await walletSign("freighter", originalXdr, signer);
      break;
    case "albedo":
      mockAlbedo(returnedXdr);
      await walletSign("albedo", originalXdr, signer);
      break;
    case "xbull":
      mockXbull(returnedXdr);
      await walletSign("xbull", originalXdr, signer);
      break;
    case "lobstr":
      mockLobstr(returnedXdr);
      await walletSign("lobstr", originalXdr, signer);
      break;
  }
}

/** Return how many times the signing function was called for a given wallet. */
function signerCallCount(walletId: WalletId): number {
  switch (walletId) {
    case "freighter":
      return api.freighter.signTransaction.mock.calls.length;
    case "albedo":
      return api.albedo.tx.mock.calls.length;
    case "xbull":
      return api.xbull.sign.mock.calls.length;
    case "lobstr":
      return api.lobstr.signTransaction.mock.calls.length;
  }
}

const wallets: WalletId[] = ["freighter", "albedo", "xbull", "lobstr"];

describe.each(wallets)("Rejected shapes: %s", (walletId) => {
  it("rejects a fee-bump wrapped envelope with 'unsupported'", async () => {
    const feeBump = feeBumpWrapped(fixture.signedXdr);
    await expect(attemptSign(walletId, feeBump)).rejects.toThrow("unsupported");
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("rejects garbage XDR with 'unreadable'", async () => {
    await expect(attemptSign(walletId, garbageXdr())).rejects.toThrow("unreadable");
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("rejects truncated XDR with 'unreadable'", async () => {
    await expect(attemptSign(walletId, truncatedXdr(fixture.signedXdr))).rejects.toThrow(
      "unreadable",
    );
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("rejects an unsigned echo (no signature) with 'did not sign'", async () => {
    await expect(attemptSign(walletId, unsignedEcho(fixture.unsignedXdr))).rejects.toThrow(
      "did not sign",
    );
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("rejects a signature made over the wrong network with 'Stellar Testnet'", async () => {
    const { xdr } = signedOverPublicNetwork(fixture.unsignedXdr, fixture.source);
    await expect(attemptSign(walletId, xdr)).rejects.toThrow("Stellar Testnet");
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("rejects a signature from a different key with 'connected account'", async () => {
    const { xdr } = signedByOtherKey(fixture.unsignedXdr);
    await expect(attemptSign(walletId, xdr)).rejects.toThrow("connected account");
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("rejects an altered amount with 'changed the transaction'", async () => {
    await expect(attemptSign(walletId, alteredAmountXdr(fixture))).rejects.toThrow(
      "changed the transaction",
    );
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("rejects an altered amount in a V0 envelope with 'changed the transaction'", async () => {
    await expect(attemptSign(walletId, alteredAmountV0Xdr(fixture))).rejects.toThrow(
      "changed the transaction",
    );
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("rejects an altered asset issuer with 'changed the transaction'", async () => {
    const issuer = Keypair.random().publicKey();
    const usdcFixture = buildPaymentFixture({
      asset: new Asset("USDC", issuer),
      source: fixture.source,
      destination: fixture.destination,
    });
    await expect(
      attemptSign(walletId, alteredIssuerXdr(usdcFixture), usdcFixture.unsignedXdr),
    ).rejects.toThrow("changed the transaction");
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("rejects an altered memo with 'changed the transaction'", async () => {
    await expect(attemptSign(walletId, alteredMemoXdr(fixture))).rejects.toThrow(
      "changed the transaction",
    );
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("rejects an altered fee with 'changed the transaction'", async () => {
    await expect(attemptSign(walletId, alteredFeeXdr(fixture))).rejects.toThrow(
      "changed the transaction",
    );
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("rejects an altered destination with 'changed the transaction'", async () => {
    await expect(attemptSign(walletId, alteredDestinationXdr(fixture))).rejects.toThrow(
      "changed the transaction",
    );
    expect(signerCallCount(walletId)).toBe(1);
  });

  it("never submits to the network via fetch during successful or rejected signing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Successful sign: wallet signing produces valid signed envelope and never submits
    switch (walletId) {
      case "freighter":
        mockFreighter(fixture.signedXdr);
        break;
      case "albedo":
        mockAlbedo(fixture.signedXdr);
        break;
      case "xbull":
        mockXbull(fixture.signedXdr);
        break;
      case "lobstr":
        mockLobstr(fixture.signedXdr);
        break;
    }
    await walletSign(walletId, fixture.unsignedXdr, fixture.source.publicKey());
    expect(fetchSpy).not.toHaveBeenCalled();

    // Rejected sign: invalid envelope fails verification and never submits
    await expect(attemptSign(walletId, garbageXdr())).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Albedo-specific: submit must always be false
// ---------------------------------------------------------------------------

describe("Albedo adapter contract", () => {
  it("never passes submit: true even for rejected shapes", async () => {
    mockAlbedo(garbageXdr());
    await expect(
      walletSign("albedo", fixture.unsignedXdr, fixture.source.publicKey()),
    ).rejects.toThrow();
    expect(api.albedo.tx).toHaveBeenCalledWith(expect.objectContaining({ submit: false }));
  });
});
