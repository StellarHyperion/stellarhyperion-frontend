"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useConnection, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import type { EvmWalletState } from "./types";

const EVM_CONNECTED_KEY = "evm_wallet_connected";
const EVM_CONNECTOR_ID_KEY = "evm_connector_id";
const EVM_ADDRESS_KEY = "evm_wallet_address";

function truncateAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function useEvmWallet(): EvmWalletState {
  const connection = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connectAsync, isPending: isConnectingWallet } = useConnect();
  const { mutateAsync: disconnectAsync } = useDisconnect();
  const { mutateAsync: switchChainAsync } = useSwitchChain();

  const address = connection.address;
  const chainId = connection.chainId;
  const chain = connection.chain;
  const isConnected = connection.isConnected;
  const isConnecting = connection.isConnecting || isConnectingWallet;

  const reconnectAttemptedRef = useRef(false);

  // Attempt silent reconnect on mount if previously authorized
  useEffect(() => {
    if (typeof window === "undefined" || reconnectAttemptedRef.current) return;
    const wasConnected = localStorage.getItem(EVM_CONNECTED_KEY) === "true";
    if (!wasConnected || isConnected) return;

    reconnectAttemptedRef.current = true;
    const savedConnectorId = localStorage.getItem(EVM_CONNECTOR_ID_KEY);
    const targetConnector =
      (savedConnectorId ? connectors.find((c) => c.id === savedConnectorId) : null) ??
      connectors[0];

    if (!targetConnector) return;

    void (async () => {
      try {
        const isAuth = await targetConnector.isAuthorized();
        if (isAuth) {
          await connectAsync({ connector: targetConnector });
        } else {
          localStorage.removeItem(EVM_CONNECTED_KEY);
          localStorage.removeItem(EVM_CONNECTOR_ID_KEY);
          localStorage.removeItem(EVM_ADDRESS_KEY);
        }
      } catch {
        localStorage.removeItem(EVM_CONNECTED_KEY);
        localStorage.removeItem(EVM_CONNECTOR_ID_KEY);
        localStorage.removeItem(EVM_ADDRESS_KEY);
      }
    })();
  }, [connectAsync, connectors, isConnected]);

  // Keep saved address updated when connected
  useEffect(() => {
    if (typeof window !== "undefined" && isConnected && address) {
      localStorage.setItem(EVM_CONNECTED_KEY, "true");
      localStorage.setItem(EVM_ADDRESS_KEY, address);
    }
  }, [isConnected, address]);

  const connect = useCallback(async (): Promise<void> => {
    const connector = connectors[0];
    if (connector) {
      await connectAsync({ connector });
      if (typeof window !== "undefined") {
        localStorage.setItem(EVM_CONNECTED_KEY, "true");
        localStorage.setItem(EVM_CONNECTOR_ID_KEY, connector.id);
      }
    }
  }, [connectAsync, connectors]);

  const disconnect = useCallback(async (): Promise<void> => {
    await disconnectAsync();
    if (typeof window !== "undefined") {
      localStorage.removeItem(EVM_CONNECTED_KEY);
      localStorage.removeItem(EVM_CONNECTOR_ID_KEY);
      localStorage.removeItem(EVM_ADDRESS_KEY);
    }
  }, [disconnectAsync]);

  const switchChain = useCallback(
    async (targetChainId: number): Promise<void> => {
      await switchChainAsync({ chainId: targetChainId });
    },
    [switchChainAsync],
  );

  const shortAddress = useMemo(() => (address ? truncateAddress(address) : null), [address]);

  return {
    address,
    shortAddress,
    chainId,
    chainName: chain?.name ?? (chainId ? `chain ${chainId}` : null),
    isConnected,
    isConnecting,
    connect,
    disconnect,
    switchChain,
  };
}
