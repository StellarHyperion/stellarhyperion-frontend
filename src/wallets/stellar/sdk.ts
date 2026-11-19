import { TESTNET } from "../../config/testnet";
import { assertWalletApproval } from "./signature";
import type { WalletApprovalProvenance } from "./types";

export const STELLAR_WALLETS = [
  { id: "freighter", name: "Freighter", url: "https://www.freighter.app/" },
  { id: "albedo", name: "Albedo", url: "https://albedo.link/" },
  { id: "xbull", name: "xBull", url: "https://xbull.app/" },
  { id: "lobstr", name: "LOBSTR", url: "https://lobstr.co/" },
] as const;
export type StellarWalletId = (typeof STELLAR_WALLETS)[number]["id"];
export const isWalletId = (value: string | null): value is StellarWalletId =>
  STELLAR_WALLETS.some((wallet) => wallet.id === value);

/**
 * Tags every asynchronous wallet call with the connection generation it was issued under.
 *
 * Connecting, switching accounts and disconnecting each advance the generation. A caller that
 * captures `value()` before starting a wallet request can compare it again once that request
 * settles: if the generation has since moved on, the result belongs to a connection that is no
 * longer current and must be discarded rather than applied, so a slow or stale wallet response
 * can never overwrite a later connection (or be treated as a valid signature for one).
 */
export function createGenerationTracker() {
  let current = 0;
  let controller = new AbortController();
  return {
    /** Starts a new generation and returns it. */
    advance(): number {
      controller.abort(new Error("Your wallet connection changed. Review the transaction again."));
      controller = new AbortController();
      current += 1;
      return current;
    },
    /** The generation currently in effect. */
    value(): number {
      return current;
    },
    async run<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const signal = controller.signal;
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          const reason: unknown = signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new Error("Your wallet connection changed. Review the transaction again."),
          );
        };
        signal.addEventListener("abort", abort, { once: true });
      });
      try {
        return await Promise.race([
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return action(signal);
          }),
          cancelled,
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
export type GenerationTracker = ReturnType<typeof createGenerationTracker>;

export type SigningOperation =
  "bridge" | "conversion" | "claim" | "claim-settlement" | "transaction";
export interface PendingSigningRequest {
  operation: SigningOperation;
  account: string;
}

// A wallet extension can be removed, have its popup closed without a response, or otherwise go
// silent while a request is outstanding. Without a bound, the caller would await forever. These
// timeouts only force the *caller's* promise to settle; they never resubmit or assume success.
export const WALLET_CONNECT_TIMEOUT_MS = 60_000;
export const WALLET_SIGN_TIMEOUT_MS = 180_000;

// Browsers raise distinctive messages when an extension's background context disappears
// mid-request (removed, reloaded, or crashed). Surface those as a clear, actionable message
// instead of the raw runtime error.
const EXTENSION_LOST_PATTERN =
  /extension context invalidated|disconnected port|receiving end does not exist|could not establish connection/i;

function friendlyMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : null;
  if (!message) return "The wallet request failed. Open your wallet and try again.";
  if (EXTENSION_LOST_PATTERN.test(message))
    return "The wallet extension was removed or reloaded. Reopen it and try again.";
  return message;
}

function throwWalletError(error: unknown): never {
  throw new Error(friendlyMessage(error));
}

// Coordinates a single outstanding wallet signing request at a time. A request can also be
// force-settled from outside (disconnect, an explicit cancellation) to a clear rejection instead
// of being left to hang, or resolving against a wallet we've already walked away from. The
// underlying action's eventual outcome is still observed so it never surfaces as an unhandled
// rejection, but is otherwise discarded once abandoned: a late response is never resubmitted or
// treated as success.
export function createSigningCoordinator(
  onChange?: (request: PendingSigningRequest | null) => void,
) {
  let pending: PendingSigningRequest | null = null;
  let abandonCurrent: ((reason: Error) => void) | null = null;
  return {
    get pending() {
      return pending;
    },
    async run<T>(
      request: PendingSigningRequest,
      action: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      if (pending)
        throw new Error(
          `A ${pending.operation} signing request is already waiting for wallet approval.`,
        );
      const controller = new AbortController();
      pending = request;
      onChange?.(pending);
      const cancellation = new Promise<never>((_resolve, reject) => {
        abandonCurrent = (reason) => {
          controller.abort(reason);
          reject(reason);
        };
      });
      try {
        const actionPromise = Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return action(controller.signal);
        });
        return await Promise.race([actionPromise, cancellation]);
      } finally {
        abandonCurrent = null;
        if (pending === request) {
          pending = null;
          onChange?.(null);
        }
      }
    },
    /** Force-settles the current outstanding request (if any) to an explicit rejection. */
    abandon(reason: Error) {
      abandonCurrent?.(reason);
    },
  };
}

async function account(value: string): Promise<string> {
  const { StrKey } = await import("@stellar/stellar-sdk");
  if (!StrKey.isValidEd25519PublicKey(value))
    throw new Error("The wallet did not return a valid Stellar account.");
  return value;
}

// Races a wallet SDK call against a bound. If the timeout wins, the underlying promise's eventual
// outcome is still observed (so it cannot reject unhandled) but is otherwise discarded: a late
// response is never treated as success and never resubmitted.
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string,
  signing = false,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          signing
            ? `${timeoutMessage} The approval outcome is unknown. Close the wallet prompt and review before trying again. Nothing is automatically submitted.`
            : timeoutMessage,
        ),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(new Error(friendlyMessage(error)));
      },
    );
  });
}

