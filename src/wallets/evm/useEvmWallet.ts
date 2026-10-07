"use client";

import { useCallback, useMemo } from "react";
import { useConnection, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import type { EvmWalletState } from "./types";

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

  const connect = useCallback(async (): Promise<void> => {
    const connector = connectors[0];
    if (connector) {
      await connectAsync({ connector });
    }
  }, [connectAsync, connectors]);

  const disconnect = useCallback(async (): Promise<void> => {
    await disconnectAsync();
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
