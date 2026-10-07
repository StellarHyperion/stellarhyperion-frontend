"use client";

import Link from "next/link";
import { use, useEffect, useState, type ReactElement } from "react";
import { Column, Footer, Header, Main, Shell } from "../../../components/chrome";
import { StageLamps, type Stage } from "../../../components/transfer/StageLamps";
import {
  fetchTransferByTx,
  getRouteName,
  type FormattedTransfer,
  type TransferLifecycleStage,
} from "../../../api";
import styles from "./page.module.css";

interface PageProps {
  readonly params: Promise<{ readonly txHash: string }>;
}

function getStageClass(stage: TransferLifecycleStage): string {
  switch (stage) {
    case "delivered":
    case "settled":
      return styles.stageDelivered ?? "";
    case "initiated":
    case "attesting":
    case "attested":
    case "delivering":
      return styles.stageInFlight ?? "";
    case "parked":
      return styles.stageParked ?? "";
    case "failed":
      return styles.stageFailed ?? "";
  }
}

function buildStages(t: FormattedTransfer): Stage[] {
  let stageNames: [string, string, string];
  let stageDetails: [string, string, string];

  if (t.route === 0) {
    stageNames = ["burn", "attest", "mint"];
    stageDetails = ["origin SAC", "circle iris", "destination cctp"];
  } else if (t.route === 2) {
    stageNames = ["call", "relay", "execute"];
    stageDetails = ["origin gateway", "axelar validators", "destination execute"];
  } else if (t.route === 3) {
    stageNames = ["deposit", "relay", "release"];
    stageDetails = ["v_usd pool", "allbridge messenger", "destination pool"];
  } else {
    stageNames = ["dispatch", "relay", "receive"];
    stageDetails = ["origin token manager", "axelar network", "destination execute"];
  }

  const [s0, s1, s2] = stageNames;
  const [d0, d1, d2] = stageDetails;

  if (t.stage === "delivered" || t.stage === "settled") {
    return [
      { id: s0, name: s0, detail: d0, state: "completed" },
      { id: s1, name: s1, detail: d1, state: "completed" },
      { id: s2, name: s2, detail: d2, state: "completed" },
    ];
  }
  if (t.stage === "delivering" || t.stage === "parked") {
    return [
      { id: s0, name: s0, detail: d0, state: "completed" },
      { id: s1, name: s1, detail: d1, state: "completed" },
      { id: s2, name: s2, detail: d2, state: "active" },
    ];
  }
  if (t.stage === "attested") {
    return [
      { id: s0, name: s0, detail: d0, state: "completed" },
      { id: s1, name: s1, detail: d1, state: "completed" },
      { id: s2, name: s2, detail: d2, state: "idle" },
    ];
  }
  if (t.stage === "attesting") {
    return [
      { id: s0, name: s0, detail: d0, state: "completed" },
      { id: s1, name: s1, detail: d1, state: "active" },
      { id: s2, name: s2, detail: d2, state: "idle" },
    ];
  }
  if (t.stage === "failed") {
    return [
      { id: s0, name: s0, detail: d0, state: "completed" },
      { id: s1, name: s1, detail: d1, state: "failed" },
      { id: s2, name: s2, detail: d2, state: "idle" },
    ];
  }
  // initiated
  return [
    { id: s0, name: s0, detail: d0, state: "active" },
    { id: s1, name: s1, detail: d1, state: "idle" },
    { id: s2, name: s2, detail: d2, state: "idle" },
  ];
}

