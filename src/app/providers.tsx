"use client";

import type { ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";
import { STELLAR_DEPLOYMENT } from "../config/testnet";
import { WalletProvider } from "../wallets";

const DEPLOYMENT_STORAGE_KEY = "hyperion.deployment.commit";

export interface ProvidersProps {
  readonly children: ReactNode;
}

export function DeploymentRevisionNotice(): ReactElement | null {
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    let observed: string | null = document.documentElement.dataset.dplId ?? null;
    if (!observed) {
      const meta = document.querySelector('meta[name="hyperion-deployment-commit"]');
      observed = meta?.getAttribute("content") ?? null;
    }
    try {
      const cached = localStorage.getItem(DEPLOYMENT_STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (cached && cached !== STELLAR_DEPLOYMENT.commit) setChanged(true);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (observed && observed !== STELLAR_DEPLOYMENT.commit) setChanged(true);
      localStorage.setItem(DEPLOYMENT_STORAGE_KEY, STELLAR_DEPLOYMENT.commit);
    } catch {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (observed && observed !== STELLAR_DEPLOYMENT.commit) setChanged(true);
    }
  }, []);
  if (!changed) return null;
  return (
    <div role="status" aria-live="polite">
      <p>This page is using an older deployment. Refresh to load the current configuration.</p>
      <button
        type="button"
        onClick={() => {
          window.location.reload();
        }}
      >
        Refresh
      </button>
    </div>
  );
}

export function Providers({ children }: ProvidersProps): ReactElement {
  return (
    <WalletProvider>
      <DeploymentRevisionNotice />
      {children}
    </WalletProvider>
  );
}

export { WalletProvider };
export default Providers;
