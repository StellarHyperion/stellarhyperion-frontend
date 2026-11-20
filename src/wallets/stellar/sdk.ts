import { TESTNET } from "../../config/testnet";
import { assertWalletApproval } from "./signature";
import type { WalletApprovalProvenance } from "./types";
import {
  withTimeout as requestTimeout,
  WalletTimeoutError,
  WalletSigningUncertainError,
} from "./timeout";

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
export const WALLET_CONNECT_TIMEOUT_MS = 20_000;
export const WALLET_AVAILABILITY_TIMEOUT_MS = 8_000;
export const WALLET_SIGN_TIMEOUT_MS = 120_000;

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
  signal?: AbortSignal,
): Promise<T> {
  return requestTimeout(
    promise.catch((error: unknown) => {
      throw new Error(friendlyMessage(error));
    }),
    ms,
    signing
      ? `${timeoutMessage} The approval outcome is unknown. Close the wallet prompt and review before trying again. Nothing is automatically submitted.`
      : timeoutMessage,
    signing ? WalletSigningUncertainError : WalletTimeoutError,
    signal,
  );
}

export interface WalletConnectionGuidance {
  category:
    | "popup_blocked"
    | "access_denied"
    | "network_mismatch"
    | "extension_unavailable"
    | "connection_timeout"
    | "connection_failed";
  message: string;
  action: string;
  install: boolean;
}

export function walletErrorGuidance(error: unknown): WalletConnectionGuidance {
  const detail = friendlyMessage(error).slice(0, 512).toLowerCase();
  if (
    EXTENSION_LOST_PATTERN.test(detail) ||
    /extension.*(removed|reload|unavailable)|install and open/.test(detail)
  )
    return {
      category: "extension_unavailable",
      message: "This wallet extension is unavailable.",
      action: "Install or reopen the wallet from its official website, then retry the connection.",
      install: true,
    };
  if (/popup|pop-up|window.*(blocked|closed)/.test(detail))
    return {
      category: "popup_blocked",
      message: "The wallet popup was blocked or closed.",
      action: "Allow popups for this site in your browser, then retry the connection.",
      install: false,
    };
  if (/denied|reject|cancel/.test(detail))
    return {
      category: "access_denied",
      message: "Wallet access was declined.",
      action: "Retry when you are ready to approve access, or choose another wallet.",
      install: false,
    };
  if (/network|testnet/.test(detail))
    return {
      category: "network_mismatch",
      message: "The wallet is not connected to Stellar Testnet.",
      action: "Switch your wallet to Stellar Testnet, then retry the connection.",
      install: false,
    };
  if (/did not respond|did not return.*in time|timed? ?out/.test(detail))
    return {
      category: "connection_timeout",
      message: "The wallet did not respond in time.",
      action: "Open the wallet, close any old connection prompt, then retry when ready.",
      install: false,
    };
  return {
    category: "connection_failed",
    message: "The wallet could not be connected.",
    action: "Open the wallet and check its site permissions, then retry or choose another wallet.",
    install: false,
  };
}

async function albedoClient() {
  const intentModule = await import("@albedo-link/intent");
  const client = intentModule.default;
  return "default" in client ? (client.default as typeof client) : client;
}

