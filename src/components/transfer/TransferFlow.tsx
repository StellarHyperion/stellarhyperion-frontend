"use client";

import Link from "next/link";
import { useState, type ReactElement } from "react";
import { ExternalLink } from "lucide-react";
import { RouteKind } from "@hyperion/protocol";
import { submitBridgeOut, STELLAR_USDC_SAC_ID } from "../../contracts";
import { useStellarWallet } from "../../wallets/stellar";
import type { RoutePlannerHook } from "../../planner";
import { getExplorerUrl } from "../../lib/format";
import { StageLamps, type Stage } from "./StageLamps";
import styles from "./TransferFlow.module.css";

function getStagesForRoute(route: RouteKind | null): Stage[] {
  if (route === RouteKind.Cctp) {
    return [
      { id: "burn", name: "burn", detail: "origin SAC", state: "idle" },
      { id: "attest", name: "attest", detail: "circle iris", state: "idle" },
      { id: "mint", name: "mint", detail: "destination cctp", state: "idle" },
    ];
  }
  if (route === RouteKind.Allbridge) {
    return [
      { id: "deposit", name: "deposit", detail: "v_usd pool", state: "idle" },
      { id: "relay", name: "relay", detail: "allbridge messenger", state: "idle" },
      { id: "release", name: "release", detail: "destination pool", state: "idle" },
    ];
  }
  if (route === RouteKind.AxelarGmp) {
    return [
      { id: "call", name: "call", detail: "origin gateway", state: "idle" },
      { id: "relay", name: "relay", detail: "axelar validators", state: "idle" },
      { id: "execute", name: "execute", detail: "destination contract", state: "idle" },
    ];
  }
  // Default Axelar ITS
  return [
    { id: "dispatch", name: "dispatch", detail: "origin token manager", state: "idle" },
    { id: "relay", name: "relay", detail: "axelar network", state: "idle" },
    { id: "receive", name: "receive", detail: "destination execute", state: "idle" },
  ];
}

interface TransferFlowProps {
  readonly planner: RoutePlannerHook;
}

export function TransferFlow({ planner }: TransferFlowProps): ReactElement {
  const { isConnected, connect, address } = useStellarWallet();
  const { breakdown, selectedRoute, input } = planner;

  const [activeTransfer, setActiveTransfer] = useState<boolean>(false);
  const [stages, setStages] = useState<Stage[]>(() => getStagesForRoute(selectedRoute));
  const [originTxHash, setOriginTxHash] = useState<string | null>(null);

  const handleInitiate = async () => {
    setActiveTransfer(true);
    const initial = getStagesForRoute(selectedRoute);
    // Move first stage to active
    const running = initial.map((s, idx) => ({
      ...s,
      state: idx === 0 ? ("active" as const) : ("idle" as const),
    }));
    setStages(running);

    const res = await submitBridgeOut(address ?? "", {
      token: STELLAR_USDC_SAC_ID,
      amount: BigInt(Math.floor((Number(input.amount) || 0) * 10_000_000)),
      route: selectedRoute ?? RouteKind.AxelarIts,
      destinationChain: input.destinationChain,
      destinationAddress: input.destinationAddress,
      destinationDecimals: 6,
      minDestinationAmount: 0n,
    });

    if (res.status !== "failed" && res.txHash) {
      setOriginTxHash(res.txHash);
    }
  };

  if (!breakdown) {
    return (
      <section className={styles.panel} aria-label="Transfer readiness">
        <div className={styles.header}>
          <h2 className={styles.title}>Transfer execution</h2>
        </div>
        <p className={styles.statusMessage}>
          Enter a valid transfer amount to inspect execution steps and live fee quotes.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-label="Transfer execution">
      <div className={styles.header}>
        <h2 className={styles.title}>Transfer execution</h2>
        <span className={styles.railPill}>{breakdown.selectedRouteLabel ?? "unrouted"}</span>
      </div>

      <div className={styles.summaryTable}>
        <div className={styles.row}>
          <span className={styles.label}>origin amount</span>
          <span className={styles.value}>{breakdown.grossAmount}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>protocol fee</span>
          <span className={styles.value}>
            {breakdown.feeAmount} ({breakdown.feePercent})
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>net delivery</span>
          <span className={styles.value}>{breakdown.destinationAmount}</span>
        </div>
      </div>

      {activeTransfer ? (
        <>
          <StageLamps stages={stages} />
          {originTxHash && (
            <p className={styles.statusMessage}>
              origin transaction dispatched:{" "}
              <Link href={`/transfers/${originTxHash}`} className="mono">
                {originTxHash.slice(0, 10)}...{originTxHash.slice(-8)}
              </Link>
              <a
                href={getExplorerUrl("stellar-testnet", "tx", originTxHash)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`View transaction ${originTxHash} on block explorer`}
                className={styles.explorerLink}
              >
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            </p>
          )}
        </>
      ) : (
        <>
          {!isConnected ? (
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => {
                void connect();
              }}
            >
              connect stellar wallet to bridge
            </button>
          ) : (
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => {
                void handleInitiate();
              }}
            >
              initiate {input.amount} USDC transfer
            </button>
          )}
        </>
      )}
    </section>
  );
}
