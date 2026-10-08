"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { StellarNetworkName, StellarWalletContextValue } from "./types";

const STORAGE_KEY = "hyperion.stellar.wallet";
const STELLAR_WALLET_ID_KEY = "stellar_wallet_id";
const STELLAR_WALLET_ADDRESS_KEY = "stellar_wallet_address";
const DEFAULT_NETWORK: StellarNetworkName = "TESTNET";

const StellarWalletContext = createContext<StellarWalletContextValue | null>(null);

function truncateAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

interface KitInstance {
  init: (params: unknown) => void;
  setNetwork: (network: unknown) => void;
  setWallet: (id: string) => void;
  getAddress: () => Promise<{ address: string }>;
  fetchAddress: () => Promise<{ address: string }>;
  authModal: () => Promise<{ address: string }>;
  disconnect: () => Promise<void>;
  signTransaction: (
    xdr: string,
    opts?: { networkPassphrase?: string },
  ) => Promise<{ signedTxXdr: string }>;
  signAuthEntry: (
    authEntry: string,
    opts?: { networkPassphrase?: string },
  ) => Promise<{ signedAuthEntry: string }>;
}

export function StellarWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [network, setNetworkState] = useState<StellarNetworkName>(DEFAULT_NETWORK);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kitRef = useRef<KitInstance | null>(null);
  const initPromiseRef = useRef<Promise<KitInstance> | null>(null);

  const getKit = useCallback(async (): Promise<KitInstance> => {
    if (kitRef.current) return kitRef.current;
    if (initPromiseRef.current) return initPromiseRef.current;

    const promise = (async () => {
      const { StellarWalletsKit, Networks } = await import("@creit.tech/stellar-wallets-kit");
      const { FreighterModule } = await import("@creit.tech/stellar-wallets-kit/modules/freighter");
      const { xBullModule } = await import("@creit.tech/stellar-wallets-kit/modules/xbull");
      const { AlbedoModule } = await import("@creit.tech/stellar-wallets-kit/modules/albedo");
      const { LobstrModule } = await import("@creit.tech/stellar-wallets-kit/modules/lobstr");

      const modules = [
        new FreighterModule(),
        new xBullModule(),
        new AlbedoModule(),
        new LobstrModule(),
      ];

      const chosenNetwork = network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;

      StellarWalletsKit.init({
        modules,
        network: chosenNetwork,
      });

      kitRef.current = StellarWalletsKit as unknown as KitInstance;
      return kitRef.current;
    })();

    initPromiseRef.current = promise;
    return promise;
  }, [network]);

  // Attempt auto-reconnect on mount if a saved session exists
  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      if (typeof window === "undefined") return;

      let savedWalletId = localStorage.getItem(STELLAR_WALLET_ID_KEY);
      let savedAddress = localStorage.getItem(STELLAR_WALLET_ADDRESS_KEY);

      if (!savedWalletId || !savedAddress) {
        const legacy = localStorage.getItem(STORAGE_KEY);
        if (legacy) {
          try {
            const parsed = JSON.parse(legacy) as { address?: string; walletId?: string };
            savedWalletId = savedWalletId ?? parsed.walletId ?? null;
            savedAddress = savedAddress ?? parsed.address ?? null;
          } catch {
            localStorage.removeItem(STORAGE_KEY);
          }
        }
      }

      if (!savedAddress && !savedWalletId) return;

      if (savedAddress && !cancelled) {
        setAddress(savedAddress);
      }
      if (savedWalletId && !cancelled) {
        setWalletId(savedWalletId);
      }

      if (savedWalletId) {
        try {
          const kit = await getKit();
          kit.setWallet(savedWalletId);
          const res = await kit.fetchAddress();
          if (res.address && !cancelled) {
            setAddress(res.address);
            localStorage.setItem(STELLAR_WALLET_ADDRESS_KEY, res.address);
          }
        } catch {
          // If silent check fails because extension is closed or denied, reset
          if (!cancelled) {
            setAddress(null);
            setWalletId(null);
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(STELLAR_WALLET_ID_KEY);
            localStorage.removeItem(STELLAR_WALLET_ADDRESS_KEY);
          }
        }
      }
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [getKit]);

  const connect = useCallback(
    async (preferredWalletId?: string): Promise<string | null> => {
      setIsConnecting(true);
      setError(null);

      try {
        const kit = await getKit();
        let connectedAddress: string;
        let chosenWalletId = preferredWalletId ?? null;

        if (preferredWalletId) {
          kit.setWallet(preferredWalletId);
          const res = await kit.fetchAddress();
          connectedAddress = res.address;
        } else {
          const res = await kit.authModal();
          connectedAddress = res.address;
          try {
            const activeModule = (
              kit as unknown as { selectedModule?: { productId?: string; id?: string } }
            ).selectedModule;
            chosenWalletId =
              activeModule?.productId ?? activeModule?.id ?? preferredWalletId ?? null;
          } catch {
            // Keep default
          }
        }

        setAddress(connectedAddress);
        setWalletId(chosenWalletId);
        if (typeof window !== "undefined") {
          if (chosenWalletId) {
            localStorage.setItem(STELLAR_WALLET_ID_KEY, chosenWalletId);
          }
          localStorage.setItem(STELLAR_WALLET_ADDRESS_KEY, connectedAddress);
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ address: connectedAddress, walletId: chosenWalletId }),
          );
        }
        return connectedAddress;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to connect Stellar wallet";
        setError(message);
        return null;
      } finally {
        setIsConnecting(false);
      }
    },
    [getKit],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    try {
      if (kitRef.current) {
        await kitRef.current.disconnect();
      }
    } catch {
      // Ignore disconnect errors
    } finally {
      setAddress(null);
      setWalletId(null);
      setError(null);
      if (typeof window !== "undefined") {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(STELLAR_WALLET_ID_KEY);
        localStorage.removeItem(STELLAR_WALLET_ADDRESS_KEY);
      }
    }
  }, []);

  const signTransaction = useCallback(
    async (
      xdr: string,
      opts?: { networkPassphrase?: string },
    ): Promise<{ signedTxXdr: string }> => {
      const kit = await getKit();
      return kit.signTransaction(xdr, opts);
    },
    [getKit],
  );

  const signAuthEntry = useCallback(
    async (
      entryXdr: string,
      opts?: { networkPassphrase?: string },
    ): Promise<{ signedAuthEntry: string }> => {
      const kit = await getKit();
      return kit.signAuthEntry(entryXdr, opts);
    },
    [getKit],
  );

  const setNetwork = useCallback((nextNetwork: StellarNetworkName) => {
    setNetworkState(nextNetwork);
    if (kitRef.current) {
      import("@creit.tech/stellar-wallets-kit")
        .then(({ Networks }) => {
          const val = nextNetwork === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
          kitRef.current?.setNetwork(val);
        })
        .catch(() => {
          // Ignore failure to change network on kit
        });
    }
  }, []);

  const shortAddress = useMemo(() => (address ? truncateAddress(address) : null), [address]);

  const value = useMemo<StellarWalletContextValue>(
    () => ({
      address,
      shortAddress,
      isConnected: address !== null,
      isConnecting,
      walletId,
      network,
      error,
      connect,
      disconnect,
      signTransaction,
      signAuthEntry,
      setNetwork,
    }),
    [
      address,
      shortAddress,
      isConnecting,
      walletId,
      network,
      error,
      connect,
      disconnect,
      signTransaction,
      signAuthEntry,
      setNetwork,
    ],
  );

  return <StellarWalletContext.Provider value={value}>{children}</StellarWalletContext.Provider>;
}

export function useStellarWallet(): StellarWalletContextValue {
  const ctx = useContext(StellarWalletContext);
  if (!ctx) {
    throw new Error("useStellarWallet must be used within a StellarWalletProvider");
  }
  return ctx;
}
