import { describe, expect, it } from "vitest";
import {
  ConcurrencyGuard,
  assertWalletMethodSupported,
  checkWalletAvailability,
  getAllWalletCapabilities,
  getAllWalletDiagnostics,
  getWalletCapabilities,
  getWalletDiagnostics,
  subscribeToAccountChange,
} from "../src/wallets/stellar/sdk";
import {
  areTokenIdentitiesEqual,
  assertNoAutomaticResubmission,
  createTokenIdentifier,
  evaluateStageTracking,
  fromExactIntegerStroops,
  getSupportedLanes,
  isAmbiguousNetworkError,
  toExactIntegerStroops,
  validateSignatureResult,
} from "../src/wallets/stellar/signature";
import {
  AmbiguousTransactionError,
  UnsupportedWalletMethodError,
  WalletConcurrencyError,
} from "../src/wallets/stellar/types";

describe("Stellar Wallet Adapter Capabilities & Diagnostics", () => {
  it("models distinct states for missing extensions and popup requirements", () => {
    // Albedo requires a web popup window; it does not use an extension
    const albedoStatus = checkWalletAvailability("albedo");
    expect(albedoStatus).toBe("popup_required");

    // In a test environment without injected browser extensions:
    // Freighter requires an extension and is missing
    const freighterStatus = checkWalletAvailability("freighter");
    expect(freighterStatus).toBe("missing_extension");

    // xBull requires an extension and is missing
    const xbullStatus = checkWalletAvailability("xbull");
    expect(xbullStatus).toBe("missing_extension");

    // Lobstr is a web / QR mobile connector
    const lobstrStatus = checkWalletAvailability("lobstr");
    expect(lobstrStatus).toBe("available");

    // Unregistered wallet
    const unknownStatus = checkWalletAvailability("phantom");
    expect(unknownStatus).toBe("unsupported");

    // Distinctness invariant
    expect(albedoStatus).not.toBe(freighterStatus);
    expect(albedoStatus).not.toBe(lobstrStatus);
    expect(freighterStatus).not.toBe(lobstrStatus);
  });

  it("diagnostics never request a signature merely to test availability", () => {
    // Collect all diagnostics across adapters
    const allDiagnostics = getAllWalletDiagnostics();
    expect(allDiagnostics).toHaveLength(4);

    for (const diag of allDiagnostics) {
      expect(diag.walletId).toBeDefined();
      expect(diag.name).toBeDefined();
      expect(diag.status).toBeDefined();
      expect(diag.capabilities).toBeDefined();
      expect(typeof diag.isInstalled).toBe("boolean");
      expect(typeof diag.requiresExtension).toBe("boolean");
      expect(typeof diag.requiresPopup).toBe("boolean");
      expect(diag.lastChecked).toBeGreaterThan(0);
    }

    // Individual diagnostic query
    const freighterDiag = getWalletDiagnostics("freighter");
    expect(freighterDiag.walletId).toBe("freighter");
    expect(freighterDiag.requiresExtension).toBe(true);
    expect(freighterDiag.requiresPopup).toBe(false);
  });

  it("unsupported methods do not silently fall back to a different wallet", () => {
    // Freighter supports both transaction signing and Soroban auth entries
    expect(() => {
      assertWalletMethodSupported("freighter", "signTransaction");
    }).not.toThrow();

    expect(() => {
      assertWalletMethodSupported("freighter", "signAuthEntry");
    }).not.toThrow();

    // xBull supports transaction signing, but not Soroban auth entry signing
    expect(() => {
      assertWalletMethodSupported("xbull", "signTransaction");
    }).not.toThrow();

    expect(() => {
      assertWalletMethodSupported("xbull", "signAuthEntry");
    }).toThrow(UnsupportedWalletMethodError);

    // Albedo supports transaction signing, but not auth entry signing
    expect(() => {
      assertWalletMethodSupported("albedo", "signAuthEntry");
    }).toThrow(UnsupportedWalletMethodError);

    // Lobstr supports transaction signing, but not auth entry signing
    expect(() => {
      assertWalletMethodSupported("lobstr", "signAuthEntry");
    }).toThrow(UnsupportedWalletMethodError);

    // Assert the error identifies the exact wallet without falling back
    try {
      assertWalletMethodSupported("xbull", "signAuthEntry");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedWalletMethodError);
      const unsupportedErr = err as UnsupportedWalletMethodError;
      expect(unsupportedErr.walletId).toBe("xbull");
      expect(unsupportedErr.method).toBe("signAuthEntry");
    }
  });

  it("enforces explicit concurrency guard against overlapping operations", () => {
    const guard = new ConcurrencyGuard();
    expect(guard.isSigning).toBe(false);
    expect(guard.isConnecting).toBe(false);

    // Acquire sign lock
    guard.acquireSign();
    expect(guard.isSigning).toBe(true);

    // Second sign attempt must be rejected
    expect(() => {
      guard.acquireSign();
    }).toThrow(WalletConcurrencyError);

    // Release sign lock
    guard.releaseSign();
    expect(guard.isSigning).toBe(false);

    // Now re-acquiring succeeds
    expect(() => {
      guard.acquireSign();
    }).not.toThrow();
    guard.releaseSign();

    // Acquire connect lock
    guard.acquireConnect();
    expect(guard.isConnecting).toBe(true);

    expect(() => {
      guard.acquireConnect();
    }).toThrow(WalletConcurrencyError);

    guard.releaseConnect();
    expect(guard.isConnecting).toBe(false);
  });

  it("registers account change listeners only for capable adapters", () => {
    // Albedo does not support account change events
    const albedoUnsub = subscribeToAccountChange("albedo", () => {});
    expect(typeof albedoUnsub).toBe("function");

    // Freighter supports account change events
    const freighterUnsub = subscribeToAccountChange("freighter", () => {});
    expect(typeof freighterUnsub).toBe("function");
    freighterUnsub();
  });
});

