"use client";
import type { ReactNode } from "react";
import { StellarWalletProvider } from "./stellar";
export function WalletProvider({ children }: { children: ReactNode }) {
  return <StellarWalletProvider>{children}</StellarWalletProvider>;
}