export default function TransferDetailPage({ params }: PageProps): ReactElement {
  const { txHash } = use(params);
  const [transfer, setTransfer] = useState<FormattedTransfer | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let active = true;
    void fetchTransferByTx(txHash).then((res) => {
      if (active) {
        setTransfer(res);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [txHash]);

  return (
    <Shell>
      <Header network="stellar testnet" />
      <Main>
        <Column>
          <nav className={styles.topNav} aria-label="Breadcrumb">
            <Link href="/transfers" className={styles.backLink}>
              Back to Transfer registry
            </Link>
          </nav>

          {loading ? (
            <div className={styles.errorState}>Loading transfer details...</div>
          ) : !transfer ? (
            <div className={styles.errorState}>
              <h2 className="heading">Transfer not found</h2>
              <p className="prose">
                No transfer record was found matching transaction hash {txHash}.
              </p>
              <Link href="/transfers" className={styles.backLink}>
                Return to transfer list
              </Link>
            </div>
          ) : (
            <>
              <div className={styles.headerBlock}>
                <div className={styles.titleRow}>
                  <h1 className="title">Transfer inspector</h1>
                  <span className={`${styles.stageBadge} ${getStageClass(transfer.stage)}`}>
                    {transfer.stage}
                  </span>
                </div>
                <div className={styles.txHashDisplay}>tx: {transfer.origin.txHash}</div>
              </div>

              <section className={styles.lifecycleSection} aria-label="Progress lamps">
                <StageLamps stages={buildStages(transfer)} />
              </section>

              {transfer.claim && (
                <aside className={styles.claimBanner} aria-label="Parked claim notice">
                  <div className={styles.claimBannerTitle}>
                    {transfer.claim.settled ? "Claim settled" : "Parked claim pending recovery"}
                  </div>
                  <div className={styles.claimBannerText}>
                    This delivery holds claim ID {transfer.claim.id}.{" "}
                    {transfer.claim.settled
                      ? "Funds were settled directly to the recipient."
                      : "The destination address is uninitialized or guarded. Anyone can settle this claim permissionlessly."}
                  </div>
                </aside>
              )}

              <div className={styles.panelsGrid}>
                {/* 1. Origin Leg */}
                <section className={styles.legPanel} aria-label="Origin leg details">
                  <div className={styles.panelTitle}>
                    <span>Origin leg</span>
                    <span className={styles.panelBadge}>source</span>
                  </div>

                  <div className={styles.factList}>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>chain</span>
                      <span className={styles.factValue}>{transfer.origin.chain}</span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>sender</span>
                      <span className={styles.factValue}>{transfer.origin.sender}</span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>nonce</span>
                      <span className={styles.factValue}>{transfer.origin.nonce}</span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>block ledger</span>
                      <span className={styles.factValue}>{transfer.origin.block}</span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>gross amount</span>
                      <span className={styles.factValue}>
                        {transfer.origin.grossAmount} {transfer.origin.token}
                      </span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>protocol fee</span>
                      <span className={styles.factValue}>
                        {transfer.origin.fee} {transfer.origin.token}
                      </span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>net departure</span>
                      <span className={styles.factValue}>
                        {transfer.origin.netAmount} {transfer.origin.token}
                      </span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>observed at</span>
                      <span className={styles.factValue}>
                        {new Date(transfer.origin.observedAt).toUTCString()}
                      </span>
                    </div>
                  </div>
                </section>

                {/* 2. Rail Attestation */}
                <section className={styles.legPanel} aria-label="Rail attestation details">
                  <div className={styles.panelTitle}>
                    <span>Rail bridge</span>
                    <span className={styles.panelBadge}>{getRouteName(transfer.route)}</span>
                  </div>

                  <div className={styles.factList}>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>route index</span>
                      <span className={styles.factValue}>{transfer.route}</span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>attestation status</span>
                      <span className={styles.factValue}>
                        {transfer.rail?.status ?? "pending observation"}
                      </span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>rail status</span>
                      <span className={styles.factValue}>
                        {transfer.rail?.railStatus ?? "in transit"}
                      </span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>reference</span>
                      <span className={styles.factValue}>
                        {transfer.rail?.reference ?? "not assigned"}
                      </span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>attested at</span>
                      <span className={styles.factValue}>
                        {transfer.rail?.attestedAt
                          ? new Date(transfer.rail.attestedAt).toUTCString()
                          : "awaiting signature"}
                      </span>
                    </div>
                    {transfer.rail?.lastError && (
                      <div className={styles.factItem}>
                        <span className={styles.factLabel}>last error</span>
                        <span className={styles.factValue}>{transfer.rail.lastError}</span>
                      </div>
                    )}
                  </div>
                </section>

                {/* 3. Destination Leg */}
                <section className={styles.legPanel} aria-label="Destination leg details">
                  <div className={styles.panelTitle}>
                    <span>Destination leg</span>
                    <span className={styles.panelBadge}>arrival</span>
                  </div>

                  <div className={styles.factList}>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>chain</span>
                      <span className={styles.factValue}>{transfer.destination.chain}</span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>recipient</span>
                      <span className={styles.factValue}>{transfer.destination.recipient}</span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>delivery status</span>
                      <span className={styles.factValue}>
                        {transfer.destination.delivered ? "delivered" : "pending delivery"}
                      </span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>block</span>
                      <span className={styles.factValue}>
                        {transfer.destination.block ?? "unmined"}
                      </span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>destination tx</span>
                      <span className={styles.factValue}>
                        {transfer.destination.txHash ?? "not yet submitted"}
                      </span>
                    </div>
                    <div className={styles.factItem}>
                      <span className={styles.factLabel}>delivered at</span>
                      <span className={styles.factValue}>
                        {transfer.destination.deliveredAt
                          ? new Date(transfer.destination.deliveredAt).toUTCString()
                          : "in flight"}
                      </span>
                    </div>
                  </div>
                </section>
              </div>
            </>
          )}
        </Column>
      </Main>
      <Footer />
    </Shell>
  );
}
