export interface EvmWalletState {
  address: `0x${string}` | undefined;
  shortAddress: string | null;
  chainId: number | undefined;
  chainName: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  switchChain: (targetChainId: number) => Promise<void>;
}
