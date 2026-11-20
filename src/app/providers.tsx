"use client";

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { WalletProvider } from "../wallets";
import { detectRuntimeCapabilities } from "../lib/runtime-capabilities";
import { message } from "../lib/messages";
import { publicConfigurationAdmission } from "../config/testnet";

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
  const admission = publicConfigurationAdmission();
  if (!admission.available) {
    return (
      <main role="alert" aria-labelledby="configuration-title">
        <h1 id="configuration-title">Bridge unavailable</h1>
        <p>The public deployment configuration cannot be safely admitted.</p>
        <ul>
          {admission.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </main>
    );
  }
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
