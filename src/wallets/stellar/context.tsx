"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { StellarWalletContextValue } from "./types";
import { TESTNET } from "../../config/testnet";

import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";

const WALLET_KEY = "hyperion.stellar.walletId";
type Kit = typeof StellarWalletsKit;
let kitPromise: Promise<Kit> | undefined;

async function getKit(): Promise<Kit> {
  kitPromise ??= (async () => {
    const [
      { StellarWalletsKit, Networks },
      { FreighterModule },
      { xBullModule },
      { AlbedoModule },
      { LobstrModule },
    ] = await Promise.all([
      import("@creit.tech/stellar-wallets-kit"),
      import("@creit.tech/stellar-wallets-kit/modules/freighter"),
      import("@creit.tech/stellar-wallets-kit/modules/xbull"),
      import("@creit.tech/stellar-wallets-kit/modules/albedo"),
      import("@creit.tech/stellar-wallets-kit/modules/lobstr"),
    ]);
    StellarWalletsKit.init({
      network: Networks.TESTNET,
      modules: [new FreighterModule(), new xBullModule(), new AlbedoModule(), new LobstrModule()],
    });
    return StellarWalletsKit;
  })().catch((error: unknown) => {
    kitPromise = undefined;
    throw error;
  });
  return kitPromise;
}
function readSavedWallet(): string | null {
  try {
    return localStorage.getItem(WALLET_KEY);
  } catch {
    return null;
  }
}
function saveWallet(id: string | null) {
  try {
    if (id) localStorage.setItem(WALLET_KEY, id);
    else localStorage.removeItem(WALLET_KEY);
  } catch {
    /* Wallet access still works without browser storage. */
  }
}
const Context = createContext<StellarWalletContextValue | null>(null);

export function StellarWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const saved = readSavedWallet();
    if (saved)
      void getKit()
        .then(async (kit) => {
          kit.setWallet(saved);
          const result = await kit.fetchAddress();
          if (active) setAddress(result.address);
        })
        .catch(() => {
          saveWallet(null);
        });
    return () => {
      active = false;
    };
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const kit = await getKit();
      const result = await kit.authModal();
      setAddress(result.address);
      saveWallet(kit.selectedModule.productId);
      return result.address;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection was declined.");
      return null;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setAddress(null);
    setError(null);
    saveWallet(null);
    try {
      await (await getKit()).disconnect();
    } catch {
      /* Local session has already been cleared. */
    }
  }, []);

  const signTransaction = useCallback(
    async (transaction: string, opts?: { networkPassphrase?: string }) => {
      if (!address) throw new Error("Connect your Stellar wallet first.");
      const kit = await getKit();
      const actual = await kit.fetchAddress();
      if (actual.address !== address) {
        setAddress(actual.address);
        throw new Error("Your wallet account changed. Review the transfer again.");
      }
      const network = await kit.getNetwork();
      if (network.networkPassphrase !== TESTNET.networkPassphrase)
        throw new Error("Switch your Stellar wallet to Testnet before signing.");
      const result = await kit.signTransaction(transaction, {
        ...opts,
        networkPassphrase: TESTNET.networkPassphrase,
        address,
      });
      if (result.signerAddress && result.signerAddress !== address)
        throw new Error("The wallet signed with a different account.");
      return result;
    },
    [address],
  );

  const value = useMemo(
    () => ({
      address,
      shortAddress: address ? `${address.slice(0, 6)}...${address.slice(-6)}` : null,
      isConnected: address !== null,
      isConnecting,
      error,
      connect,
      disconnect,
      signTransaction,
    }),
    [address, isConnecting, error, connect, disconnect, signTransaction],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useStellarWallet() {
  const value = useContext(Context);
  if (!value) throw new Error("useStellarWallet requires StellarWalletProvider.");
  return value;
}
