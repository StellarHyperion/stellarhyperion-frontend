"use client";

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { WalletProvider } from "../wallets";
import { detectRuntimeCapabilities } from "../lib/runtime-capabilities";
import { message } from "../lib/messages";

export interface ProvidersProps {
  readonly children: ReactNode;
}

export function Providers({ children }: ProvidersProps): ReactElement {
  const [feeRoutes, setFeeRoutes] = useState<boolean | null>(null);
  useEffect(() => {
    void detectRuntimeCapabilities().then((value) => {
      setFeeRoutes(value.feeRoutes);
    });
  }, []);
  return (
    <WalletProvider>
      {children}
      {feeRoutes === false && (
        <p role="status" aria-live="polite">
          {message("staticFeeUnavailable")} Read-only history remains available where configured.
        </p>
      )}
    </WalletProvider>
  );
}

export { WalletProvider };
export default Providers;
