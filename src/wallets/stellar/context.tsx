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
import {
  ConcurrencyGuard,
  assertWalletMethodSupported,
  getAllWalletCapabilities,
  getAllWalletDiagnostics,
  getWalletCapabilities,
  getWalletDiagnostics,
  subscribeToAccountChange,
} from "./sdk";
import { isAmbiguousNetworkError, validateSignatureResult } from "./signature";
import type {
  StellarNetworkName,
  StellarWalletContextValue,
  WalletCapabilities,
  WalletDiagnostics,
} from "./types";

const STORAGE_KEY = "hyperion.stellar.wallet";
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
  const [isSigning, setIsSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kitRef = useRef<KitInstance | null>(null);
  const initPromiseRef = useRef<Promise<KitInstance> | null>(null);
  const concurrencyGuardRef = useRef<ConcurrencyGuard>(new ConcurrencyGuard());
  const accountListenersRef = useRef<Set<(newAddress: string | null) => void>>(new Set());

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

  // Restore stored session on mount
  useEffect(() => {
    let cancelled = false;

    function restoreSession() {
      if (typeof window === "undefined") return;
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;

      try {
        const parsed = JSON.parse(saved) as { address?: string; walletId?: string };
        if (parsed.address && !cancelled) {
          setAddress(parsed.address);
          setWalletId(parsed.walletId ?? null);
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }

    restoreSession();
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen to account changes from active wallet adapter
  useEffect(() => {
    if (!walletId) return;

    const unsubscribe = subscribeToAccountChange(walletId, (newAddr) => {
      if (newAddr && newAddr !== address) {
        setAddress(newAddr);
        if (typeof window !== "undefined") {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ address: newAddr, walletId }));
        }
        for (const listener of accountListenersRef.current) {
          listener(newAddr);
        }
      } else if (newAddr === null) {
        setAddress(null);
        setWalletId(null);
        if (typeof window !== "undefined") {
          localStorage.removeItem(STORAGE_KEY);
        }
        for (const listener of accountListenersRef.current) {
          listener(null);
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [walletId, address]);

  const activeCapabilities = useMemo<WalletCapabilities | null>(() => {
    if (!walletId) return null;
    try {
      return getWalletCapabilities(walletId);
    } catch {
      return null;
    }
  }, [walletId]);

  const wallets = useMemo<WalletCapabilities[]>(() => {
    try {
      return getAllWalletCapabilities();
    } catch {
      return [];
    }
  }, []);

  const connect = useCallback(
    async (preferredWalletId?: string): Promise<string | null> => {
      const guard = concurrencyGuardRef.current;
      try {
        guard.acquireConnect();
      } catch (concurrencyErr) {
        const msg =
          concurrencyErr instanceof Error
            ? concurrencyErr.message
            : "Connection attempt already pending.";
        setError(msg);
        return null;
      }

      setIsConnecting(true);
      setError(null);

      try {
        if (preferredWalletId) {
          const caps = getWalletCapabilities(preferredWalletId);
          if (caps.availability === "missing_extension") {
            const missingMsg = `Wallet "${caps.name}" requires an extension that is not installed.`;
            setError(missingMsg);
            return null;
          }
        }

        const kit = await getKit();
        let connectedAddress: string;

        if (preferredWalletId) {
          kit.setWallet(preferredWalletId);
          const res = await kit.fetchAddress();
          connectedAddress = res.address;
          setWalletId(preferredWalletId);
        } else {
          const res = await kit.authModal();
          connectedAddress = res.address;
        }

        setAddress(connectedAddress);
        if (typeof window !== "undefined") {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ address: connectedAddress, walletId: preferredWalletId ?? null }),
          );
        }
        return connectedAddress;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to connect Stellar wallet";
        setError(message);
        return null;
      } finally {
        setIsConnecting(false);
        guard.releaseConnect();
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
      }
    }
  }, []);

  const signTransaction = useCallback(
    async (
      xdr: string,
      opts?: { networkPassphrase?: string },
    ): Promise<{ signedTxXdr: string }> => {
      if (walletId) {
        assertWalletMethodSupported(walletId, "signTransaction");
      }

      const guard = concurrencyGuardRef.current;
      guard.acquireSign();
      setIsSigning(true);
      setError(null);

      try {
        const kit = await getKit();
        const res = await kit.signTransaction(xdr, opts);
        const validation = validateSignatureResult(res);
        if (!validation.valid) {
          throw new Error(validation.error ?? "Invalid transaction signature response.");
        }
        return res;
      } catch (err) {
        if (isAmbiguousNetworkError(err)) {
          setError(
            "Transaction submission was ambiguous; verify ledger close before resubmitting.",
          );
        }
        throw err;
      } finally {
        setIsSigning(false);
        guard.releaseSign();
      }
    },
    [getKit, walletId],
  );

  const signAuthEntry = useCallback(
    async (
      entryXdr: string,
      opts?: { networkPassphrase?: string },
    ): Promise<{ signedAuthEntry: string }> => {
      if (walletId) {
        assertWalletMethodSupported(walletId, "signAuthEntry");
      }

      const guard = concurrencyGuardRef.current;
      guard.acquireSign();
      setIsSigning(true);
      setError(null);

      try {
        const kit = await getKit();
        const res = await kit.signAuthEntry(entryXdr, opts);
        const validation = validateSignatureResult(res);
        if (!validation.valid) {
          throw new Error(validation.error ?? "Invalid auth entry signature response.");
        }
        return res;
      } catch (err) {
        if (isAmbiguousNetworkError(err)) {
          setError(
            "Auth entry response was ambiguous; verify ledger close before resubmitting.",
          );
        }
        throw err;
      } finally {
        setIsSigning(false);
        guard.releaseSign();
      }
    },
    [getKit, walletId],
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

  const getDiagnostics = useCallback(
    (targetWalletId?: string): WalletDiagnostics | WalletDiagnostics[] => {
      if (targetWalletId) {
        return getWalletDiagnostics(targetWalletId);
      }
      return getAllWalletDiagnostics();
    },
    [],
  );

  const onAccountChange = useCallback(
    (handler: (newAddress: string | null) => void): (() => void) => {
      accountListenersRef.current.add(handler);
      return () => {
        accountListenersRef.current.delete(handler);
      };
    },
    [],
  );

  const shortAddress = useMemo(() => (address ? truncateAddress(address) : null), [address]);

  const value = useMemo<StellarWalletContextValue>(
    () => ({
      address,
      shortAddress,
      isConnected: address !== null,
      isConnecting,
      isSigning,
      walletId,
      network,
      error,
      activeCapabilities,
      wallets,
      connect,
      disconnect,
      signTransaction,
      signAuthEntry,
      setNetwork,
      getDiagnostics,
      onAccountChange,
    }),
    [
      address,
      shortAddress,
      isConnecting,
      isSigning,
      walletId,
      network,
      error,
      activeCapabilities,
      wallets,
      connect,
      disconnect,
      signTransaction,
      signAuthEntry,
      setNetwork,
      getDiagnostics,
      onAccountChange,
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