async function albedoClient() {
  const intentModule = await import("@albedo-link/intent");
  const client = intentModule.default;
  return "default" in client ? (client.default as typeof client) : client;
}

export async function walletAddress(id: StellarWalletId, requestAccess = true): Promise<string> {
  switch (id) {
    case "freighter": {
      const api = await import("@stellar/freighter-api");
      const connected = await withTimeout(
        api.isConnected(),
        WALLET_CONNECT_TIMEOUT_MS,
        "Freighter did not respond. Open the extension and try again.",
      );
      if (!connected.isConnected) throw new Error("Install and open Freighter to connect.");
      const result = await withTimeout(
        requestAccess ? api.requestAccess() : api.getAddress(),
        WALLET_CONNECT_TIMEOUT_MS,
        "Freighter closed or did not respond to the connection request. Open the extension and try again.",
      );
      if (result.error) throwWalletError(result.error);
      return account(result.address);
    }
    case "albedo": {
      const result = await withTimeout(
        (await albedoClient()).publicKey({}),
        WALLET_CONNECT_TIMEOUT_MS,
        "Albedo closed or did not respond to the connection request. Reopen the popup and try again.",
      );
      return account(result.pubkey);
    }
    case "xbull": {
      const { xBullWalletConnect } = await import("@creit.tech/xbull-wallet-connect");
      const bridge = new xBullWalletConnect();
      try {
        const connected = await withTimeout(
          bridge.connect(),
          WALLET_CONNECT_TIMEOUT_MS,
          "xBull closed or did not respond to the connection request. Reopen the extension and try again.",
        );
        return await account(connected);
      } finally {
        bridge.closeConnections();
      }
    }
    case "lobstr": {
      const api = await import("@lobstrco/signer-extension-api");
      const connected = await withTimeout(
        api.isConnected(),
        WALLET_CONNECT_TIMEOUT_MS,
        "LOBSTR did not respond. Open the extension and try again.",
      );
      if (!connected) throw new Error("Install and open LOBSTR to connect.");
      return account(
        await withTimeout(
          api.getPublicKey(),
          WALLET_CONNECT_TIMEOUT_MS,
          "LOBSTR closed or did not respond to the connection request. Open the extension and try again.",
        ),
      );
    }
  }
}

export async function walletSign(
  id: StellarWalletId,
  xdr: string,
  address: string,
  approval?: WalletApprovalProvenance,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (approval) assertWalletApproval(approval, address);
  if (approval && (id === "albedo" || id === "xbull")) {
    const actual = await walletAddress(id, false);
    if (actual !== address)
      throw new Error("The wallet account changed. Review the transaction again.");
  }
  let signed: string;
  switch (id) {
    case "freighter": {
      const api = await import("@stellar/freighter-api");
      const actual = await walletAddress(id, false);
      if (actual !== address) throw new Error("Your wallet account changed. Connect again.");
      const network = await withTimeout(
        api.getNetworkDetails(),
        WALLET_CONNECT_TIMEOUT_MS,
        "Freighter did not respond. Open the extension and try again.",
      );
      if (network.error) throwWalletError(network.error);
      if (network.networkPassphrase !== TESTNET.networkPassphrase)
        throw new Error("Switch Freighter to Stellar Testnet before signing.");
      signal?.throwIfAborted();
      const result = await withTimeout(
        api.signTransaction(xdr, {
          networkPassphrase: TESTNET.networkPassphrase,
          address,
        }),
        WALLET_SIGN_TIMEOUT_MS,
        "Freighter closed or did not respond to the signature request. Reopen Freighter and try again.",
        true,
      );
      if (result.error) throwWalletError(result.error);
      signed = result.signedTxXdr;
      break;
    }
    case "albedo": {
      const client = await albedoClient();
      signal?.throwIfAborted();
      const result = await withTimeout(
        client.tx({
          xdr,
          pubkey: address,
          network: "testnet",
          submit: false,
        }),
        WALLET_SIGN_TIMEOUT_MS,
        "Albedo closed or did not respond to the signature request. Reopen the popup and try again.",
        true,
      );
      signed = result.signed_envelope_xdr;
      break;
    }
    case "xbull": {
      const { xBullWalletConnect } = await import("@creit.tech/xbull-wallet-connect");
      const bridge = new xBullWalletConnect();
      try {
        signal?.throwIfAborted();
        signed = await withTimeout(
          bridge.sign({ xdr, publicKey: address, network: TESTNET.networkPassphrase }),
          WALLET_SIGN_TIMEOUT_MS,
          "xBull closed or did not respond to the signature request. Reopen the extension and try again.",
          true,
        );
      } finally {
        bridge.closeConnections();
      }
      break;
    }
    case "lobstr": {
      const api = await import("@lobstrco/signer-extension-api");
      if ((await walletAddress(id, false)) !== address)
        throw new Error("Your wallet account changed. Connect again.");
      signal?.throwIfAborted();
      signed = await withTimeout(
        api.signTransaction(xdr),
        WALLET_SIGN_TIMEOUT_MS,
        "LOBSTR closed or did not respond to the signature request. Reopen the extension and try again.",
        true,
      );
      break;
    }
  }
  signal?.throwIfAborted();
  const { verifyWalletSignature } = await import("./signature");
  signal?.throwIfAborted();
  return { signedTxXdr: verifyWalletSignature(xdr, signed, address) };
}
