"use client";

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { WalletProvider } from "../wallets";
import {
  STELLAR_DEPLOYMENT,
  publicConfigurationAdmission,
  parsePublicDeploymentIdentity,
  deploymentIdentityMatches,
} from "../config/testnet";
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
  const [deploymentCheck, setDeploymentCheck] = useState<
    "checking" | "current" | "changed" | "unavailable"
  >("checking");
  const [deploymentRetry, setDeploymentRetry] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const admission = publicConfigurationAdmission();
  useEffect(() => {
    if (!admission.available) return;
    const owned = new AbortController();
    let active = true;
    let checking = false;
    let deploymentChanged = false;
    const check = async () => {
      if (!active || checking || deploymentChanged) return;
      checking = true;
      try {
        const response = await fetch("/api/deployment", {
          cache: "no-store",
          redirect: "error",
          signal: owned.signal,
        });
        if (!response.ok) throw new Error("The active deployment could not be checked.");
        const body: unknown = await response.json();
        const identity =
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as { identity?: unknown }).identity
            : undefined;
        if (!parsePublicDeploymentIdentity(identity))
          throw new Error("The active deployment identity is invalid.");
        if (deploymentIdentityMatches(identity)) setDeploymentCheck("current");
        else {
          deploymentChanged = true;
          setDeploymentCheck("changed");
        }
      } catch {
        if (active && !owned.signal.aborted) setDeploymentCheck("unavailable");
      } finally {
        checking = false;
      }
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    void check();
    const timer = window.setInterval(checkWhenVisible, 30_000);
    document.addEventListener("visibilitychange", checkWhenVisible);
    window.addEventListener("focus", checkWhenVisible);
    return () => {
      active = false;
      owned.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkWhenVisible);
      window.removeEventListener("focus", checkWhenVisible);
    };
  }, [admission.available, deploymentRetry]);
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
  const deploymentReady = deploymentCheck === "current";
  return (
    <RuntimeCapabilitiesProvider
      value={{
        capabilities,
        refresh,
        deploymentReady,
        deploymentUpdateAvailable: deploymentCheck === "changed",
      }}
      {...(translations ? { translations } : {})}
    >
      <WalletProvider>
        <DeploymentRevisionNotice />
        {children}
        {deploymentCheck !== "current" && (
          <section
            className={styles.deploymentNotice}
            role={deploymentCheck === "changed" ? "alert" : "status"}
            aria-label="Deployment revision"
          >
            <p>
              {deploymentCheck === "changed"
                ? "A newer testnet deployment is active. Unsigned quotes and reviews are no longer valid."
                : deploymentCheck === "unavailable"
                  ? "The active deployment could not be verified. Transfer quotes and signing are paused."
                  : "Checking the active testnet deployment before enabling transfer quotes."}
            </p>
            <p>
              Reload to use the active deployment. Saved transaction hashes are kept and must be
              checked before another approval. Source confirmation and destination delivery remain
              separate.
            </p>
            {deploymentCheck === "changed" ? (
              <button
                className={styles.retry}
                type="button"
                onClick={() => window.location.reload()}
              >
                Reload active deployment
              </button>
            ) : deploymentCheck === "unavailable" ? (
              <button
                className={styles.retry}
                type="button"
                onClick={() => {
                  setDeploymentCheck("checking");
                  setDeploymentRetry((value) => value + 1);
                }}
              >
                Retry deployment check
              </button>
            ) : null}
          </section>
        )}
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
