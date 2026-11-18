import { TESTNET } from "../../config/testnet";
import { assertWalletApproval } from "./signature";
import type { WalletApprovalProvenance } from "./types";
import { withTimeout, WalletSigningUncertainError } from "./timeout";

/** Checking whether an extension is installed and open. Fast by nature, so bounded tightly. */
const AVAILABILITY_TIMEOUT_MS = 8_000;
/** Returning an account, with or without a user-visible access prompt. */
const ACCOUNT_TIMEOUT_MS = 20_000;
/** Approving a signature. Generous, since this is a human reading and approving a transaction. */
const SIGNING_TIMEOUT_MS = 120_000;

export const STELLAR_WALLETS = [
  { id: "freighter", name: "Freighter", url: "https://www.freighter.app/" },
  { id: "albedo", name: "Albedo", url: "https://albedo.link/" },
  { id: "xbull", name: "xBull", url: "https://xbull.app/" },
  { id: "lobstr", name: "LOBSTR", url: "https://lobstr.co/" },
] as const;
export type StellarWalletId = (typeof STELLAR_WALLETS)[number]["id"];
export const isWalletId = (value: string | null): value is StellarWalletId =>
  STELLAR_WALLETS.some((wallet) => wallet.id === value);

export type SigningOperation =
  "bridge" | "conversion" | "claim" | "claim-settlement" | "transaction";
export interface PendingSigningRequest {
  operation: SigningOperation;
  account: string;
}

export function createSigningCoordinator(
  onChange?: (request: PendingSigningRequest | null) => void,
) {
  let pending: PendingSigningRequest | null = null;
  return {
    get pending() {
      return pending;
    },
    async run<T>(request: PendingSigningRequest, action: () => Promise<T>): Promise<T> {
      if (pending) {
        throw new Error(
          `A ${pending.operation} signing request is already waiting for wallet approval.`,
        );
      }
      pending = request;
      onChange?.(pending);
      try {
        return await action();
      } finally {
        if (pending === request) {
          pending = null;
          onChange?.(null);
        }
      }
    },
  };
}

async function account(value: string): Promise<string> {
  const { StrKey } = await import("@stellar/stellar-sdk");
  if (!StrKey.isValidEd25519PublicKey(value))
    throw new Error("The wallet did not return a valid Stellar account.");
  return value;
}

function throwWalletError(error: unknown): never {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "The wallet request failed. Open your wallet and try again.";
  throw new Error(message);
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
        AVAILABILITY_TIMEOUT_MS,
        "Freighter did not respond. Open the extension and try again.",
      );
      if (!connected.isConnected) throw new Error("Install and open Freighter to connect.");
      const result = await withTimeout(
        requestAccess ? api.requestAccess() : api.getAddress(),
        ACCOUNT_TIMEOUT_MS,
        "Freighter did not return an account in time. Open the extension and try again.",
      );
      if (result.error) throwWalletError(result.error);
      return account(result.address);
    }
    case "albedo": {
      const result = await withTimeout(
        (await albedoClient()).publicKey({}),
        ACCOUNT_TIMEOUT_MS,
        "Albedo did not return an account in time. Try connecting again.",
      );
      return account(result.pubkey);
    }
    case "xbull": {
      const { xBullWalletConnect } = await import("@creit.tech/xbull-wallet-connect");
      const bridge = new xBullWalletConnect();
      try {
        return await account(
          await withTimeout(
            bridge.connect(),
            ACCOUNT_TIMEOUT_MS,
            "xBull did not return an account in time. Try connecting again.",
          ),
        );
      } finally {
        bridge.closeConnections();
      }
    }
    case "lobstr": {
      const api = await import("@lobstrco/signer-extension-api");
      const connected = await withTimeout(
        api.isConnected(),
        AVAILABILITY_TIMEOUT_MS,
        "LOBSTR did not respond. Open the extension and try again.",
      );
      if (!connected) throw new Error("Install and open LOBSTR to connect.");
      return account(
        await withTimeout(
          api.getPublicKey(),
          ACCOUNT_TIMEOUT_MS,
          "LOBSTR did not return an account in time. Open the extension and try again.",
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
) {
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
        AVAILABILITY_TIMEOUT_MS,
        "Freighter did not return its network in time. Open the extension and try again.",
      );
      if (network.error) throwWalletError(network.error);
      if (network.networkPassphrase !== TESTNET.networkPassphrase)
        throw new Error("Switch Freighter to Stellar Testnet before signing.");
      const result = await withTimeout(
        api.signTransaction(xdr, { networkPassphrase: TESTNET.networkPassphrase, address }),
        SIGNING_TIMEOUT_MS,
        "Freighter did not respond to the signature request in time. Check Freighter for a pending request - Hyperion will not resubmit automatically.",
        WalletSigningUncertainError,
      );
      if (result.error) throwWalletError(result.error);
      signed = result.signedTxXdr;
      break;
    }
    case "albedo": {
      const result = await withTimeout(
        (await albedoClient()).tx({ xdr, pubkey: address, network: "testnet", submit: false }),
        SIGNING_TIMEOUT_MS,
        "Albedo did not respond to the signature request in time. Check Albedo for a pending request - Hyperion will not resubmit automatically.",
        WalletSigningUncertainError,
      );
      signed = result.signed_envelope_xdr;
      break;
    }
    case "xbull": {
      const { xBullWalletConnect } = await import("@creit.tech/xbull-wallet-connect");
      const bridge = new xBullWalletConnect();
      try {
        signed = await withTimeout(
          bridge.sign({ xdr, publicKey: address, network: TESTNET.networkPassphrase }),
          SIGNING_TIMEOUT_MS,
          "xBull did not respond to the signature request in time. Check xBull for a pending request - Hyperion will not resubmit automatically.",
          WalletSigningUncertainError,
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
      signed = await withTimeout(
        api.signTransaction(xdr),
        SIGNING_TIMEOUT_MS,
        "LOBSTR did not respond to the signature request in time. Check LOBSTR for a pending request - Hyperion will not resubmit automatically.",
        WalletSigningUncertainError,
      );
      break;
    }
  }
  const { verifyWalletSignature } = await import("./signature");
  return { signedTxXdr: verifyWalletSignature(xdr, signed, address) };
}
