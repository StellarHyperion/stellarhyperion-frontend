import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { TESTNET } from "../src/config/testnet";
import {
  createGenerationTracker,
  createSigningCoordinator,
  WALLET_SIGN_TIMEOUT_MS,
  walletAddress,
  walletSign,
} from "../src/wallets/stellar/sdk";
import { verifyWalletSignature } from "../src/wallets/stellar/signature";

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
  it("releases signing ownership when an adapter throws before returning a promise", async () => {
    const coordinator = createSigningCoordinator();
    await expect(
      coordinator.run({ operation: "bridge", account: signer.publicKey() }, () => {
        throw new Error("Extension context invalidated.");
      }),
    ).rejects.toThrow("Extension context invalidated");
    expect(coordinator.pending).toBeNull();
    await expect(
      coordinator.run({ operation: "bridge", account: signer.publicKey() }, () =>
        Promise.resolve("available"),
      ),
    ).resolves.toBe("available");
  });

  it("does not open an adapter request when disconnected before signing starts", async () => {
    const coordinator = createSigningCoordinator();
    const action = vi.fn(() => Promise.resolve("unused"));
    const outstanding = coordinator.run(
      { operation: "transaction", account: signer.publicKey() },
      action,
    );
    coordinator.abandon(new Error("Disconnected"));
    await expect(outstanding).rejects.toThrow("Disconnected");
    expect(action).not.toHaveBeenCalled();
    expect(coordinator.pending).toBeNull();
  });

  it("prevents a late account preflight from opening a cancelled signature prompt", async () => {
    let finishPreflight!: (value: { address: string }) => void;
    api.freighter.getAddress.mockReturnValue(
      new Promise((resolve) => {
        finishPreflight = resolve;
      }),
    );
    const preflightStarted = vi.waitFor(() => {
      expect(api.freighter.getAddress).toHaveBeenCalled();
    });
    const coordinator = createSigningCoordinator();
    const outstanding = coordinator.run(
      { operation: "transaction", account: signer.publicKey() },
      (signal) =>
        walletSign("freighter", envelope().original, signer.publicKey(), undefined, signal),
    );
    await preflightStarted;
    coordinator.abandon(new Error("Disconnected during preflight"));
    await expect(outstanding).rejects.toThrow("Disconnected during preflight");
    finishPreflight({ address: signer.publicKey() });
    await vi.waitFor(() => {
      expect(api.freighter.getNetworkDetails).toHaveBeenCalled();
    });
    expect(api.freighter.signTransaction).not.toHaveBeenCalled();
    expect(coordinator.pending).toBeNull();
  });

  it("discards a cancelled signature while a new request owns the signing controls", async () => {
    let finishOld!: (value: string) => void;
    let finishNew!: (value: string) => void;
    const coordinator = createSigningCoordinator();
    const first = coordinator.run(
      { operation: "conversion", account: signer.publicKey() },
      () => new Promise<string>((resolve) => (finishOld = resolve)),
    );
    await Promise.resolve();
    coordinator.abandon(new Error("Stopped waiting"));
    await expect(first).rejects.toThrow("Stopped waiting");
    const second = coordinator.run(
      { operation: "bridge", account: signer.publicKey() },
      () => new Promise<string>((resolve) => (finishNew = resolve)),
    );
    await Promise.resolve();
    finishOld("stale signature");
    await Promise.resolve();
    expect(coordinator.pending?.operation).toBe("bridge");
    finishNew("new signature");
    await expect(second).resolves.toBe("new signature");
    expect(coordinator.pending).toBeNull();
  });

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

  it("force-settles an outstanding request via abandon() instead of leaving it to hang", async () => {
    const coordinator = createSigningCoordinator();
    const outstanding = coordinator.run(
      { operation: "transaction", account: signer.publicKey() },
      () => new Promise(() => undefined),
    );
    coordinator.abandon(new Error("Wallet disconnected before the signature completed."));
    await expect(outstanding).rejects.toThrow(
      "Wallet disconnected before the signature completed.",
    );
    expect(coordinator.pending).toBeNull();
    // Abandoning with nothing outstanding is a no-op, not an error.
    expect(() => {
      coordinator.abandon(new Error("unused"));
    }).not.toThrow();
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
  it("rejects an empty or missing signature instead of assuming success", () => {
    const { original } = envelope();
    expect(() => verifyWalletSignature(original, "", signer.publicKey())).toThrow(
      "did not return a signed transaction",
    );
  });
});

