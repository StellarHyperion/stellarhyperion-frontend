"use client";

import type { ReactElement, ReactNode } from "react";
import { WalletProvider } from "../wallets";
import { publicConfigurationAdmission } from "../config/testnet";

export interface ProvidersProps {
  readonly children: ReactNode;
}

export function Providers({ children }: ProvidersProps): ReactElement {
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
  return <WalletProvider>{children}</WalletProvider>;
}

export { WalletProvider };
export default Providers;
