"use client";

import type { ReactElement, ReactNode } from "react";
import { WalletProvider } from "../wallets";

export interface ProvidersProps {
  readonly children: ReactNode;
}

export function Providers({ children }: ProvidersProps): ReactElement {
  return <WalletProvider>{children}</WalletProvider>;
}

export { WalletProvider };
export default Providers;