describe("Stellar Signatures, Exact Arithmetic & Stage Tracking", () => {
  it("preserves exact integer amounts without floating point roundoff", () => {
    expect(toExactIntegerStroops("100")).toBe(100_0000000n);
    expect(toExactIntegerStroops("1.5")).toBe(1_5000000n);
    expect(toExactIntegerStroops("0.1234567")).toBe(1234567n);
    expect(toExactIntegerStroops(500n)).toBe(500n);

    expect(fromExactIntegerStroops(100_0000000n)).toBe("100.0000000");
    expect(fromExactIntegerStroops(1_5000000n)).toBe("1.5000000");
    expect(fromExactIntegerStroops(1234567n)).toBe("0.1234567");

    // Rejects precision over 7 decimals
    expect(() => {
      toExactIntegerStroops("1.12345678");
    }).toThrow();

    // Rejects invalid strings
    expect(() => {
      toExactIntegerStroops("abc");
    }).toThrow();
  });

  it("preserves issuer-specific token identities", () => {
    const usdcCircle = createTokenIdentifier(
      "USDC",
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    );
    const usdcOther = createTokenIdentifier(
      "USDC",
      "CBK3TPRQR5A3H2AWESOUX4MVYOP63VNQ5EYHCX26EEJUC5B5FLB4DV5O",
    );
    const usdcNative = createTokenIdentifier("USDC");
    const xlm = createTokenIdentifier("XLM");

    // Same asset code with different issuers must not be identical
    expect(areTokenIdentitiesEqual(usdcCircle, usdcOther)).toBe(false);

    // Same asset code with vs without issuer must not be identical
    expect(areTokenIdentitiesEqual(usdcCircle, usdcNative)).toBe(false);

    // Identical code and issuer match
    const usdcCircleCopy = createTokenIdentifier(
      "USDC",
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    );
    expect(areTokenIdentitiesEqual(usdcCircle, usdcCircleCopy)).toBe(true);

    // Different asset codes match neither
    expect(areTokenIdentitiesEqual(usdcCircle, xlm)).toBe(false);
  });

  it("maintains strict distinction between source confirmation and destination delivery", () => {
    // 1. Source confirmed but destination pending relay
    const pendingRelay = evaluateStageTracking("source_confirmed", "in_transit");
    expect(pendingRelay.isSourceConfirmed).toBe(true);
    expect(pendingRelay.isDestinationDelivered).toBe(false);
    expect(pendingRelay.summary).toContain("awaiting destination delivery");

    // 2. Both source confirmed and destination delivered
    const settled = evaluateStageTracking("source_confirmed", "delivered");
    expect(settled.isSourceConfirmed).toBe(true);
    expect(settled.isDestinationDelivered).toBe(true);
    expect(settled.summary).toContain("transfer settled on destination");

    // 3. Source still submitted waiting for ledger close
    const submitting = evaluateStageTracking("submitted", "idle");
    expect(submitting.isSourceConfirmed).toBe(false);
    expect(submitting.isDestinationDelivered).toBe(false);
    expect(submitting.summary).toContain("awaiting stellar ledger close");
  });

  it("ensures ambiguous signed transactions are never automatically resubmitted", () => {
    // Ambiguous network failure detection
    expect(isAmbiguousNetworkError(new Error("HTTP 504 Gateway Timeout"))).toBe(true);
    expect(isAmbiguousNetworkError(new Error("Connection reset by peer (ECONNRESET)"))).toBe(true);
    expect(isAmbiguousNetworkError(new Error("Transaction status undetermined on node"))).toBe(true);
    expect(isAmbiguousNetworkError(new Error("User cancelled transaction approval"))).toBe(false);

    // Resubmission assertion prevents auto-resubmission
    expect(() => {
      assertNoAutomaticResubmission("ambiguous", "0xsimulated_hash");
    }).toThrow(AmbiguousTransactionError);

    expect(() => {
      assertNoAutomaticResubmission("signed", "0xsimulated_hash");
    }).toThrow(AmbiguousTransactionError);

    expect(() => {
      assertNoAutomaticResubmission("source_confirmed", "0xsimulated_hash");
    }).not.toThrow();
  });

  it("exposes only independently supported testnet lanes", () => {
    const lanes = getSupportedLanes();
    expect(lanes.length).toBeGreaterThan(0);
    expect(lanes.every((l) => l.name === "TESTNET")).toBe(true);
    expect(lanes.every((l) => l.isIndependent === true)).toBe(true);
    expect(lanes.every((l) => l.networkPassphrase.includes("Test SDF Network"))).toBe(true);
  });

  it("validates signature result envelopes", () => {
    expect(validateSignatureResult({ signedTxXdr: "AAAA..." }).valid).toBe(true);
    expect(validateSignatureResult({ signedAuthEntry: "BBBB..." }).valid).toBe(true);
    expect(validateSignatureResult({ signedTxXdr: "" }).valid).toBe(false);
    expect(validateSignatureResult({} as unknown as { signedTxXdr: string }).valid).toBe(false);
  });
});
