import { TESTNET } from "../../config/testnet";

export const STELLAR_WALLETS = [
  { id: "freighter", name: "Freighter", url: "https://www.freighter.app/" },
  { id: "albedo", name: "Albedo", url: "https://albedo.link/" },
  { id: "xbull", name: "xBull", url: "https://xbull.app/" },
  { id: "lobstr", name: "LOBSTR", url: "https://lobstr.co/" },
] as const;
export type StellarWalletId = (typeof STELLAR_WALLETS)[number]["id"];
export const isWalletId = (value: string | null): value is StellarWalletId =>
  STELLAR_WALLETS.some((wallet) => wallet.id === value);

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
      if (!(await api.isConnected()).isConnected)
        throw new Error("Install and open Freighter to connect.");
      const result = await (requestAccess ? api.requestAccess() : api.getAddress());
      if (result.error) throwWalletError(result.error);
      return account(result.address);
    }
    case "albedo": {
      const result = await (await albedoClient()).publicKey({});
      return account(result.pubkey);
    }
    case "xbull": {
      const { xBullWalletConnect } = await import("@creit.tech/xbull-wallet-connect");
      const bridge = new xBullWalletConnect();
      try {
        return await account(await bridge.connect());
      } finally {
        bridge.closeConnections();
      }
    }
    case "lobstr": {
      const api = await import("@lobstrco/signer-extension-api");
      if (!(await api.isConnected())) throw new Error("Install and open LOBSTR to connect.");
      return account(await api.getPublicKey());
    }
  }
}

export async function walletCurrentAddress(
  id: StellarWalletId,
): Promise<string | null | undefined> {
  switch (id) {
    case "freighter": {
      const api = await import("@stellar/freighter-api");
      if (!(await api.isConnected()).isConnected) return null;
      const result = await api.getAddress();
      if (result.error) throwWalletError(result.error);
      return account(result.address);
    }
    case "lobstr": {
      const api = await import("@lobstrco/signer-extension-api");
      if (!(await api.isConnected())) return null;
      return account(await api.getPublicKey());
    }
    case "albedo":
    case "xbull":
      return undefined;
  }
}

export async function walletSign(id: StellarWalletId, xdr: string, address: string) {
  const currentAddress = await walletCurrentAddress(id);
  if (currentAddress !== undefined && currentAddress !== address)
    throw new Error("Your wallet account changed. Connect again.");

  let signed: string;
  switch (id) {
    case "freighter": {
      const api = await import("@stellar/freighter-api");
      const network = await api.getNetworkDetails();
      if (network.error) throwWalletError(network.error);
      if (network.networkPassphrase !== TESTNET.networkPassphrase)
        throw new Error("Switch Freighter to Stellar Testnet before signing.");
      const result = await api.signTransaction(xdr, {
        networkPassphrase: TESTNET.networkPassphrase,
        address,
      });
      if (result.error) throwWalletError(result.error);
      signed = result.signedTxXdr;
      break;
    }
    case "albedo": {
      const result = await (
        await albedoClient()
      ).tx({
        xdr,
        pubkey: address,
        network: "testnet",
        submit: false,
      });
      signed = result.signed_envelope_xdr;
      break;
    }
    case "xbull": {
      const { xBullWalletConnect } = await import("@creit.tech/xbull-wallet-connect");
      const bridge = new xBullWalletConnect();
      try {
        signed = await bridge.sign({ xdr, publicKey: address, network: TESTNET.networkPassphrase });
      } finally {
        bridge.closeConnections();
      }
      break;
    }
    case "lobstr": {
      const api = await import("@lobstrco/signer-extension-api");
      signed = await api.signTransaction(xdr);
      break;
    }
  }
  const { verifyWalletSignature } = await import("./signature");
  return { signedTxXdr: verifyWalletSignature(xdr, signed, address) };
}
