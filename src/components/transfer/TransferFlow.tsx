"use client";

import Link from "next/link";
import { useState, type ReactElement } from "react";
import { RouteKind } from "@hyperion/protocol";
import { submitBridgeOut, STELLAR_USDC_SAC_ID } from "../../contracts";
import { useStellarWallet } from "../../wallets/stellar";
import type { RoutePlannerHook } from "../../planner";
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
  const [showConfirmDialog, setShowConfirmDialog] = useState<boolean>(false);
  const [highSlippageAcknowledged, setHighSlippageAcknowledged] = useState<boolean>(false);

  const isHighSlippage = input.slippageBps > 500;

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
      minDestinationAmount: breakdown?.minDestinationAmount ?? 0n,
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
        <div className={styles.row}>
          <span className={styles.label}>slippage tolerance</span>
          <span className={styles.value}>
            {(input.slippageBps / 100).toFixed(2)}% ({input.slippageBps} bps)
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>minimum received</span>
          <span className={`${styles.value} ${styles.minReceivedHighlight}`}>
            {breakdown.minAmountOut}
          </span>
        </div>
      </div>

      {isHighSlippage && !activeTransfer && (
        <div className={styles.warningCallout} role="alert">
          <p className={styles.warningText}>
            Warning: Slippage tolerance exceeds 500 bps (5.00%). High slippage may result in
            significant loss.
          </p>
          <label className={styles.warningLabel}>
            <input
              type="checkbox"
              checked={highSlippageAcknowledged}
              onChange={(e) => {
                setHighSlippageAcknowledged(e.target.checked);
              }}
            />
            <span>I acknowledge and accept the high slippage risk</span>
          </label>
        </div>
      )}

      {showConfirmDialog && !activeTransfer && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-heading"
          className={styles.confirmDialog}
        >
          <div className={styles.confirmHeader}>
            <h3 id="confirm-dialog-heading" className={styles.confirmTitle}>
              Confirm transfer
            </h3>
          </div>
          <p className={styles.confirmDesc}>
            Review transaction details and minimum received threshold before submitting.
          </p>
          <div className={styles.summaryTable}>
            <div className={styles.row}>
              <span className={styles.label}>origin amount</span>
              <span className={styles.value}>{breakdown.grossAmount}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>selected rail</span>
              <span className={styles.value}>{breakdown.selectedRouteLabel}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>protocol fee</span>
              <span className={styles.value}>{breakdown.feeAmount}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>net delivery</span>
              <span className={styles.value}>{breakdown.destinationAmount}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>slippage tolerance</span>
              <span className={styles.value}>
                {(input.slippageBps / 100).toFixed(2)}% ({input.slippageBps} bps)
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>minimum received</span>
              <span className={`${styles.value} ${styles.minReceivedHighlight}`}>
                {breakdown.minAmountOut}
              </span>
            </div>
          </div>

          <div className={styles.confirmActions}>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => {
                setShowConfirmDialog(false);
                void handleInitiate();
              }}
            >
              confirm and dispatch transaction
            </button>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={() => {
                setShowConfirmDialog(false);
              }}
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {activeTransfer ? (
        <>
          <StageLamps stages={stages} />
          {originTxHash && (
            <p className={styles.statusMessage}>
              origin transaction dispatched:{" "}
              <Link href={`/transfers/${originTxHash}`} className="mono">
                {originTxHash.slice(0, 10)}...{originTxHash.slice(-8)}
              </Link>
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
            !showConfirmDialog && (
              <button
                type="button"
                className={styles.actionBtn}
                disabled={isHighSlippage && !highSlippageAcknowledged}
                onClick={() => {
                  setShowConfirmDialog(true);
                }}
              >
                {isHighSlippage && !highSlippageAcknowledged
                  ? "acknowledge high slippage to proceed"
                  : `initiate ${input.amount} USDC transfer`}
              </button>
            )
          )}
        </>
      )}
    </section>
  );
}