describe("An outstanding approval resolves to an explicit failure instead of hanging forever", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a Freighter signature that never responds (extension removed or popup closed)", async () => {
    vi.useFakeTimers();
    api.freighter.signTransaction.mockReturnValue(new Promise(() => undefined));
    const pending = walletSign("freighter", envelope().original, signer.publicKey());
    const assertion = expect(pending).rejects.toThrow(
      "The approval outcome is unknown. Close the wallet prompt and review before trying again. Nothing is automatically submitted.",
    );
    await vi.advanceTimersByTimeAsync(WALLET_SIGN_TIMEOUT_MS);
    await assertion;
    expect(api.freighter.getNetworkDetails).toHaveBeenCalled();
  });

  it("never treats a signature that arrives after giving up as a success", async () => {
    vi.useFakeTimers();
    const late: { resolve: ((value: { signedTxXdr: string }) => void) | null } = {
      resolve: null,
    };
    api.freighter.signTransaction.mockReturnValue(
      new Promise<{ signedTxXdr: string }>((resolve) => {
        late.resolve = resolve;
      }),
    );
    const pending = walletSign("freighter", envelope().original, signer.publicKey());
    const assertion = expect(pending).rejects.toThrow("did not respond to the signature request");
    await vi.advanceTimersByTimeAsync(WALLET_SIGN_TIMEOUT_MS);
    await assertion;
    // The wallet eventually answers long after Hyperion gave up on it. The stale answer must be
    // discarded, never resubmitted or accepted as a late success.
    late.resolve?.({ signedTxXdr: envelope().signed });
    await vi.advanceTimersByTimeAsync(0);
  });

  it("still closes xBull's bridge connections when its popup closes without responding", async () => {
    vi.useFakeTimers();
    api.xbull.sign.mockReturnValue(new Promise(() => undefined));
    const pending = walletSign("xbull", envelope().original, signer.publicKey());
    const assertion = expect(pending).rejects.toThrow(
      "xBull closed or did not respond to the signature request",
    );
    await vi.advanceTimersByTimeAsync(WALLET_SIGN_TIMEOUT_MS);
    await assertion;
    expect(api.xbull.closeConnections).toHaveBeenCalledOnce();
  });

  it("turns a lost extension connection into an actionable message instead of a raw runtime error", async () => {
    api.freighter.signTransaction.mockRejectedValue(new Error("Extension context invalidated."));
    await expect(walletSign("freighter", envelope().original, signer.publicKey())).rejects.toThrow(
      "The wallet extension was removed or reloaded. Reopen it and try again.",
    );
  });
});

describe("Connection generation tracking", () => {
  it("releases a superseded account request before its old adapter responds", async () => {
    let finishOld!: (value: { address: string }) => void;
    api.freighter.requestAccess.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const tracker = createGenerationTracker();
    const oldRequest = tracker.run(() => walletAddress("freighter"));
    await vi.waitFor(() => {
      expect(api.freighter.requestAccess).toHaveBeenCalled();
    });
    tracker.advance();
    await expect(oldRequest).rejects.toThrow("wallet connection changed");
    await expect(tracker.run(() => walletAddress("freighter"))).resolves.toBe(signer.publicKey());
    finishOld({ address: Keypair.random().publicKey() });
    await Promise.resolve();
    await expect(oldRequest).rejects.toThrow("wallet connection changed");
  });

  it("never starts an old generation's deferred action after reconnection", async () => {
    const tracker = createGenerationTracker();
    const action = vi.fn(() => Promise.resolve("stale"));
    const oldRequest = tracker.run(action);
    tracker.advance();
    await expect(oldRequest).rejects.toThrow("wallet connection changed");
    expect(action).not.toHaveBeenCalled();
    await expect(tracker.run(() => Promise.resolve("current"))).resolves.toBe("current");
  });

  it("starts at zero and advances monotonically", () => {
    const tracker = createGenerationTracker();
    expect(tracker.value()).toBe(0);
    expect(tracker.advance()).toBe(1);
    expect(tracker.advance()).toBe(2);
    expect(tracker.value()).toBe(2);
  });

  it("lets a caller detect that its captured generation is no longer current", () => {
    const tracker = createGenerationTracker();
    const issued = tracker.value();
    expect(tracker.value()).toBe(issued);
    tracker.advance();
    expect(tracker.value()).not.toBe(issued);
  });

  it("discards a late wallet address result once the connection has moved on", async () => {
    let settleFirstRequest!: (address: string) => void;
    api.freighter.requestAccess.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleFirstRequest = (address) => {
            resolve({ address });
          };
        }),
    );
    const tracker = createGenerationTracker();
    const issuedGeneration = tracker.value();
    const firstRequest = walletAddress("freighter").then((value) => ({
      value,
      // Mirrors the check a caller (e.g. the wallet context's signTransaction) makes once
      // its awaited call resolves: has the connection generation moved on since this call
      // was issued?
      stale: tracker.value() !== issuedGeneration,
    }));

    // Let walletAddress's own `isConnected()` await run before Freighter's request mock is
    // actually invoked, so `settleFirstRequest` is assigned before we use it below.
    await vi.waitFor(() => {
      if (typeof settleFirstRequest !== "function") throw new Error("not yet called");
    });

    // The user disconnects/reconnects before Freighter's first request settles.
    tracker.advance();
    settleFirstRequest(signer.publicKey());

    const { value, stale } = await firstRequest;
    expect(value).toBe(signer.publicKey());
    expect(stale).toBe(true);
  });

  it("does not flag a result as stale when the generation has not moved on", async () => {
    const tracker = createGenerationTracker();
    const issuedGeneration = tracker.value();
    const result = await walletAddress("freighter", false).then((value) => ({
      value,
      stale: tracker.value() !== issuedGeneration,
    }));
    expect(result.stale).toBe(false);
  });
});
