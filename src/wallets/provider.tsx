"use client";

import type { ReactNode } from "react";
import { EvmWalletProvider } from "./evm";
import { StellarWalletProvider } from "./stellar";

export function WalletProvider({ children }: { children: ReactNode }) {
  return (
    <EvmWalletProvider>
      <StellarWalletProvider>{children}</StellarWalletProvider>
    </EvmWalletProvider>
  );
}