export async function walletAddress(
  id: StellarWalletId,
  requestAccess = true,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  switch (id) {
    case "freighter": {
      const api = await import("@stellar/freighter-api");
      signal?.throwIfAborted();
      const connected = await withTimeout(
        api.isConnected(),
        WALLET_AVAILABILITY_TIMEOUT_MS,
        "Freighter did not respond. Open the extension and try again.",
        false,
        signal,
      );
      if (!connected.isConnected) throw new Error("Install and open Freighter to connect.");
      signal?.throwIfAborted();
      const result = await withTimeout(
        requestAccess ? api.requestAccess() : api.getAddress(),
        WALLET_CONNECT_TIMEOUT_MS,
        "Freighter did not return an account in time. Open the extension and try again.",
        false,
        signal,
      );
      if (result.error) throwWalletError(result.error);
      signal?.throwIfAborted();
      return account(result.address);
    }
    case "albedo": {
      const client = await albedoClient();
      signal?.throwIfAborted();
      const result = await withTimeout(
        client.publicKey({}),
        WALLET_CONNECT_TIMEOUT_MS,
        "Albedo closed or did not respond to the connection request. Reopen the popup and try again.",
        false,
        signal,
      );
      signal?.throwIfAborted();
      return account(result.pubkey);
    }
    case "xbull": {
      const { xBullWalletConnect } = await import("@creit.tech/xbull-wallet-connect");
      const bridge = new xBullWalletConnect();
      try {
        signal?.throwIfAborted();
        const connected = await withTimeout(
          bridge.connect(),
          WALLET_CONNECT_TIMEOUT_MS,
          "xBull closed or did not respond to the connection request. Reopen the extension and try again.",
          false,
          signal,
        );
        return await account(connected);
      } finally {
        bridge.closeConnections();
      }
    }
    case "lobstr": {
      const api = await import("@lobstrco/signer-extension-api");
      signal?.throwIfAborted();
      const connected = await withTimeout(
        api.isConnected(),
        WALLET_AVAILABILITY_TIMEOUT_MS,
        "LOBSTR did not respond. Open the extension and try again.",
        false,
        signal,
      );
      if (!connected) throw new Error("Install and open LOBSTR to connect.");
      signal?.throwIfAborted();
      return account(
        await withTimeout(
          api.getPublicKey(),
          WALLET_CONNECT_TIMEOUT_MS,
          "LOBSTR closed or did not respond to the connection request. Open the extension and try again.",
          false,
          signal,
        ),
      );
    }
  }
}

/** Query an extension account without opening a wallet access prompt. Popup wallets have no silent query. */
export async function walletCurrentAddress(
  id: StellarWalletId,
  signal?: AbortSignal,
): Promise<string | null | undefined> {
  if (id === "albedo" || id === "xbull") return undefined;
  signal?.throwIfAborted();
  if (id === "freighter") {
    const api = await import("@stellar/freighter-api");
    signal?.throwIfAborted();
    const connected = await withTimeout(
      api.isConnected(),
      WALLET_AVAILABILITY_TIMEOUT_MS,
      "Could not check Freighter availability.",
      false,
      signal,
    );
    if (!connected.isConnected) return null;
    signal?.throwIfAborted();
    const result = await withTimeout(
      api.getAddress(),
      WALLET_CONNECT_TIMEOUT_MS,
      "Could not check the Freighter account.",
      false,
      signal,
    );
    if (result.error) throwWalletError(result.error);
    return result.address ? account(result.address) : null;
  }
  const api = await import("@lobstrco/signer-extension-api");
  signal?.throwIfAborted();
  const connected = await withTimeout(
    api.isConnected(),
    WALLET_AVAILABILITY_TIMEOUT_MS,
    "Could not check LOBSTR availability.",
    false,
    signal,
  );
  if (!connected) return null;
  signal?.throwIfAborted();
  const address = await withTimeout(
    api.getPublicKey(),
    WALLET_CONNECT_TIMEOUT_MS,
    "Could not check the LOBSTR account.",
    false,
    signal,
  );
  return address ? account(address) : null;
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
    const actual = await walletAddress(id, false, signal);
    if (actual !== address)
      throw new Error("The wallet account changed. Review the transaction again.");
  }
  let signed: string;
  switch (id) {
    case "freighter": {
      const api = await import("@stellar/freighter-api");
      const actual = await walletAddress(id, false, signal);
      if (actual !== address) throw new Error("Your wallet account changed. Connect again.");
      signal?.throwIfAborted();
      const network = await withTimeout(
        api.getNetworkDetails(),
        WALLET_AVAILABILITY_TIMEOUT_MS,
        "Freighter did not respond. Open the extension and try again.",
        false,
        signal,
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
        signal,
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
        signal,
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
          signal,
        );
      } finally {
        bridge.closeConnections();
      }
      break;
    }
    case "lobstr": {
      const api = await import("@lobstrco/signer-extension-api");
      if ((await walletAddress(id, false, signal)) !== address)
        throw new Error("Your wallet account changed. Connect again.");
      signal?.throwIfAborted();
      signed = await withTimeout(
        api.signTransaction(xdr),
        WALLET_SIGN_TIMEOUT_MS,
        "LOBSTR closed or did not respond to the signature request. Reopen the extension and try again.",
        true,
        signal,
      );
      break;
    }
  }
  signal?.throwIfAborted();
  const { verifyWalletSignature } = await import("./signature");
  signal?.throwIfAborted();
  return { signedTxXdr: verifyWalletSignature(xdr, signed, address) };
}
