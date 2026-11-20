"use client";

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { WalletProvider } from "../wallets";
import { STELLAR_DEPLOYMENT, publicConfigurationAdmission } from "../config/testnet";
import {
  detectRuntimeCapabilities,
  initialRuntimeCapabilities,
  type RuntimeCapabilities,
} from "../lib/runtime-capabilities";
import { RuntimeCapabilitiesProvider } from "../lib/runtime-capabilities-context";
import { formatMessage, type TranslationCatalog } from "../lib/messages";
import styles from "./providers.module.css";

const DEPLOYMENT_STORAGE_KEY = "hyperion.deployment.commit";

export interface ProvidersProps {
  readonly children: ReactNode;
  readonly translations?: TranslationCatalog;
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

export function Providers({ children, translations }: ProvidersProps): ReactElement {
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities>(initialRuntimeCapabilities);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const admission = publicConfigurationAdmission();
  useEffect(() => {
    if (!admission.available) return;
    const owned = new AbortController();
    controller.current = owned;
    inFlight.current = true;
    void detectRuntimeCapabilities(owned.signal).then((value) => {
      if (controller.current === owned && !owned.signal.aborted) {
        setCapabilities(value);
        inFlight.current = false;
      }
    });
    return () => {
      owned.abort();
      controller.current?.abort();
      controller.current = null;
      inFlight.current = false;
    };
  }, [admission.available]);
  const refresh = () => {
    if (inFlight.current || !admission.available || !controller.current) return;
    const owned = new AbortController();
    controller.current = owned;
    inFlight.current = true;
    setCapabilities(initialRuntimeCapabilities);
    void detectRuntimeCapabilities(owned.signal).then((value) => {
      if (controller.current === owned && !owned.signal.aborted) {
        setCapabilities(value);
        inFlight.current = false;
      }
    });
  };
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
  const states = Object.values(capabilities.routes);
  const checking = states.includes("checking");
  const diagnostic = checking
    ? "runtimeChecking"
    : states.includes("missing")
      ? "staticFeeUnavailable"
      : "runtimeUnknown";
  return (
    <RuntimeCapabilitiesProvider
      value={{ capabilities, refresh }}
      {...(translations ? { translations } : {})}
    >
      <WalletProvider>
        <DeploymentRevisionNotice />
        {children}
        {states.some((state) => state !== "available") && (
          <section className={styles.diagnostic} aria-label="Live fee availability">
            <p role="status">{formatMessage(translations, diagnostic)}</p>
            <ul>
              <li>
                {formatMessage(
                  translations,
                  capabilities.routes.relay === "available"
                    ? "runtimeRouteAvailable"
                    : "runtimeRouteUnavailable",
                  { provider: "Axelar ITS" },
                )}
              </li>
              <li>
                {formatMessage(
                  translations,
                  capabilities.routes.cctp === "available"
                    ? "runtimeRouteAvailable"
                    : "runtimeRouteUnavailable",
                  { provider: "Circle CCTP" },
                )}
              </li>
            </ul>
            <button
              className={styles.retry}
              type="button"
              onClick={refresh}
              disabled={checking}
              aria-busy={checking}
            >
              {formatMessage(translations, "runtimeRetry")}
            </button>
          </section>
        )}
      </WalletProvider>
    </RuntimeCapabilitiesProvider>
  );
}

export { WalletProvider };
export default Providers;
