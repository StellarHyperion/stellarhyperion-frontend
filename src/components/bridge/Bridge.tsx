"use client";
import { CheckpointRecoveryInspector } from "./CheckpointRecoveryInspector";
import { rememberLocalTransfer } from "../../lib/local-transfers";
import { cctpPayoutBreakdown, FeeUnavailableError } from "../../lib/relay-budget";

import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  Copy,
  ArrowUpRight,
  ChevronDown,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits } from "@hyperion/protocol";
import { fetchClaims } from "../../api";
import { useVisibilityPoll } from "../../lib/visibility-poll";
import {
  TESTNET,
  destinationFor,
  destinationDecimals,
  deploymentIdentityMismatch,
  STELLAR_DEPLOYMENT,
  type BridgeRoute,
  type DestinationKey,
} from "../../config/testnet";
import {
  errorMessage,
  batchClaimSettlementSupport,
  createReviewedIntentSnapshot,
  getClaims,
  quoteTransfer,
  TRANSACTION_TIMEOUT_SECONDS,
  quoteFreshness,
  readLane,
  resolveCheckpointTransaction,
  resolveClaimSettlementCheckpoint,
  type CheckpointRecoveryResult,
  simulateBridgeOut,
  submitBridgeOut,
  submitSettleClaim,
  submitSettleClaims,
  TransferLimitError,
  validateRecipient,
  QuoteChangedError,
  quoteBreakdown,
  type FlowLimitDiagnostic,
  type LaneState,
  type LiveQuote,
  type PendingClaim,
  type QuoteDiff,
  type ReviewedIntentSnapshot,
  type SimulatedOperation,
  type SubmissionReconciliation,
  type TransactionPhase,
  type TransactionResult,
  reviewedIntentMatches,
} from "../../contracts";
import {
  USDC,
  XLM,
  accountAssets,
  accountTrustlineReserve,
  issuerVerificationLabel,
  isCanonicalUsdc,
  conversionExecutionIntent,
  conversionRoute,
  quoteTrade,
  spendableBalance,
  requireRecoveredUsdc,
  submitConversion,
  stellarAsset,
  trustlineLabel,
  xlmShortfall,
  trustlineReserveImpact,
  type Conversion,
  type ConversionPathComparison,
  type SourceAsset,
  type TradeQuote,
  type TrustlineReservePreview,
} from "../../contracts/assets";
import { planMaxUsdcAmount, planMaxSourceAmount } from "../../lib/max-planner";
import { validateAmount } from "../../lib/amount-validation";
import {
  checkpointNetworkMatches,
  exportCheckpoint,
  checkpointForAsset,
  acquireOperationOwnership,
  getOperationOwnership,
  commitCheckpoint,
  useCheckpointStorageError,
  getClaimSettlementCheckpoint,
  saveClaimSettlementCheckpoint,
  useClaimSettlementCheckpoint,
  acquireClaimSettlementLease,
  claimSettlementIdentities,
  type ClaimSettlementCheckpoint,
  assertCheckpointStorage,
  useTransferCheckpoint,
  getTransferCheckpoint,
  checkpointIdentity,
  type TransferCheckpoint,
} from "../../contracts/checkpoint";
import { useStellarWallet } from "../../wallets";
import type { WalletApprovalProvenance } from "../../wallets/stellar";
import {
  AssetIcon,
  CopyableAddress,
  DestinationPicker,
  ReviewDialog,
  SourceAssetPicker,
} from "./AssetPicker";
import styles from "./Bridge.module.css";
import {
  amountLabel,
  phaseMessage,
  recoveryMessage,
  settlementPhaseMessage,
} from "../../lib/messages";
import { runtimeSigningAvailable } from "../../lib/runtime-capabilities";
import {
  useMessages,
  useRuntimeCapabilities,
  useTranslations,
} from "../../lib/runtime-capabilities-context";

const provider = (route: number) => (route === 0 ? "Circle CCTP" : "Axelar ITS");
const receiveSymbol = (route: number) => (route === 0 ? "USDC" : "USDC (ITS)");

function makeReviewedIntent(
  account: string,
  asset: Pick<SourceAsset, "id" | "code" | "issuer">,
  recipient: string,
  bridge: LiveQuote,
  sourceAmount: bigint,
  sourceMaximum: bigint | null,
  stage: "conversion" | "bridge",
  destination: DestinationKey = bridge.destination,
  route: BridgeRoute = bridge.route,
): ReviewedIntentSnapshot {
  return createReviewedIntentSnapshot({
    account,
    asset: { id: asset.id, code: asset.code, issuer: asset.issuer },
    destination,
    route,
    recipient: validateRecipient(recipient),
    amount: bridge.requestedAmount,
    sourceDebit: bridge.grossAmount,
    protocolFee: bridge.fee,
    netAmount: bridge.netAmount,
    representableAmount: bridge.representableAmount,
    adapter: bridge.adapter,
    minimum: bridge.destinationAmount,
    providerBudget: bridge.relayGas,
    estimatedProviderBudget: bridge.estimatedRelayGas ?? bridge.relayGas,
    sourceAmount,
    sourceMaximum,
    stage,
  });
}

export interface BridgeFormParams {
  amount: string;
  recipient: string;
  destination: DestinationKey;
  route: BridgeRoute;
  source: SourceAsset;
}

// Bounded public form state: only these keys are part of a shareable bridge link.
// Checkpoints, signatures and submission intent are deliberately excluded.
export function parseBridgeFormParams(search: string): BridgeFormParams | null {
  if (search.length > 2048) return null;
  const params = new URLSearchParams(search);
  if (["a", "r", "d", "t", "s"].some((key) => params.getAll(key).length > 1)) return null;
  const amount = params.get("a") ?? "";
  const recipient = params.get("r") ?? "";
  const destinationRaw = params.get("d");
  const routeRaw = params.get("t");
  const sourceRaw = params.get("s");

  let destination: DestinationKey = "sepolia";
  if (destinationRaw) {
    try {
      destination = destinationFor(destinationRaw).key;
    } catch {
      return null;
    }
  }

  let route: BridgeRoute = 1;
  if (routeRaw) {
    if (routeRaw === "0") route = 0;
    else if (routeRaw === "1") route = 1;
    else return null;
  }

  if (amount.length > 64 || recipient.length > 42 || (sourceRaw?.length ?? 0) > 128) return null;
  if (amount) {
    try {
      if (!/^\d+(?:\.\d{1,7})?$/.test(amount)) return null;
      const value = parseUnits(amount, 7);
      if (value <= 0n || value > (1n << 63n) - 1n) return null;
    } catch {
      return null;
    }
  }
  if (recipient) {
    try {
      validateRecipient(recipient);
    } catch {
      return null;
    }
  }
  if (!destinationFor(destination).routes.includes(route)) return null;
  let source: SourceAsset = USDC;
  if (sourceRaw) {
    if (sourceRaw === XLM.id) {
      source = XLM;
    } else if (sourceRaw === USDC.id) {
      source = USDC;
    } else {
      const parts = sourceRaw.split(":");
      if (parts.length !== 2) return null;
      const [code, issuer] = parts;
      if (!code || !issuer) return null;
      const candidate: SourceAsset = {
        id: sourceRaw,
        code,
        issuer,
        verification: "horizon-search",
        trustline: "not-checked",
      };
      try {
        stellarAsset(candidate);
      } catch {
        return null;
      }
      source = candidate;
    }
  }

  return { amount, recipient, destination, route, source };
}

function ApprovalDetails({
  approval,
  issuer,
}: {
  approval: WalletApprovalProvenance;
  issuer?: string;
}) {
  return (
    <div className={styles.assetNote}>
      <strong>Wallet approval</strong>
      <div>Account: {approval.account}</div>
      <div>Network: {approval.network}</div>
      <div>
        Operation:{" "}
        {approval.operation === "claim-settlement" ? "Claim settlement" : approval.operation}
      </div>
      {issuer && <div>Source issuer: {issuer}</div>}
    </div>
  );
}

function QuoteDetails({
  quote,
  simulation,
  simulating,
  simulationError,
}: {
  quote: LiveQuote;
  simulation?: SimulatedOperation | null;
  simulating?: boolean;
  simulationError?: string | null;
}) {
  const message = useMessages();
  const translations = useTranslations();
  const resourceFee = simulation?.resourceFee;
  const networkFee = simulation?.networkFee;
  const breakdown = quoteBreakdown(quote);

  const [now, setNow] = useState(Date.now);
  useVisibilityPoll(
    () => {
      setNow(Date.now());
    },
    1000,
    60_000,
  );
  const freshness = quoteFreshness(quote, now);
  return (
    <dl className={styles.summary}>
      <div>
        <dt>{message("requestedSourceLabel")}</dt>
        <dd>{amountLabel(breakdown.requestedSourceAmount, 7, "USDC", translations)}</dd>
      </div>
      {quote.observedAt && quote.validUntil && (
        <div>
          <dt>Estimate validity</dt>
          <dd>
            {quote.provider ?? (quote.route === 0 ? "Circle CCTP" : "Axelar ITS")} observed at{" "}
            {new Date(quote.observedAt).toLocaleTimeString()}; expires at{" "}
            {new Date(quote.validUntil).toLocaleTimeString()}. Fees in{" "}
            {quote.route === 0 ? "USDC" : "XLM"}. A five-second clock allowance shortens this review
            window.
          </dd>
        </div>
      )}
      <div>
        <dt>{message("sourceDebitLabel")}</dt>
        <dd>{amountLabel(breakdown.actualSourceDebit, 7, "USDC", translations)}</dd>
      </div>
      <div>
        <dt>{message("protocolFeeLabel")}</dt>
        <dd>{amountLabel(breakdown.protocolFee, 7, "USDC", translations)}</dd>
      </div>
      <div>
        <dt>{message("bridgeAmountLabel")}</dt>
        <dd>{amountLabel(breakdown.representableBridgeAmount, 7, "USDC", translations)}</dd>
      </div>
      <div>
        <dt>{message("dustLabel")}</dt>
        <dd>{amountLabel(breakdown.retainedDust, 7, "USDC", translations)}</dd>
      </div>
      <div>
        <dt>{message(quote.route === 0 ? "circleEstimateLabel" : "axelarEstimateLabel")}</dt>
        <dd>
          {amountLabel(
            quote.estimatedRelayGas ?? quote.relayGas,
            7,
            quote.route === 0 ? "USDC" : "XLM",
            translations,
          )}
        </dd>
      </div>
      <div>
        <dt>{message(quote.route === 0 ? "circleBudgetLabel" : "axelarBudgetLabel")}</dt>
        <dd>{amountLabel(quote.relayGas, 7, quote.route === 0 ? "USDC" : "XLM", translations)}</dd>
      </div>
      <div>
        <dt>{message("headroomLabel")}</dt>
        <dd>
          {amountLabel(
            quote.relayGas - (quote.estimatedRelayGas ?? quote.relayGas),
            7,
            quote.route === 0 ? "USDC" : "XLM",
            translations,
          )}
        </dd>
      </div>
      {quote.route === 0 && (
        <>
          <div>
            <dt>{message("forwardingLabel")}</dt>
            <dd>
              {amountLabel(
                cctpPayoutBreakdown(quote.representableAmount, quote.relayGas).destinationBudget,
                6,
                "USDC",
                translations,
              )}
            </dd>
          </div>
          <div>
            <dt>{message("destinationMinimumLabel")}</dt>
            <dd>{amountLabel(quote.destinationAmount, 6, "USDC", translations)}</dd>
          </div>
        </>
      )}
      {resourceFee !== undefined && (
        <div>
          <dt>{message("resourceFeeLabel")}</dt>
          <dd>{amountLabel(resourceFee, 7, "XLM", translations)}</dd>
        </div>
      )}
      {networkFee !== undefined && (
        <div>
          <dt>{message("networkFeeLabel")}</dt>
          <dd>{amountLabel(networkFee, 7, "XLM", translations)}</dd>
        </div>
      )}
      {simulating && (
        <div>
          <dt>{message("resourceFeeLabel")}</dt>
          <dd>Estimating simulation...</dd>
        </div>
      )}
      {simulationError && (
        <div>
          <dt>Simulation status</dt>
          <dd>Simulation failed</dd>
        </div>
      )}
      <div>
        <dt>{message("receivedMinimumLabel")}</dt>
        <dd>
          {amountLabel(
            quote.destinationAmount,
            destinationDecimals(quote.route),
            receiveSymbol(quote.route),
            translations,
          )}
        </dd>
      </div>
      <div>
        <dt>Refund disclosure</dt>
        <dd>{quote.route === 0 ? "Provider-dependent" : "Provider-dependent; not guaranteed"}</dd>
      </div>
      <div>
        <dt>Provider observation</dt>
        <dd>
          {freshness === "current" ? "Current" : freshness === "stale" ? "Stale" : "Unknown"} ·{" "}
          {quote.observedAt ? new Date(quote.observedAt).toLocaleString() : "Not observed"}
        </dd>
      </div>
      <div>
        <dt>Contract observation</dt>
        <dd>
          {quote.observations?.contractAt
            ? new Date(quote.observations.contractAt).toLocaleString()
            : "Not observed"}{" "}
          · ledger {quote.ledger}
        </dd>
      </div>
      <div>
        <dt>Quote scope</dt>
        <dd>
          {quote.destination} · {quote.route === 0 ? "Circle CCTP" : "Axelar ITS"} · {quote.adapter}{" "}
          · ledger {quote.ledger}
          <span> · Stellar Testnet</span>
        </dd>
      </div>
    </dl>
  );
}

function QuoteDiffDetails({ diff }: { diff: QuoteDiff }) {
  return (
    <>
      <h3>
        {diff.materialWorsening
          ? "Refreshed quote changed: review required"
          : "Refreshed quote changed"}
      </h3>
      <p className={styles.reviewNote}>
        Compare fees, the receive minimum and provider budgets with the quote you reviewed.
      </p>
      <dl className={styles.summary} aria-label="Quote field differences">
        {diff.fields.map((field) => (
          <div
            key={field.key}
            className={
              field.direction === "worse"
                ? styles.diffWorse
                : field.direction === "better"
                  ? styles.diffBetter
                  : undefined
            }
          >
            <dt>{field.label}</dt>
            <dd>
              {field.reviewedDisplay} <ArrowRight size={11} aria-hidden="true" />{" "}
              {field.refreshedDisplay}
              <span className={styles.diffKind}>
                {field.direction === "worse"
                  ? "Worse"
                  : field.direction === "better"
                    ? "Better"
                    : "Changed"}
              </span>
              {field.delta !== null && (
                <span className={styles.diffDelta}>
                  {field.delta > 0n ? "+" : ""}
                  {field.delta.toString()}{" "}
                  {field.delta === 1n || field.delta === -1n ? "base unit" : "base units"}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className={styles.reviewNote}>
        Your reviewed minimum and provider budget stay fixed in the signed transaction.
      </p>
    </>
  );
}

function ConversionIntent({
  conversion,
  addTrustline,
}: {
  conversion: Conversion;
  addTrustline: boolean;
}) {
  const intent = conversionExecutionIntent(conversion, addTrustline);
  return (
    <section className={styles.conversionIntent} aria-label="Conversion execution intent">
      <h3>Conversion execution intent</h3>
      <p>
        {intent.operation}: receive exactly {formatUnits(intent.destinationAmount, 7)} USDC while
        spending no more than {formatUnits(intent.sourceMax, 7)} {intent.source.code}.
      </p>
      <ol className={styles.conversionPath} aria-label="Conversion route">
        {conversionRoute(conversion).map((asset, index, route) => (
          <li key={`${asset.id}-${index}`} className={styles.conversionStep}>
            <strong>{asset.code}</strong>
            {asset.issuer && <span className={styles.address}>{asset.issuer}</span>}
            {index < route.length - 1 && <ArrowRight size={13} aria-hidden="true" />}
          </li>
        ))}
      </ol>
      <PathComparisonEvidence
        comparison={conversion.pathComparison}
        sourceMax={intent.sourceMax}
        sourceCode={intent.source.code}
      />
      <p>
        {intent.addTrustline
          ? "This transaction also creates the canonical USDC trustline."
          : "The canonical USDC trustline already exists."}
      </p>
    </section>
  );
}

function PathComparisonEvidence({
  comparison,
  sourceMax,
  sourceCode,
}: {
  comparison: ConversionPathComparison;
  sourceMax: bigint;
  sourceCode: string;
}) {
  return (
    <details className={styles.pathComparison}>
      <summary>
        Compared {comparison.eligiblePaths} valid of {comparison.returnedPaths} Horizon paths;{" "}
        {comparison.excludedPaths} excluded
      </summary>
      <p>
        Selected exact output: {formatUnits(comparison.selectedOutput, 7)} USDC. Candidates had to
        match the requested source amount, source identity, and canonical USDC destination; the
        reviewed transaction still spends no more than {formatUnits(sourceMax, 7)} {sourceCode}.
        Equal outputs are resolved by issuer-qualified path identity.
      </p>
      {comparison.diagnostics.length > 0 ? (
        <ul>
          {comparison.diagnostics.map(({ responseIndex, reason }) => (
            <li key={`${responseIndex}-${reason}`}>
              {responseIndex === null ? reason : `Path ${responseIndex + 1} excluded: ${reason}`}
            </li>
          ))}
          {comparison.omittedDiagnostics > 0 && (
            <li>{comparison.omittedDiagnostics} additional exclusions omitted.</li>
          )}
        </ul>
      ) : (
        <p>No returned paths were excluded.</p>
      )}
    </details>
  );
}

function ConversionDetails({ conversion }: { conversion: NonNullable<TradeQuote["conversion"]> }) {
  const path = [conversion.source, ...conversion.path, USDC]
    .map((asset) =>
      asset.issuer
        ? `${asset.code} (${asset.issuer.slice(0, 7)}...${asset.issuer.slice(-7)})`
        : asset.code,
    )
    .join(" -> ");
  return (
    <>
      <p className={styles.assetNote}>
        Convert up to {formatUnits(conversion.sourceMax, 7)} {conversion.source.code} into at least{" "}
        {formatUnits(conversion.usdcAmount, 7)} Stellar USDC. Quoted path: {path}. Liquidity is
        rechecked immediately before wallet approval; signing is blocked if this minimum cannot be
        met.
      </p>
      <PathComparisonEvidence
        comparison={conversion.pathComparison}
        sourceMax={conversion.sourceMax}
        sourceCode={conversion.source.code}
      />
    </>
  );
}

function PendingTransferCard({
  checkpoint,
  busy,
  onReset,
}: {
  checkpoint: TransferCheckpoint;
  busy: boolean;
  onReset: () => Promise<void>;
}) {
  const wallet = useStellarWallet();
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<
    (CheckpointRecoveryResult & { txHash: string; owner: string }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<LiveQuote | null>(null);
  const currentAccount = useRef(wallet.address);
  useLayoutEffect(() => {
    currentAccount.current = wallet.address;
  }, [wallet.address]);
  const [cardSimulation, setCardSimulation] = useState<SimulatedOperation | null>(null);
  const [cardSimulating, setCardSimulating] = useState(false);
  const [cardSimError, setCardSimError] = useState<string | null>(null);
  const [reviewedIntent, setReviewedIntent] = useState<ReviewedIntentSnapshot | null>(null);
  const [cardDiff, setCardDiff] = useState<QuoteDiff | null>(null);
  const message = useMessages();
  const translations = useTranslations();
  const runtime = useRuntimeCapabilities();
  const sameAccount = wallet.address === checkpoint.account;
  const sameNetwork = checkpointNetworkMatches(checkpoint);
  const actionRef = useRef<HTMLButtonElement>(null);
  const recoveryMessageRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const focus = () => {
      const action = actionRef.current;
      if (action && !action.disabled) action.focus();
      else recoveryMessageRef.current?.focus();
    };
    let frame = requestAnimationFrame(focus);
    const requestFocus = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(focus);
    };
    const onHashChange = () => {
      if (window.location.hash === "#pending-recovery") requestFocus();
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("hyperion:recovery-focus", requestFocus);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("hyperion:recovery-focus", requestFocus);
    };
  }, [busy, checking, checkpoint.txHash]);
  const recoveryOwner = JSON.stringify([checkpoint, wallet.address]);
  const ownerRef = useRef(recoveryOwner);
  const requestRef = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    ownerRef.current = recoveryOwner;
    requestRef.current?.abort();
    requestRef.current = null;
    return () => {
      requestRef.current?.abort();
    };
  }, [recoveryOwner]);
  const visibleCurrent = checked?.owner === recoveryOwner ? checked : null;
  const check = async () => {
    if (checking || busy || requestRef.current) return;
    if (!sameNetwork) {
      setError(
        "This checkpoint belongs to a different Stellar network. Reconnect to Testnet before checking it.",
      );
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    const owner = recoveryOwner;
    const active = () => {
      const saved = getTransferCheckpoint();
      return (
        !controller.signal.aborted &&
        ownerRef.current === owner &&
        saved !== null &&
        checkpointIdentity(saved) === checkpointIdentity(checkpoint) &&
        (saved.revision ?? 0) === (checkpoint.revision ?? 0)
      );
    };
    setChecking(true);
    setError(null);
    let conversionConfirmed = false;
    try {
      const result = await resolveCheckpointTransaction(checkpoint, controller.signal);
      if (!active()) return;
      setReview(null);
      setReviewedIntent(null);
      setCardSimulation(null);
      setCardDiff(null);
      setChecked({ ...result, txHash: checkpoint.txHash, owner });
      if (checkpoint.stage === "bridge")
        await rememberLocalTransfer({
          checkpoint,
          sourceStatus:
            result.status === "confirmed" || result.status === "failed" ? result.status : "unknown",
        });
      if (result.status === "unknown") {
        setError(result.message);
        return;
      }
      if (result.status === "confirmed" && checkpoint.stage === "conversion" && sameAccount) {
        if (!runtimeSigningAvailable(runtime.capabilities, checkpoint.route))
          throw new Error(message("staticFeeUnavailable"));
        conversionConfirmed = true;
        await requireRecoveredUsdc(
          checkpoint.account,
          BigInt(checkpoint.bridgeAmount),
          controller.signal,
        );
        if (!active()) return;
        const nextQuote = await quoteTransfer(
          checkpoint.destination,
          BigInt(checkpoint.bridgeAmount),
          checkpoint.route,
        );
        if (!active()) return;
        setReview(nextQuote);
        setReviewedIntent(
          makeReviewedIntent(
            checkpoint.account,
            USDC,
            checkpoint.recipient,
            nextQuote,
            nextQuote.requestedAmount,
            null,
            "bridge",
            checkpoint.destination,
            checkpoint.route,
          ),
        );
        setCardSimulating(true);
        setCardSimError(null);
        try {
          const sim = await simulateBridgeOut(checkpoint.account, nextQuote, checkpoint.recipient);
          if (!active()) return;
          setCardSimulation(sim);
        } catch (cause) {
          if (active()) {
            setCardSimulation(null);
            setCardSimError(errorMessage(cause));
          }
        } finally {
          if (active()) setCardSimulating(false);
        }
      }
    } catch (cause) {
      if (active())
        setError(
          conversionConfirmed
            ? message("conversionPreparationFailed", { reason: errorMessage(cause) })
            : errorMessage(cause),
        );
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      // Busy UI state is safe to release even when identity invalidated this read.
      setChecking(false);
      setCardSimulating(false);
    }
  };
  const continueBridge = async () => {
    if (!runtimeSigningAvailable(runtime.capabilities, checkpoint.route)) {
      setError(message("runtimeUnknown"));
      return;
    }
    if (
      !review ||
      !reviewedIntent ||
      checked?.owner !== recoveryOwner ||
      checked.status !== "confirmed" ||
      !sameAccount ||
      !sameNetwork ||
      checking ||
      cardSimulating ||
      !!cardSimError ||
      !cardSimulation ||
      requestRef.current
    )
      return;
    try {
      assertCheckpointStorage();
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    const owner = recoveryOwner;
    const active = () => {
      const saved = getTransferCheckpoint();
      return (
        !controller.signal.aborted &&
        ownerRef.current === owner &&
        saved !== null &&
        checkpointIdentity(saved) === checkpointIdentity(checkpoint) &&
        (saved.revision ?? 0) === (checkpoint.revision ?? 0)
      );
    };
    setChecking(true);
    setError(null);
    let signingLease: Awaited<ReturnType<typeof acquireOperationOwnership>> | undefined;
    try {
      signingLease = await acquireOperationOwnership(
        {
          account: checkpoint.account,
          recipient: checkpoint.recipient,
          destination: checkpoint.destination,
          route: checkpoint.route,
          bridgeAmount: checkpoint.bridgeAmount,
          stage: "bridge",
        },
        checkpoint,
      );
      if (!active()) return;
      const freshEvidence = await resolveCheckpointTransaction(checkpoint, controller.signal);
      if (!active()) return;
      if (freshEvidence.status !== "confirmed")
        throw new Error(
          "The original conversion could not be reconfirmed. Keep its checkpoint and retry the read.",
        );
      await requireRecoveredUsdc(
        checkpoint.account,
        BigInt(checkpoint.bridgeAmount),
        controller.signal,
      );
      if (!active()) return;
      const result = await submitBridgeOut(
        checkpoint.account,
        review,
        checkpoint.recipient,
        (xdr, opts) => wallet.signTransaction(xdr, { ...opts, operation: "bridge" }),
        undefined,
        { account: checkpoint.account, network: TESTNET.networkPassphrase, operation: "bridge" },
        {
          expectedAccount: checkpoint.account,
          reviewedIntent,
          getCurrentAccount: () => currentAccount.current,
          isSuperseded: () => !active(),
          onSigned: async (hash) => {
            const saved = await commitCheckpoint(
              { ...checkpoint, stage: "bridge", txHash: hash },
              checkpoint,
            );
            if (saved) await rememberLocalTransfer({ checkpoint: saved, sourceStatus: "unknown" });
          },
        },
        cardSimulation,
        controller.signal,
        (diff) => {
          if (active()) setCardDiff(diff);
        },
      );
      if (active()) {
        setChecked(
          result.status === "pending"
            ? null
            : {
                ...result,
                status: result.status === "confirmed" ? "confirmed" : "failed",
                owner,
                source: "rpc",
                message: recoveryMessage(
                  "bridge",
                  result.status === "confirmed" ? "confirmed" : "failed",
                  false,
                  translations,
                ),
              },
        );
        setReview(null);
        setReviewedIntent(null);
        setCardSimulation(null);
        setCardDiff(null);
      }
    } catch (cause) {
      if (active() && cause instanceof QuoteChangedError) {
        setCardDiff(cause.diff);
        setError(null);
      } else if (active()) {
        const reason = errorMessage(cause);
        setError(message("conversionAttemptFailed", { reason }));
      }
    } finally {
      signingLease?.release();
      if (requestRef.current === controller) requestRef.current = null;
      setChecking(false);
    }
  };
  const resetRecovered = async () => {
    if (checking || busy || requestRef.current) return;
    setChecking(true);
    try {
      if (
        checkpoint.stage === "bridge" &&
        visibleCurrent &&
        (visibleCurrent.status === "confirmed" || visibleCurrent.status === "failed")
      )
        await rememberLocalTransfer({ checkpoint, sourceStatus: visibleCurrent.status });
      await onReset();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  };
  return (
    <section
      id="pending-recovery"
      className={styles.pending}
      aria-label="Transfer recovery"
      aria-busy={checking}
      tabIndex={-1}
    >
      <div className={styles.pendingTitle}>
        <ShieldCheck size={18} aria-hidden="true" />
        <h2>
          {recoveryMessage(checkpoint.stage, visibleCurrent?.status ?? null, true, translations)}
        </h2>
      </div>
      <p id="pending-recovery-message" ref={recoveryMessageRef} role="status" tabIndex={-1}>
        {recoveryMessage(checkpoint.stage, visibleCurrent?.status ?? null, false, translations)}
      </p>
      {checkpoint.stage === "conversion" && checkpoint.source && (
        <p className={styles.address}>
          Original source asset: {checkpoint.source.code}
          {checkpoint.source.issuer ? `, issuer ${checkpoint.source.issuer}` : " (native XLM)"}
        </p>
      )}
      <a
        className={styles.transactionLink}
        href={`https://stellar.expert/explorer/testnet/tx/${checkpoint.txHash}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {checkpoint.txHash.slice(0, 12)}...{checkpoint.txHash.slice(-8)}{" "}
        <ArrowUpRight size={14} aria-hidden="true" />
      </a>
      <div className={styles.transactionIdentity}>
        <span>Source transaction on Stellar Testnet</span>
        <div className={styles.transactionIdentityValue}>
          <code className={styles.transactionHash}>{checkpoint.txHash}</code>
          <button
            type="button"
            className={styles.copyHash}
            aria-label="Copy transaction hash"
            onClick={() => {
              void navigator.clipboard
                .writeText(checkpoint.txHash)
                .then(() => {
                  setCopied(true);
                })
                .catch(() => {
                  setCopied(false);
                });
            }}
          >
            <Copy size={14} aria-hidden="true" />
          </button>
        </div>
        {copied && <span role="status">Transaction hash copied.</span>}
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            let url: string | undefined;
            try {
              const blob = new Blob([exportCheckpoint(checkpoint)], { type: "application/json" });
              url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = `hyperion-checkpoint-${checkpoint.txHash.slice(0, 12)}.json`;
              link.click();
              setError(null);
            } catch {
              setError(message("recoveryExportFailed"));
            } finally {
              if (url) {
                const createdUrl = url;
                setTimeout(() => {
                  URL.revokeObjectURL(createdUrl);
                }, 1000);
              }
            }
          }}
        >
          {message("recoveryExport")}
        </button>
        <a
          className={styles.transactionLink}
          href={`https://stellar.expert/explorer/testnet/tx/${checkpoint.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on Stellar Expert <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
      <CheckpointRecoveryInspector key={recoveryOwner} checkpoint={checkpoint} />
      {checkpoint.stage === "bridge" && (
        <Link href={`/transfers/${checkpoint.txHash}`}>
          Track transfer <ArrowRight size={14} aria-hidden="true" />
        </Link>
      )}
      {!sameAccount && (
        <p>
          {message("recoveryReconnect", {
            account: `${checkpoint.account.slice(0, 7)}...${checkpoint.account.slice(-7)}`,
          })}
        </p>
      )}
      {!sameNetwork && (
        <p role="alert" className={styles.error}>
          {message("recoveryNetworkMismatch")}
        </p>
      )}
      <p className={styles.address}>{message("recoveryOwner", { account: checkpoint.account })}</p>
      {checking && <p role="status">{message("recoveryChecking")}</p>}
      {visibleCurrent && visibleCurrent.message !== error && (
        <p role="status">{visibleCurrent.message}</p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {visibleCurrent?.status === "failed" ||
      (checkpoint.stage === "bridge" && visibleCurrent?.status === "confirmed") ? (
        <button
          id="pending-recovery-action"
          aria-describedby="pending-recovery-message"
          aria-busy={checking}
          ref={actionRef}
          type="button"
          className={styles.secondary}
          onClick={() => {
            void resetRecovered();
          }}
          disabled={busy || checking}
        >
          {message("recoveryStartAnother")}
        </button>
      ) : (
        <button
          id="pending-recovery-action"
          aria-describedby="pending-recovery-message"
          aria-busy={checking}
          ref={actionRef}
          type="button"
          className={styles.secondary}
          onClick={() => {
            void check();
          }}
          disabled={busy || checking || !sameNetwork}
        >
          {checking
            ? message("recoveryCheckingAction")
            : checkpoint.stage === "conversion" && sameAccount && sameNetwork
              ? message("recoveryContinue")
              : message("recoveryCheck")}
        </button>
      )}
      {review && checked?.owner === recoveryOwner && (
        <ReviewDialog
          onClose={() => {
            if (!checking) {
              setReview(null);
              setReviewedIntent(null);
              setCardSimulation(null);
              setCardSimError(null);
            }
          }}
          footer={
            <>
              <button
                type="button"
                className={styles.secondary}
                disabled={checking}
                onClick={() => {
                  setReview(null);
                  setCardSimulation(null);
                  setCardSimError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={
                  !runtimeSigningAvailable(runtime.capabilities, checkpoint.route) ||
                  checking ||
                  !sameAccount ||
                  cardSimulating ||
                  !!cardSimError ||
                  !cardSimulation ||
                  !!cardDiff?.materialWorsening
                }
                onClick={() => {
                  void continueBridge();
                }}
              >
                {checking
                  ? "Confirming in your wallet..."
                  : cardSimulating
                    ? "Estimating simulation..."
                    : cardSimError
                      ? "Approval blocked"
                      : message("approveBridge")}
              </button>
            </>
          }
        >
          <p className={styles.reviewNote}>{message("recoveryExistingUSDC")}</p>
          <ApprovalDetails
            approval={{
              account: checkpoint.account,
              network: TESTNET.networkPassphrase,
              operation: "bridge",
            }}
          />
          <QuoteDetails quote={review} simulation={cardSimulation} />
          {cardDiff && (
            <section className={styles.quoteDiff} aria-label="Refreshed quote comparison">
              <QuoteDiffDetails diff={cardDiff} />
              <button
                type="button"
                className={styles.secondary}
                onClick={() => {
                  setCardDiff(null);
                  void check();
                }}
              >
                Check refreshed quote
              </button>
            </section>
          )}
          <p className={styles.address}>Recipient: {checkpoint.recipient}</p>
          {cardSimulation && (
            <p className={styles.address}>
              Operation: bridge_out_with_gas (
              {amountLabel(cardSimulation.totalFee, 7, "XLM", translations)} total envelope fee)
            </p>
          )}
          {cardSimError && (
            <p role="alert" className={styles.error}>
              Simulation failed: {cardSimError}. Approval blocked.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </ReviewDialog>
      )}
    </section>
  );
}

export function Bridge() {
  const message = useMessages();
  const translations = useTranslations();
  const runtime = useRuntimeCapabilities();
  const wallet = useStellarWallet();
  const checkpoint = useTransferCheckpoint();
  const checkpointStorageError = useCheckpointStorageError();
  const [source, setSource] = useState<SourceAsset>(USDC);
  const [destination, setDestination] = useState<DestinationKey>("sepolia");
  const [route, setRoute] = useState<BridgeRoute>(1);
  const runtimeReady = runtimeSigningAvailable(runtime.capabilities, route);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [touched, setTouched] = useState(false);
  const [picker, setPicker] = useState<"source" | "destination" | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewApproval, setReviewApproval] = useState<WalletApprovalProvenance | null>(null);
  const [quoteDiff, setQuoteDiff] = useState<QuoteDiff | null>(null);
  const [refresh, setRefresh] = useState(0);
  const refreshGate = useRef<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [quoteVersion, setQuoteVersion] = useState(0);
  const [feeCooldown, setFeeCooldown] = useState<{ key: string; until: number } | null>(null);
  const [feeClock, setFeeClock] = useState(() => Date.now());
  useEffect(() => {
    if (!feeCooldown) return;
    const update = () => {
      setFeeClock(Date.now());
    };
    update();
    const timer = window.setInterval(() => {
      update();
      if (Date.now() >= feeCooldown.until) window.clearInterval(timer);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [feeCooldown]);
  const [laneState, setLaneState] = useState<{
    key: string;
    value: LaneState | null;
    error: string | null;
  } | null>(null);
  const [quoted, setQuoted] = useState<{
    key: string;
    value: TradeQuote | null;
    error: string | null;
    diagnostic: FlowLimitDiagnostic | null;
  } | null>(null);
  const [accounts, setAccounts] = useState<{
    account: string;
    assets: SourceAsset[];
    error: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<TransactionPhase | null>(null);
  const [step, setStep] = useState<"conversion" | "bridge">("bridge");
  const [result, setResult] = useState<TransactionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulatedState, setSimulatedState] = useState<{
    key: string;
    value: SimulatedOperation | null;
    error: string | null;
  } | null>(null);
  const [reviewed, setReviewed] = useState<{
    key: string;
    quote: TradeQuote;
    intent: ReviewedIntentSnapshot;
    addTrustline: boolean;
    simulation: SimulatedOperation | null;
  } | null>(null);
  const [reserve, setReserve] = useState<TrustlineReservePreview | null>(null);
  const [reserveError, setReserveError] = useState<string | null>(null);
  const reviewAction = useRef<HTMLButtonElement>(null);
  const approvalFocusPending = useRef(false);
  useEffect(() => {
    if (busy || !approvalFocusPending.current || checkpoint) return;
    approvalFocusPending.current = false;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active.isConnected &&
        !active.matches(":disabled")
      )
        return;
      if (reviewAction.current && !reviewAction.current.disabled) reviewAction.current.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [busy, checkpoint, error]);
  const laneKey = `${destination}:${route}:${refresh}`;
  const laneRefreshing = useVisibilityPoll(
    async (signal) => {
      if (refreshGate.current !== null) refreshGate.current = laneKey;
      try {
        const value = await readLane(destination, route);
        if (!signal.aborted) setLaneState({ key: laneKey, value, error: null });
      } catch (cause) {
        if (!signal.aborted)
          setLaneState({ key: laneKey, value: null, error: errorMessage(cause) });
      } finally {
        if (!signal.aborted && refreshGate.current === laneKey) {
          refreshGate.current = null;
          setRefreshing(false);
        }
      }
    },
    30_000,
    60_000,
    laneKey,
    0,
  );
  const lane = laneState?.key === laneKey ? laneState.value : null;
  const laneError = laneState?.key === laneKey ? laneState.error : null;
  const quoteKey = `${laneKey}:${source.id}:${amount}:${recipient}:${quoteVersion}`;
  const quote =
    quoted?.key === quoteKey && lane?.available && !laneRefreshing ? quoted.value : null;
  const quoteError = quoted?.key === quoteKey ? quoted.error : null;
  const quoteDiagnostic = quoted?.key === quoteKey ? quoted.diagnostic : null;
  const retryFeeSeconds =
    feeCooldown?.key === quoteKey
      ? Math.max(0, Math.ceil((feeCooldown.until - feeClock) / 1000))
      : 0;
  const simKey = `${quoteKey}:${wallet.address}`;
  const simulation = simulatedState?.key === simKey ? simulatedState.value : null;
  const simulationError = simulatedState?.key === simKey ? simulatedState.error : null;
  const balances = accounts?.account === wallet.address ? accounts.assets : [];
  const walletAsset = balances.find((asset) => asset.id === source.id);
  const activeSource: SourceAsset = useMemo(
    () => (walletAsset ? { ...source, ...walletAsset } : source),
    [source, walletAsset],
  );
  const sourceBalance =
    accounts?.account === wallet.address && !accounts.error
      ? (walletAsset?.balance ?? "0")
      : undefined;
  const liveReview = useRef({
    account: wallet.address,
    recipient,
    amount,
    sourceId: source.id,
    sourceCode: source.code,
    sourceIssuer: source.issuer,
    destination,
    route,
  });
  useLayoutEffect(() => {
    liveReview.current = {
      account: wallet.address,
      recipient,
      amount,
      sourceId: source.id,
      sourceCode: source.code,
      sourceIssuer: source.issuer,
      destination,
      route,
    };
  }, [
    wallet.address,
    recipient,
    amount,
    source.id,
    source.code,
    source.issuer,
    destination,
    route,
  ]);
  const spendableStr =
    accounts?.account === wallet.address && !accounts.error && walletAsset
      ? spendableBalance(walletAsset)
      : sourceBalance;
  const spendableUnits = spendableStr !== undefined ? parseUnits(spendableStr, 7) : undefined;
  const xlmAsset = balances.find((asset) => asset.id === "native");
  const xlmSpendable = xlmAsset?.available !== undefined ? parseUnits(xlmAsset.available, 7) : 0n;
  // Conservative maximum: for USDC source requires a live quote with relay pricing;
  // for non-USDC source the spendable asset balance is the binding spending cap.
  const isUsdcSource = isCanonicalUsdc(source);
  const trustlineOk = activeSource.trustline === "present" || activeSource.trustline === "native";
  const conservativeMax: bigint | null = isUsdcSource
    ? quote !== null && lane !== null
      ? planMaxUsdcAmount({
          route,
          usdcSpendable: spendableUnits ?? 0n,
          xlmSpendable,
          flowAvailable: quote.bridge.flowAvailable,
          estimatedRelayGas: quote.bridge.estimatedRelayGas ?? quote.bridge.relayGas,
        })
      : null
    : source.id === "native"
      ? null
      : planMaxSourceAmount({
          spendableSourceUnits: spendableUnits ?? 0n,
          trustlineOk,
        });

  const locked = busy || checkpoint !== null || checkpointStorageError !== null;
  let inputError: string | null = null;
  let valid = false;
  const amountValidation = validateAmount(amount, translations);
  if (amount.trim() && recipient.trim()) {
    try {
      if (!amountValidation.valid) throw new Error(amountValidation.message);
      validateRecipient(recipient);
      valid = true;
    } catch (cause) {
      inputError = errorMessage(cause);
    }
  }
  const fetching =
    valid && !locked && !laneError && (!lane || (lane.available && quoted?.key !== quoteKey));
  const simulating =
    valid &&
    !!wallet.address &&
    !!quote &&
    !quote.conversion &&
    !locked &&
    simulatedState?.key !== simKey;
  const chain = destinationFor(destination);
  const deploymentMismatch = deploymentIdentityMismatch(TESTNET.router, TESTNET.token);
  const destinationRepresentation =
    route === 0
      ? chain.usdc
      : lane?.available && lane.destinationToken
        ? lane.destinationToken
        : null;
  const waitController = useRef<AbortController | null>(null);
  const waitGeneration = useRef(0);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  useEffect(() => {
    const generation = waitGeneration;
    return () => {
      ++generation.current;
      waitController.current?.abort();
    };
  }, [wallet.address]);
  useEffect(() => {
    const parsed = parseBridgeFormParams(window.location.search);
    if (!parsed) return;
    const timer = setTimeout(() => {
      setSource(parsed.source);
      setDestination(parsed.destination);
      setRoute(parsed.route);
      setAmount(parsed.amount);
      setRecipient(parsed.recipient);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  const shareConfiguration = async () => {
    const params = new URLSearchParams({
      a: amount,
      r: recipient,
      d: destination,
      t: String(route),
      s: source.id,
    });
    if (!parseBridgeFormParams(`?${params}`)) {
      setShareStatus("Enter a valid amount and recipient on a supported route before sharing.");
      return;
    }
    const url = new URL("/", window.location.origin);
    url.search = params.toString();
    try {
      await navigator.clipboard.writeText(url.toString());
      setShareStatus(
        "Transfer configuration link copied. Opening it requires fresh quotes and wallet approval.",
      );
    } catch {
      setShareStatus(
        "Clipboard access is unavailable. Try sharing again after allowing clipboard access.",
      );
    }
  };

  const invalidateQuote = () => {
    setQuoteVersion((version) => version + 1);
    setQuoted(null);
    setReviewing(false);
    setReviewApproval(null);
    setReviewed(null);
    setQuoteDiff(null);
  };

  useEffect(() => {
    if (!wallet.address) return;
    const account = wallet.address;
    const controller = new AbortController();
    void Promise.all([
      accountAssets(account, controller.signal),
      accountTrustlineReserve(account, controller.signal),
    ])
      .then(([assets, nextReserve]) => {
        if (!controller.signal.aborted) {
          setAccounts({ account, assets, error: null });
          setReserve(nextReserve);
          setReserveError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setAccounts({ account, assets: [], error: errorMessage(cause) });
          setReserve(null);
          setReserveError(errorMessage(cause));
        }
      });
    return () => {
      controller.abort();
    };
  }, [wallet.address, result, refresh]);
  useEffect(() => {
    if (!runtimeReady || !valid || !lane?.available || locked) return;
    let active = true;
    const timer = setTimeout(() => {
      void quoteTrade(destination, activeSource, amount, route)
        .then((value) => {
          if (active) {
            setFeeCooldown(null);
            setQuoted({ key: quoteKey, value, error: null, diagnostic: null });
          }
        })
        .catch((cause: unknown) => {
          if (active) {
            if (cause instanceof FeeUnavailableError)
              setFeeCooldown({ key: quoteKey, until: Date.now() + cause.retryAfterSeconds * 1000 });
            setQuoted({
              key: quoteKey,
              value: null,
              error: errorMessage(cause),
              diagnostic: cause instanceof TransferLimitError ? cause.diagnostic : null,
            });
          }
        });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [runtimeReady, valid, lane, locked, destination, activeSource, amount, route, quoteKey]);
  useEffect(() => {
    const sender = wallet.address;
    // Conversion funds the later bridge. Simulate that bridge only after conversion confirms.
    if (!valid || !quote || quote.conversion || !sender || locked) return;
    let active = true;
    const timer = setTimeout(() => {
      void simulateBridgeOut(sender, quote.bridge, recipient)
        .then((sim) => {
          if (active) setSimulatedState({ key: simKey, value: sim, error: null });
        })
        .catch((cause: unknown) => {
          if (active) setSimulatedState({ key: simKey, value: null, error: errorMessage(cause) });
        });
    }, 450);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [valid, quote, wallet.address, locked, recipient, simKey]);

  const submit = async () => {
    if (!runtimeReady) {
      setError(message("runtimeUnknown"));
      return;
    }
    if (
      !reviewed ||
      !wallet.address ||
      busy ||
      checkpoint ||
      reviewedReserveInsufficient ||
      (!!reviewed.quote.conversion && !reserve)
    )
      return;
    if (reviewApproval?.account !== wallet.address) {
      setReviewing(false);
      setReviewApproval(null);
      setReviewed(null);
      setError(message("walletChanged"));
      return;
    }
    let intentMatches = false;
    try {
      intentMatches = reviewedIntentMatches(
        reviewed.intent,
        makeReviewedIntent(
          wallet.address,
          source,
          recipient,
          reviewed.quote.bridge,
          parseUnits(amount.trim(), 7),
          reviewed.quote.conversion?.sourceMax ?? null,
          reviewed.quote.conversion ? "conversion" : "bridge",
          destination,
          route,
        ),
      );
    } catch {
      intentMatches = false;
    }
    if (reviewed.key !== quoteKey || !intentMatches) {
      setReviewing(false);
      setReviewed(null);
      setReviewApproval(null);
      setError("The reviewed transfer intent changed. Review the updated path before signing.");
      return;
    }
    const reviewedQuote = reviewed.quote;
    const requiredXlm =
      (reviewedQuote.source.id === XLM.id ? reviewedQuote.sourceAmount : 0n) +
      (reviewedQuote.bridge.route === 1 ? reviewedQuote.bridge.relayGas : 0n);
    const nativeStatus = xlmShortfall(
      balances.find((asset) => asset.id === XLM.id),
      requiredXlm,
    );
    if (nativeStatus !== "ok") {
      setReviewing(false);
      setReviewed(null);
      setReviewApproval(null);
      setError(
        nativeStatus === "unknown"
          ? "Stellar reserve and fee parameters could not be confirmed. Refresh and try again."
          : "Your spendable XLM no longer covers this transfer plus its reserve.",
      );
      return;
    }
    try {
      assertCheckpointStorage();
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    setReviewing(false);
    const controller = new AbortController();
    waitController.current?.abort();
    waitController.current = controller;
    const generation = ++waitGeneration.current;
    approvalFocusPending.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    setPhase("preparing");
    const sender = wallet.address;
    const initialRecipient = recipient;
    const initialAmount = amount;
    const initialSourceId = source.id;
    const initialDestination = destination;
    const initialRoute = route;
    let ownership: Awaited<ReturnType<typeof acquireOperationOwnership>>;
    try {
      ownership = await acquireOperationOwnership({
        account: sender,
        recipient: validateRecipient(recipient),
        destination,
        route,
        bridgeAmount: String(reviewedQuote.bridge.requestedAmount),
        stage: reviewedQuote.conversion ? "conversion" : "bridge",
      });
      if (controller.signal.aborted || generation !== waitGeneration.current) {
        ownership.release();
        setBusy(false);
        setPhase(null);
        return;
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
      setPhase(null);
      return;
    }
    const isSuperseded = () => {
      const currentOwner = getOperationOwnership();
      if (currentOwner?.id !== ownership.id) return true;
      const current = liveReview.current;
      if (
        current.recipient !== initialRecipient ||
        current.amount !== initialAmount ||
        current.sourceId !== initialSourceId ||
        current.destination !== initialDestination ||
        current.route !== initialRoute
      )
        return true;
      if (!current.account) return true;
      try {
        return !reviewedIntentMatches(
          reviewed.intent,
          makeReviewedIntent(
            current.account,
            {
              id: current.sourceId,
              code: current.sourceCode,
              issuer: current.sourceIssuer,
            },
            current.recipient,
            reviewedQuote.bridge,
            parseUnits(current.amount.trim(), 7),
            reviewedQuote.conversion?.sourceMax ?? null,
            reviewedQuote.conversion ? "conversion" : "bridge",
            current.destination,
            current.route,
          ),
        );
      } catch {
        return true;
      }
    };
    let converted: TransferCheckpoint | null = null;
    const pending = (stage: "conversion" | "bridge", hash: string): TransferCheckpoint => ({
      router: TESTNET.router,
      token: TESTNET.token,
      account: sender,
      recipient: validateRecipient(recipient),
      destination,
      route,
      bridgeAmount: String(reviewedQuote.bridge.requestedAmount),
      stage,
      txHash: hash,
      source: {
        id: reviewedQuote.source.id,
        code: reviewedQuote.source.code,
        issuer: reviewedQuote.source.issuer,
      },
    });
    const conversionReconcile: SubmissionReconciliation = {
      expectedAccount: sender,
      reviewedIntent: reviewed.intent,
      getCurrentAccount: () => liveReview.current.account ?? null,
      isSuperseded,
      onSigned: async (hash) => {
        await commitCheckpoint(pending("conversion", hash));
      },
      onAccountSwitch: async (hash) => {
        await commitCheckpoint(pending("conversion", hash));
      },
    };
    const bridgeReconcile: SubmissionReconciliation = {
      expectedAccount: sender,
      reviewedIntent: reviewed.intent,
      getCurrentAccount: () => liveReview.current.account ?? null,
      isSuperseded,
      onSigned: async (hash) => {
        const saved = await commitCheckpoint(pending("bridge", hash));
        if (saved) await rememberLocalTransfer({ checkpoint: saved, sourceStatus: "unknown" });
      },
      onAccountSwitch: async (hash) => {
        const saved = await commitCheckpoint(pending("bridge", hash));
        if (saved) await rememberLocalTransfer({ checkpoint: saved, sourceStatus: "unknown" });
      },
    };
    try {
      if (reviewedQuote.conversion) {
        setStep("conversion");
        const swap = await submitConversion(
          wallet.address,
          reviewedQuote.conversion,
          (xdr, opts) => wallet.signTransaction(xdr, { ...opts, operation: "conversion" }),
          (next) => {
            setPhase(next);
          },
          { ...reviewApproval, operation: "conversion" },
          conversionReconcile,
          controller.signal,
        );
        if (generation !== waitGeneration.current) return;
        if (swap.status !== "confirmed") {
          setResult(swap);
          if (swap.status === "failed")
            setError("The conversion failed. No bridge transaction was submitted.");
          return;
        }
        converted = pending("conversion", swap.txHash);
        await commitCheckpoint(converted);
        setResult(swap);
        return;
      }
      setStep("bridge");
      setPhase("preparing");
      const submitted = await submitBridgeOut(
        wallet.address,
        reviewedQuote.bridge,
        recipient,
        (xdr, opts) => wallet.signTransaction(xdr, { ...opts, operation: "bridge" }),
        (next, hash) => {
          setPhase(next);
          if (hash) {
            setResult({ status: "pending", txHash: hash });
          }
        },
        { ...reviewApproval, operation: "bridge" },
        bridgeReconcile,
        reviewed.simulation ?? undefined,
        controller.signal,
        (diff) => {
          if (generation === waitGeneration.current) setQuoteDiff(diff);
        },
      );
      if (generation !== waitGeneration.current) return;
      const saved = getTransferCheckpoint();
      if (saved && (submitted.status === "confirmed" || submitted.status === "failed"))
        await rememberLocalTransfer({ checkpoint: saved, sourceStatus: submitted.status });
      setResult(submitted);
    } catch (cause) {
      if (cause instanceof QuoteChangedError) {
        setQuoteDiff(cause.diff);
        setReviewed(null);
        setReviewApproval(null);
        setError(null);
      } else {
        const message = errorMessage(cause);

        setError(message);
      }
    } finally {
      ownership.release();
      setBusy(false);
      setPhase(null);
    }
  };
  const reset = async () => {
    if (!checkpoint) return;
    try {
      await commitCheckpoint(null, checkpoint);
      setResult(null);
      setError(null);
      setReviewed(null);
      setQuoteDiff(null);
      setAmount("");
      setSimulatedState(null);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const insufficient = quote && spendableUnits !== undefined && spendableUnits < quote.sourceAmount;
  // Exceeds route liquidity even when the wallet balance is sufficient.
  const exceedsFlow =
    !insufficient &&
    quote !== null &&
    conservativeMax !== null &&
    quote.sourceAmount > conservativeMax &&
    isUsdcSource;
  // The sender's XLM must cover any amount drawn directly from it (when XLM is the source) plus
  // the live relay gas budget Axelar ITS bridging already quotes, on top of its own live reserve.
  const xlmRequired = quote
    ? (source.id === XLM.id ? quote.sourceAmount : 0n) +
      (quote.bridge.route === 1 ? quote.bridge.relayGas : 0n)
    : 0n;
  const xlmStatus = quote ? xlmShortfall(xlmAsset, xlmRequired) : "ok";

  const needsTrustline = !balances.some((asset) => asset.id === USDC.id);
  // The reserve a new trustline locks, and the network fee and (for an XLM source) the amount
  // the conversion itself spends, all come out of the same XLM balance. Fold them together here
  // so the review screen discloses the one number that actually decides whether signing is safe,
  // not just the trustline reserve in isolation.
  const reserveImpact =
    quote?.conversion && reserve
      ? trustlineReserveImpact(reserve, quote.conversion, needsTrustline)
      : null;
  const trustlineReserveInsufficient =
    !!quote?.conversion && !!reserveImpact && reserveImpact.projectedSpendable < 0n;
  const trustlineReserveUnknown = !!quote?.conversion && reserve === null;
  // The review dialog shows a frozen snapshot (`reviewed`), which can lag the live `quote` while
  // the dialog stays open, so its disclosure is computed from that same snapshot rather than from
  // whatever is live, keeping the number on screen identical to what is about to be signed.
  const reviewedImpact =
    reviewed?.quote.conversion && reserve
      ? trustlineReserveImpact(reserve, reviewed.quote.conversion, reviewed.addTrustline)
      : null;
  const reviewedReserveInsufficient = !!reviewedImpact && reviewedImpact.projectedSpendable < 0n;
  let recipientProblem = false;
  if (recipient.trim()) {
    try {
      validateRecipient(recipient);
    } catch {
      recipientProblem = true;
    }
  }
  const amountProblem = amount.trim() !== "" && !amountValidation.valid;
  const sourceReadBlocked =
    valid &&
    !!wallet.address &&
    (sourceBalance === undefined ||
      !trustlineOk ||
      xlmStatus !== "ok" ||
      trustlineReserveUnknown ||
      trustlineReserveInsufficient);
  const routeReadBlocked =
    !runtimeReady ||
    !!laneError ||
    (valid && lane !== null && !lane.available) ||
    !!quoteError ||
    !!simulationError;
  const validationSummary = [
    amountProblem ? { id: "send-amount", label: "amount" } : null,
    recipientProblem ? { id: "recipient", label: "destination wallet" } : null,
    insufficient || exceedsFlow ? { id: "send-amount", label: "amount and available limit" } : null,
    sourceReadBlocked ? { id: "bridge-action-help", label: "balance and reserve checks" } : null,
    routeReadBlocked ? { id: "bridge-action-help", label: "route and fee checks" } : null,
    error || wallet.error
      ? {
          id: checkpoint ? "pending-recovery-message" : "bridge-action-help",
          label: "recovery guidance",
        }
      : null,
  ].filter((item): item is { id: string; label: string } => item !== null);
  const actionHelp = checkpoint
    ? "Check the saved source transaction before approving another transfer."
    : !runtimeReady
      ? message(
          runtime.capabilities.routes[route === 0 ? "cctp" : "relay"] === "missing"
            ? "staticFeeUnavailable"
            : "runtimeUnknown",
        )
      : refreshing || fetching
        ? "Wait while the current route and fee estimate are loaded."
        : simulating
          ? "Wait while the current transaction simulation is checked."
          : busy
            ? "An approval or source transaction check is already in progress."
            : amountProblem || recipientProblem || !valid
              ? "Enter a valid amount and destination wallet before reviewing."
              : !wallet.address
                ? "Connect your Stellar wallet to check its balance and review this transfer."
                : laneError || (lane && !lane.available)
                  ? (lane?.reason ?? "Network verification is unavailable. Refresh to try again.")
                  : quoteError
                    ? "The route or fee read failed. Refresh to retry before reviewing."
                    : simulationError
                      ? "The transaction check failed. Refresh to retry before reviewing."
                      : insufficient || exceedsFlow
                        ? "Reduce the amount to fit your spendable balance and the available route limit."
                        : sourceBalance === undefined
                          ? "Your current source balance has not been confirmed. Refresh to retry."
                          : !trustlineOk
                            ? "This source asset is not authorized for spending. Choose an available asset."
                            : xlmStatus !== "ok" ||
                                trustlineReserveUnknown ||
                                trustlineReserveInsufficient
                              ? "The account reserve and network fee checks must pass before reviewing."
                              : !quote || (!quote.conversion && !simulation)
                                ? "Wait for the current route and transaction checks to finish."
                                : "Quote and balance checks complete. Review the exact amounts to continue. No transaction has been submitted.";

  return (
    <>
      {checkpoint && (
        <PendingTransferCard
          key={JSON.stringify([checkpoint, wallet.address])}
          checkpoint={checkpoint}
          busy={busy}
          onReset={reset}
        />
      )}
      <section
        className={styles.panel}
        aria-labelledby="bridge-heading"
        aria-busy={fetching || simulating || refreshing}
      >
        <div className={styles.heading}>
          <div>
            <h2 id="bridge-heading">Bridge assets</h2>
          </div>
          <button
            type="button"
            className={styles.refresh}
            aria-label="Refresh quote and networks"
            title="Refresh quote and networks"
            aria-describedby="bridge-action-help"
            aria-busy={refreshing}
            disabled={locked || refreshing || fetching || simulating}
            onClick={() => {
              if (locked || refreshGate.current || fetching || simulating) return;
              refreshGate.current = `${destination}:${route}:${refresh + 1}`;
              setRefreshing(true);
              setRefresh((value) => value + 1);
              invalidateQuote();
            }}
          >
            <RefreshCw size={17} aria-hidden="true" />
          </button>
        </div>
        <div className={styles.assetPanel}>
          <div className={styles.fieldHeading}>
            <label htmlFor="send-amount">You send</label>
            <span>
              <span className={styles.chainDot} />
              Stellar Testnet
            </span>
          </div>
          <div className={styles.amountRow}>
            <input
              id="send-amount"
              aria-label="Amount to send"
              aria-describedby={
                validationSummary.length
                  ? "send-amount-help bridge-validation-summary"
                  : "send-amount-help"
              }
              aria-invalid={amountProblem || !!insufficient || exceedsFlow}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              placeholder="0.00"
              disabled={locked}
              onChange={(event) => {
                setAmount(event.target.value);
                invalidateQuote();
                setError(null);
              }}
            />
            {wallet.address && walletAsset && source.id !== "native" && (
              <button
                type="button"
                className={styles.maxSpend}
                aria-label="Use spendable balance"
                aria-describedby="bridge-action-help"
                disabled={
                  locked ||
                  conservativeMax === null ||
                  activeSource.trustline === "frozen" ||
                  activeSource.trustline === "unauthorized"
                }
                onClick={() => {
                  if (conservativeMax !== null) {
                    setAmount(formatUnits(conservativeMax, 7));
                    invalidateQuote();
                    setError(null);
                  }
                }}
              >
                Max
              </button>
            )}
            <button
              type="button"
              className={styles.tokenSelector}
              aria-label="Choose source token"
              disabled={busy}
              onClick={() => {
                setPicker("source");
              }}
            >
              <AssetIcon code={source.code} />
              <span>{source.code}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          </div>
          <p id="send-amount-help" className={styles.balance} aria-live="polite">
            {amountValidation.valid ? message("amountValid") : amountValidation.message}
          </p>
          <p className={styles.balance}>
            {wallet.address
              ? sourceBalance !== undefined
                ? source.id === XLM.id
                  ? xlmAsset?.nativeMinimumReserve !== undefined
                    ? `Balance: ${sourceBalance} XLM (${xlmAsset.available} spendable after reserve and fees)`
                    : "Balance: " +
                      sourceBalance +
                      " XLM (spendable amount unconfirmed. Refresh to retry.)"
                  : walletAsset?.sellingLiabilities &&
                      parseUnits(walletAsset.sellingLiabilities, 7) > 0n
                    ? `Balance: ${sourceBalance} ${source.code} (Spendable: ${spendableBalance(walletAsset)} ${source.code})`
                    : `Balance: ${sourceBalance} ${source.code}`
                : (accounts?.error ?? "Reading your balance...")
              : "Choose any liquid Stellar asset"}
          </p>
          <p className={styles.balance}>
            {issuerVerificationLabel(activeSource)}. {trustlineLabel(activeSource)}.
          </p>
          {source.issuer && source.id !== USDC.id && (
            <a
              className={styles.balance}
              href={`https://stellar.expert/explorer/testnet/asset/${source.code}-${source.issuer}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Issuer: {source.issuer.slice(0, 7)}...{source.issuer.slice(-7)}
            </a>
          )}
        </div>
        <div className={styles.connector} aria-hidden="true">
          <ArrowDown size={18} />
        </div>
        <div className={`${styles.assetPanel} ${styles.receivePanel}`}>
          <div className={styles.fieldHeading}>
            <span>You receive{route === 0 ? " at least" : ""}</span>
            <button
              type="button"
              className={styles.networkSelector}
              aria-label="Choose destination network and token"
              disabled={locked}
              onClick={() => {
                setPicker("destination");
              }}
            >
              {chain.name}
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          </div>
          <div className={styles.amountRow}>
            {fetching ? (
              <div className={styles.skeleton} aria-hidden="true" />
            ) : (
              <output aria-label="Minimum received" className={styles.receiveAmount}>
                {quote ? (
                  formatUnits(quote.bridge.destinationAmount, destinationDecimals(route))
                ) : (
                  <span className={styles.emptyAmount}>{quoteError ? "Unavailable" : "0.00"}</span>
                )}
              </output>
            )}
            <button
              type="button"
              className={styles.tokenSelector}
              aria-label="Choose receive token and bridge"
              disabled={locked}
              onClick={() => {
                setPicker("destination");
              }}
            >
              <AssetIcon code="USDC" />
              <span>USDC{route === 1 && <small>ITS</small>}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          </div>
          <p className={styles.balance}>
            {route === 0
              ? "Circle CCTP delivers native USDC after Stellar source confirmation; destination delivery is separate."
              : "Axelar ITS delivers a representation of Stellar USDC, not Circle's native USDC. Destination delivery is separate."}
          </p>
          <details className={styles.identityDetails}>
            <summary>Inspect canonical USDC identity</summary>
            <p>
              Stellar USDC is identified by its code and issuer. The configured token contract and
              router are compared with the checked-in Stellar Testnet deployment; a mismatch blocks
              bridge readiness.
            </p>
            <dl>
              <div>
                <dt>Stellar asset</dt>
                <dd>{STELLAR_DEPLOYMENT.usdcCode} (7 decimals)</dd>
              </div>
              <div>
                <dt>Canonical issuer</dt>
                <dd>
                  <CopyableAddress
                    value={STELLAR_DEPLOYMENT.usdcIssuer}
                    label="canonical USDC issuer"
                  />
                </dd>
              </div>
              <div>
                <dt>Configured Stellar token contract (SAC)</dt>
                <dd>
                  <CopyableAddress value={TESTNET.token} label="configured Stellar USDC contract" />
                </dd>
              </div>
              <div>
                <dt>Verified deployment token contract</dt>
                <dd>
                  <CopyableAddress
                    value={STELLAR_DEPLOYMENT.usdcToken}
                    label="verified Stellar USDC contract"
                  />
                </dd>
              </div>
              <div>
                <dt>Configured bridge router</dt>
                <dd>
                  <CopyableAddress value={TESTNET.router} label="configured bridge router" />
                </dd>
              </div>
              <div>
                <dt>Verified deployment router</dt>
                <dd>
                  <CopyableAddress
                    value={STELLAR_DEPLOYMENT.router}
                    label="verified deployment router"
                  />
                </dd>
              </div>
              <div>
                <dt>Deployment identity</dt>
                <dd role={deploymentMismatch ? "alert" : "status"}>
                  {deploymentMismatch ??
                    "Configured router and USDC contract match the verified deployment."}
                </dd>
              </div>
              <div>
                <dt>Selected destination representation</dt>
                <dd>
                  {route === 0
                    ? "Circle CCTP native USDC (6 decimals)"
                    : "Axelar ITS USDC representation (7 decimals)"}
                  {destinationRepresentation ? (
                    <CopyableAddress
                      value={destinationRepresentation}
                      label={
                        route === 0 ? "native destination USDC contract" : "ITS destination token"
                      }
                    />
                  ) : (
                    <span className={styles.identityNotice}>
                      Address is shown after the ITS lane is independently verified.
                    </span>
                  )}
                </dd>
              </div>
              {route === 1 && (
                <div>
                  <dt>Axelar ITS service</dt>
                  <dd>
                    <CopyableAddress value={chain.its} label="Axelar ITS service contract" />
                  </dd>
                </div>
              )}
            </dl>
            <p>
              Stellar source confirmation starts processing; it does not confirm destination
              delivery. Track the destination leg separately.
            </p>
          </details>
        </div>
        <div className={styles.recipientField}>
          <label htmlFor="recipient">
            <Wallet size={14} aria-hidden="true" /> Destination wallet
          </label>
          <input
            id="recipient"
            aria-label={`Recipient on ${chain.name}`}
            aria-invalid={recipientProblem}
            aria-describedby={validationSummary.length ? "bridge-validation-summary" : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="0x..."
            value={recipient}
            disabled={locked}
            onBlur={() => {
              setTouched(true);
            }}
            onChange={(event) => {
              setRecipient(event.target.value);
              invalidateQuote();
              setError(null);
            }}
          />
        </div>
        {fetching ? (
          <div className={styles.fetching} role="status">
            <span className={styles.fetchOrbit} aria-hidden="true">
              <LoaderCircle size={22} />
            </span>
            <div>
              <strong>Finding your route</strong>
              <span>{message("routeLoading")}</span>
            </div>
            <span className={styles.fetchDots} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : quote ? (
          <details className={styles.routeDetails}>
            <summary>
              <span className={styles.routeIdentity}>
                <ShieldCheck size={16} aria-hidden="true" />
                {quote.conversion && (
                  <>
                    Stellar DEX <ArrowRight size={12} aria-hidden="true" />
                  </>
                )}
                {provider(route)}
              </span>
              <span>
                Fee details <ChevronDown size={13} aria-hidden="true" />
              </span>
            </summary>
            <QuoteDetails
              quote={quote.bridge}
              simulation={simulation}
              simulating={simulating}
              simulationError={simulationError}
            />
            {quote.conversion && <ConversionDetails conversion={quote.conversion} />}
            <p className={styles.assetNote}>
              Quoted at Stellar ledger {quote.bridge.ledger}. Fees are checked again before signing.
            </p>
            <p className={styles.assetNote}>
              Estimates and approved budgets are separate. Axelar gas is approved in XLM, Circle
              forwarding is approved in USDC, and any refund depends on provider behavior.
            </p>
          </details>
        ) : (
          !locked && (
            <p className={styles.quotePrompt}>
              {lane?.available
                ? "Enter an amount and destination wallet to find your route."
                : (lane?.reason ??
                  (laneError
                    ? "Network verification is unavailable. Refresh to try again."
                    : "Checking bridge availability..."))}
            </p>
          )
        )}
        {validationSummary.length > 0 && (
          <nav
            id="bridge-validation-summary"
            aria-label="Transfer review checks"
            className={styles.validationSummary}
          >
            <strong>Review before continuing</strong>
            <ul>
              {validationSummary.map((item) => (
                <li key={`${item.id}-${item.label}`}>
                  <a
                    href={`#${item.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      const target = document.getElementById(item.id);
                      target?.focus();
                      target?.scrollIntoView({ block: "center" });
                    }}
                  >
                    Review {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        {checkpointStorageError && (
          <p role="alert" className={styles.error}>
            {checkpointStorageError}
          </p>
        )}
        {!error && !wallet.error && quoteError && quoteDiagnostic ? (
          <div role="alert" className={styles.limitDiagnostic}>
            <strong>{quoteDiagnostic.limitLabel}</strong>
            <span>{quoteDiagnostic.summary}</span>
            <span>{quoteDiagnostic.nextStep}</span>
          </div>
        ) : (
          (error ?? wallet.error ?? quoteError ?? laneError ?? (touched && inputError)) && (
            <p role="alert" className={styles.error}>
              {error ?? wallet.error ?? quoteError ?? laneError ?? inputError}
            </p>
          )
        )}
        {quoteError && feeCooldown?.key === quoteKey && (
          <button
            type="button"
            className={styles.secondary}
            disabled={locked || retryFeeSeconds > 0}
            onClick={() => {
              setFeeCooldown(null);
              setQuoteVersion((version) => version + 1);
            }}
          >
            {retryFeeSeconds > 0 ? `Retry quote in ${retryFeeSeconds} seconds` : "Retry fee quote"}
          </button>
        )}
        {insufficient && (
          <p role="alert" className={styles.error}>
            {walletAsset?.sellingLiabilities && parseUnits(walletAsset.sellingLiabilities, 7) > 0n
              ? `Your spendable ${source.code} balance (${spendableBalance(walletAsset)} ${source.code}) is lower than this amount due to selling liabilities.`
              : `Your ${source.code} balance is lower than this amount.`}
          </p>
        )}
        {exceedsFlow && (
          <p role="alert" className={styles.error}>
            {`This amount exceeds the available route limit. Maximum bridgeable: ${formatUnits(conservativeMax, 7)} USDC.`}
          </p>
        )}
        {quoteDiff && (
          <section className={styles.quoteDiff} aria-label="Refreshed quote comparison">
            <QuoteDiffDetails diff={quoteDiff} />
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => {
                setQuoteDiff(null);
                invalidateQuote();
              }}
            >
              Refresh quote for review
            </button>
          </section>
        )}
        {xlmStatus === "insufficient" && (
          <p role="alert" className={styles.error}>
            Your spendable XLM will not cover {source.id === XLM.id ? "this amount plus" : ""} the
            required reserve
            {quote?.bridge.route === 1 ? " and the Axelar relay gas budget" : ""}.
          </p>
        )}
        {xlmStatus === "unknown" && (
          <p role="alert" className={styles.error}>
            Stellar reserve and fee parameters for your account could not be confirmed. Refresh to
            try again before sending.
          </p>
        )}
        {quote?.conversion && reserveImpact && (
          <p className={styles.assetNote} role={trustlineReserveInsufficient ? "alert" : "status"}>
            {reserveImpact.addsTrustline
              ? `Signing also opens your USDC trustline, locking ${formatUnits(reserveImpact.trustlineReserve, 7)} XLM (${reserveImpact.trustlineReserve} stroops) in reserve. `
              : "You already hold a USDC trustline; no new reserve is locked. "}
            Network fee: {formatUnits(reserveImpact.networkFee, 7)} XLM.
            {reserveImpact.sourceSpend > 0n &&
              ` Converting spends up to ${formatUnits(reserveImpact.sourceSpend, 7)} XLM.`}{" "}
            Spendable XLM after signing: {formatUnits(reserveImpact.projectedSpendable, 7)} XLM.
          </p>
        )}
        {quote?.conversion && needsTrustline && reserveError && (
          <p className={styles.error}>{reserveError}</p>
        )}
        {result?.failure && (
          <p role="status" className={styles.assetNote}>
            {result.failure.stage === "broadcast"
              ? message("sourceBroadcastUnknown")
              : message("sourceConfirmationUnavailable")}{" "}
            {message("sourceCheckBeforeApproval")}
          </p>
        )}
        {busy && (
          <p role="status" className={styles.progress}>
            <LoaderCircle className={styles.spinner} size={16} aria-hidden="true" />
            {message(step === "conversion" ? "stepConversion" : "stepBridge")}:{" "}
            {phaseMessage(phase, translations)}.
          </p>
        )}
        {busy && phase === "pending" && (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => waitController.current?.abort()}
          >
            {message("stopWaiting")}
          </button>
        )}
        <button
          type="button"
          className={styles.secondary}
          disabled={busy}
          onClick={() => {
            void shareConfiguration();
          }}
        >
          Share transfer configuration
        </button>
        {shareStatus && (
          <p role="status" className={styles.reviewNote}>
            {shareStatus}
          </p>
        )}
        {!wallet.isConnected ? (
          <button
            type="button"
            className={styles.primary}
            onClick={() => {
              void wallet.connect();
            }}
            disabled={wallet.isConnecting}
          >
            <Wallet size={17} aria-hidden="true" />
            {wallet.isConnecting ? "Connecting wallet..." : "Connect Stellar wallet"}
            <ArrowUpRight size={18} aria-hidden="true" />
          </button>
        ) : (
          !checkpoint && (
            <button
              ref={reviewAction}
              aria-describedby="bridge-action-help"
              aria-busy={fetching || simulating}
              type="button"
              className={styles.primary}
              disabled={
                !runtimeReady ||
                !quote ||
                (!quote.conversion && !simulation) ||
                busy ||
                !!insufficient ||
                xlmStatus !== "ok" ||
                sourceBalance === undefined ||
                activeSource.trustline === "frozen" ||
                activeSource.trustline === "unauthorized" ||
                trustlineReserveUnknown ||
                trustlineReserveInsufficient
              }
              onClick={() => {
                if (
                  !runtimeReady ||
                  !wallet.address ||
                  !quote ||
                  (!quote.conversion && !simulation)
                )
                  return;
                const intent = makeReviewedIntent(
                  wallet.address,
                  quote.source,
                  recipient,
                  quote.bridge,
                  quote.sourceAmount,
                  quote.conversion?.sourceMax ?? null,
                  quote.conversion ? "conversion" : "bridge",
                  destination,
                  route,
                );
                setReviewApproval({
                  account: wallet.address,
                  network: TESTNET.networkPassphrase,
                  operation: quote.conversion ? "conversion" : "bridge",
                });
                setReviewed({
                  key: quoteKey,
                  quote,
                  intent,
                  simulation,
                  addTrustline: needsTrustline,
                });
                setQuoteDiff(null);
                setReviewing(true);
              }}
            >
              {fetching
                ? "Finding your route..."
                : simulating
                  ? "Estimating bridge fees..."
                  : simulationError
                    ? "Refresh to retry simulation"
                    : message("reviewTransfer")}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          )
        )}
        <p id="bridge-action-help" tabIndex={-1} role="status" className={styles.reviewNote}>
          {actionHelp}
        </p>
        <p className={styles.feeNote}>
          <ShieldCheck size={13} aria-hidden="true" />
          You stay in control. Your wallet signs every transaction.
        </p>
        <details className={styles.support}>
          <summary>
            New to testnet? Get started <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <p>Use test assets only. Fund your wallet with XLM for network fees and relay gas.</p>
          <a
            href="https://laboratory.stellar.org/account/fund"
            target="_blank"
            rel="noopener noreferrer"
          >
            Get testnet XLM <ArrowUpRight size={13} aria-hidden="true" />
          </a>
          <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer">
            Get testnet USDC <ArrowUpRight size={13} aria-hidden="true" />
          </a>
          <p>
            Add the USDC trustline before using Circle&apos;s faucet. Conversion from another token
            can create the trustline with your signature.
          </p>
          <p className={styles.address}>USDC issuer: {TESTNET.usdcIssuer}</p>
          <p className={styles.address}>Router: {TESTNET.router}</p>
        </details>
      </section>
      {picker === "source" && (
        <SourceAssetPicker
          selected={source}
          balances={balances}
          pendingRecovery={checkpoint?.source ?? null}
          onSelect={(asset) => {
            // Editing the form never removes a signed operation or its original intent.
            // The pending card keeps its own account, amount and explicit bridge review.
            setSource(asset);
            invalidateQuote();
            setError(
              checkpoint?.stage === "conversion" && !checkpointForAsset(checkpoint, asset)
                ? "Your saved conversion belongs to the previous source asset. Check its status and review its bridge separately before starting another transfer."
                : null,
            );
          }}
          onClose={() => {
            setPicker(null);
          }}
        />
      )}
      {picker === "destination" && (
        <DestinationPicker
          destination={destination}
          route={route}
          onSelect={(next, bridge) => {
            setDestination(next);
            setRoute(bridge);
            invalidateQuote();
            setError(null);
          }}
          onClose={() => {
            setPicker(null);
          }}
        />
      )}
      {reviewing && reviewed && (
        <ReviewDialog
          onClose={() => {
            setReviewing(false);
            setReviewed(null);
          }}
          footer={
            <>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={() => {
                  setReviewing(false);
                  setReviewed(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={
                  busy ||
                  laneRefreshing ||
                  !lane?.available ||
                  reviewedReserveInsufficient ||
                  (!!reviewed.quote.conversion && !reserve) ||
                  (!reviewed.quote.conversion && (simulating || !!simulationError || !simulation))
                }
                onClick={() => {
                  void submit();
                }}
              >
                {simulating
                  ? "Estimating simulation..."
                  : simulationError
                    ? "Approval blocked"
                    : "Confirm in wallet"}{" "}
                <ArrowUpRight size={17} aria-hidden="true" />
              </button>
            </>
          }
        >
          <div className={styles.reviewTotal}>
            <span>You send {reviewed.quote.conversion ? "up to" : ""}</span>
            <strong>
              {formatUnits(reviewed.quote.sourceAmount, 7)} {reviewed.quote.source.code}
            </strong>
            <ArrowDown size={20} aria-hidden="true" />
            <span>You receive at least</span>
            <strong>
              {formatUnits(
                reviewed.quote.bridge.destinationAmount,
                destinationDecimals(reviewed.quote.bridge.route),
              )}{" "}
              {receiveSymbol(reviewed.quote.bridge.route)}
            </strong>
          </div>
          <p className={styles.reviewNote}>
            From Stellar Testnet to {destinationFor(reviewed.quote.bridge.destination).name} via{" "}
            {provider(reviewed.quote.bridge.route)}.
          </p>
          <p className={styles.address}>Recipient: {validateRecipient(recipient)}</p>
          {reviewed.quote.source.issuer && reviewed.quote.source.id !== USDC.id && (
            <p className={styles.address}>Source issuer: {reviewed.quote.source.issuer}</p>
          )}
          {reviewApproval && (
            <ApprovalDetails
              approval={reviewApproval}
              {...(reviewed.quote.source.issuer ? { issuer: reviewed.quote.source.issuer } : {})}
            />
          )}
          <p className={styles.reviewNote}>
            {issuerVerificationLabel(reviewed.quote.source)}.{" "}
            {trustlineLabel(reviewed.quote.source)}.
          </p>
          {reviewed.quote.conversion && (
            <ConversionIntent
              conversion={reviewed.quote.conversion}
              addTrustline={reviewed.addTrustline}
            />
          )}
          {reviewed.quote.conversion && reviewedImpact && (
            <p
              className={styles.reviewNote}
              role={reviewedReserveInsufficient ? "alert" : undefined}
            >
              {reviewedImpact.addsTrustline
                ? `This signature also opens your USDC trustline, locking ${formatUnits(reviewedImpact.trustlineReserve, 7)} XLM (${reviewedImpact.trustlineReserve} stroops) as reserve.`
                : "Your USDC trustline already exists; no new reserve is locked."}{" "}
              Network fee {formatUnits(reviewedImpact.networkFee, 7)} XLM
              {reviewedImpact.sourceSpend > 0n &&
                `, up to ${formatUnits(reviewedImpact.sourceSpend, 7)} XLM converted`}
              . Spendable XLM after signing: {formatUnits(reviewedImpact.projectedSpendable, 7)}{" "}
              XLM.
            </p>
          )}
          <QuoteDetails quote={reviewed.quote.bridge} simulation={reviewed.simulation} />
          {quoteDiff && (
            <section className={styles.quoteDiff} aria-label="Refreshed quote comparison">
              <QuoteDiffDetails diff={quoteDiff} />
            </section>
          )}
          {reviewed.quote.conversion && (
            <p className={styles.reviewNote}>
              Two signatures: convert to USDC, then review the bridge simulation and its fees. Price
              tolerance is 0.5%. If the bridge cannot proceed, your converted USDC remains in your
              wallet.
            </p>
          )}
          <p className={styles.reviewNote}>
            Recovery saves source hashes in this browser. Private sessions and browser cleanup can
            remove them; keep a copy of the signed source hash before leaving.
          </p>
          <p className={styles.reviewNote}>
            Source confirmation starts the transfer. Destination delivery is verified separately.
          </p>
          <p className={styles.reviewNote}>
            The signed transaction expires after {TRANSACTION_TIMEOUT_SECONDS} seconds. Expired
            signatures are never broadcast; review again to create a fresh envelope.
          </p>
          {reviewed.simulation && (
            <p className={styles.address}>
              Operation: bridge_out_with_gas ({formatUnits(reviewed.simulation.totalFee, 7)} XLM
              total envelope fee)
            </p>
          )}
          {simulationError && (
            <p role="alert" className={styles.error}>
              Simulation failed: {simulationError}. Approval blocked.
            </p>
          )}
        </ReviewDialog>
      )}
    </>
  );
}

export function ClaimRecovery() {
  const message = useMessages();
  const translations = useTranslations();
  const wallet = useStellarWallet();
  const currentAccount = useRef(wallet.address);
  useLayoutEffect(() => {
    currentAccount.current = wallet.address;
  }, [wallet.address]);
  const [id, setId] = useState("");
  const [claims, setClaims] = useState<PendingClaim[]>([]);
  const [batchSupported, setBatchSupported] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TransactionResult | null>(null);
  const [claimPhase, setClaimPhase] = useState<TransactionPhase | null>(null);
  const { checkpoint, blocked: claimStorageError } = useClaimSettlementCheckpoint();
  const [recovery, setRecovery] = useState<CheckpointRecoveryResult | null>(null);
  const settlementController = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const statusAction = useRef<HTMLButtonElement>(null);
  const resultAction = useRef<HTMLAnchorElement>(null);
  const settlementFocusPending = useRef(false);
  useEffect(() => {
    if (busy || !settlementFocusPending.current) return;
    settlementFocusPending.current = false;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active.isConnected &&
        !active.matches(":disabled")
      )
        return;
      if (statusAction.current && !statusAction.current.disabled) statusAction.current.focus();
      else resultAction.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [busy, checkpoint, result]);
  useEffect(() => {
    mounted.current = true;
    const activeGeneration = generation;
    return () => {
      mounted.current = false;
      activeGeneration.current++;
      settlementController.current?.abort();
    };
  }, []);
  const saveSignedClaims = (account: string, reviewed: readonly PendingClaim[], hash: string) => {
    const first = reviewed[0];
    if (!first) throw new Error("No reviewed claim identity is available.");
    saveClaimSettlementCheckpoint({
      router: TESTNET.router,
      account,
      chain: "stellar-testnet",
      deploymentHash: first.deployment.wasmHash,
      claimId: reviewed.map((claim) => claim.id).join(","),
      recipient: first.recipient,
      token: first.token,
      amount: reviewed.reduce((sum, claim) => sum + claim.amount, 0n).toString(),
      claims: reviewed.map((claim) => ({
        claimId: claim.id.toString(),
        recipient: claim.recipient,
        token: claim.token,
        amount: claim.amount.toString(),
      })),
      txHash: hash,
    });
  };
  const checkSettlement = async (saved: ClaimSettlementCheckpoint, signal?: AbortSignal) => {
    const active = () => !signal?.aborted && mounted.current;
    const outcome = await resolveClaimSettlementCheckpoint(saved, signal);
    if (!active()) return outcome;
    setRecovery(outcome);
    if (outcome.status !== "unknown") {
      const refreshed = await getClaims(
        claimSettlementIdentities(saved).map((claim) => BigInt(claim.claimId)),
      );
      if (!active()) return outcome;
      const identities = claimSettlementIdentities(saved);
      if (
        refreshed.some((claim, index) => {
          const identity = identities[index];
          if (!identity) return true;
          return (
            claim.id.toString() !== identity.claimId ||
            claim.recipient !== identity.recipient ||
            claim.token !== identity.token ||
            claim.amount.toString() !== identity.amount ||
            (outcome.status === "confirmed" && !claim.settled)
          );
        })
      )
        throw new Error(
          "Claim evidence changed during reconciliation. The saved hash remains unresolved.",
        );
      saveClaimSettlementCheckpoint(null, saved);
      setClaims(refreshed);
      setResult({ txHash: saved.txHash, status: outcome.status });
    }
    return outcome;
  };
  const reconcileSettlement = async () => {
    if (!checkpoint || busy || claimStorageError) return;
    const saved = checkpoint;
    const controller = new AbortController();
    settlementController.current?.abort();
    settlementController.current = controller;
    setBusy(true);
    setError(null);
    try {
      await checkSettlement(saved, controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy(false);
    }
  };
  const claimApproval: WalletApprovalProvenance | null = wallet.address
    ? {
        account: wallet.address,
        network: TESTNET.networkPassphrase,
        operation: "claim-settlement",
      }
    : null;
  const lookup = async () => {
    setBusy(true);
    setError(null);
    setClaims([]);
    setResult(null);
    try {
      const ids = id
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((value) => BigInt(value));
      setClaims(await getClaims(ids));
      setBatchSupported(ids.length > 1 ? await batchClaimSettlementSupport() : null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const loadOpenClaims = async () => {
    setBusy(true);
    setError(null);
    setClaims([]);
    setResult(null);
    try {
      const response = await fetchClaims({
        chain: "stellar-testnet",
        settled: "false",
        limit: "20",
      });
      const ids = response.claims.map((claim) => BigInt(claim.claimId));
      setId(ids.join(", "));
      setClaims(await getClaims(ids));
      setBatchSupported(ids.length > 1 ? await batchClaimSettlementSupport() : null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const settleReviewed = async (reviewed: readonly PendingClaim[]) => {
    if (!wallet.address || busy || checkpoint || claimStorageError || !reviewed.length) return;
    const account = wallet.address;
    const controller = new AbortController();
    settlementController.current?.abort();
    settlementController.current = controller;
    const scope = ++generation.current;
    const active = () =>
      mounted.current && scope === generation.current && !controller.signal.aborted;
    settlementFocusPending.current = true;
    let lease: Awaited<ReturnType<typeof acquireClaimSettlementLease>> | undefined;
    setBusy(true);
    setError(null);
    setRecovery(null);
    setClaimPhase("preparing");
    try {
      lease = await acquireClaimSettlementLease(account);
      assertCheckpointStorage();
      if (controller.signal.aborted || !mounted.current) return;
      const refreshed = await getClaims(reviewed.map((claim) => claim.id));
      setClaims(refreshed);
      if (
        refreshed.some((claim, index) => {
          const previous = reviewed[index];
          return (
            !previous ||
            claim.settled ||
            claim.recipient !== previous.recipient ||
            claim.token !== previous.token ||
            claim.amount !== previous.amount ||
            claim.deployment.wasmHash !== previous.deployment.wasmHash
          );
        })
      )
        throw new Error("The claims changed. Review the refreshed claims before signing.");
      const reconciliation: SubmissionReconciliation = {
        expectedAccount: account,
        getCurrentAccount: () => currentAccount.current,
        isSuperseded: () =>
          !mounted.current || scope !== generation.current || controller.signal.aborted,
        onSigned: (hash) => {
          saveSignedClaims(account, refreshed, hash);
        },
        onAccountSwitch: (hash) => {
          saveSignedClaims(account, refreshed, hash);
        },
      };
      const progress = (phase: TransactionPhase) => {
        if (mounted.current && scope === generation.current) setClaimPhase(phase);
      };
      const sign = (xdr: string, opts: Parameters<typeof wallet.signTransaction>[1]) =>
        wallet.signTransaction(xdr, { ...opts, operation: "claim" });
      const first = refreshed[0];
      if (!first) throw new Error("No current claim identity is available.");
      const transaction =
        refreshed.length === 1
          ? await submitSettleClaim(
              account,
              first.id,
              sign,
              claimApproval ?? undefined,
              reconciliation,
              controller.signal,
              first,
              progress,
            )
          : await submitSettleClaims(
              account,
              refreshed,
              sign,
              claimApproval ?? undefined,
              reconciliation,
              controller.signal,
              progress,
            );
      if (!active()) return;
      setResult(
        transaction.status === "confirmed" ? { ...transaction, status: "pending" } : transaction,
      );
      const saved = getClaimSettlementCheckpoint();
      if (transaction.status === "confirmed" && saved)
        await checkSettlement(saved, controller.signal);
    } catch (cause) {
      if (mounted.current && scope === generation.current) setError(errorMessage(cause));
    } finally {
      lease?.release();
      if (mounted.current && scope === generation.current) {
        setBusy(false);
        setClaimPhase(null);
      }
    }
  };
  const settleOne = (claim: PendingClaim) => settleReviewed([claim]);
  const settle = () => settleReviewed(claims);
  return (
    <section
      id="claim-recovery"
      className={`${styles.panel} ${styles.recovery}`}
      aria-labelledby="claims-heading"
    >
      <details>
        <summary>
          <div>
            <h2 id="claims-heading">Recover a Stellar claim</h2>
            <span>For funds parked on the Stellar router</span>
          </div>
          <Plus size={18} aria-hidden="true" />
        </summary>
        <div className={styles.recoveryBody}>
          <p>
            Review parked claims from the indexer or enter claim numbers. Every recipient and amount
            below is re-read from the deployed Stellar router before signing.
          </p>
          {claimStorageError && (
            <p role="alert" className={styles.error}>
              {claimStorageError}
            </p>
          )}
          {checkpoint && (
            <div className={styles.claimCheckpoint}>
              <p role="status" className={styles.reviewNote}>
                Settlement is unresolved. Check its outcome before requesting another signature.
              </p>
              <p className={styles.address}>Signed source hash: {checkpoint.txHash}</p>
              {claimSettlementIdentities(checkpoint).map((claim) => (
                <p className={styles.address} key={claim.claimId}>
                  Claim {claim.claimId}: {claim.amount} base units of {claim.token}, recipient{" "}
                  {claim.recipient}
                </p>
              ))}
              <button
                ref={statusAction}
                type="button"
                disabled={busy || !!claimStorageError}
                onClick={() => void reconcileSettlement()}
              >
                {message(busy ? "settlementChecking" : "settlementCheck")}
              </button>
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${checkpoint.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Inspect the saved source transaction
              </a>
            </div>
          )}
          {recovery && (
            <p role="status" aria-live="polite" className={styles.reviewNote}>
              {recovery.message}
            </p>
          )}
          {claimPhase && (
            <p role="status" aria-live="polite" className={styles.reviewNote}>
              {settlementPhaseMessage(claimPhase, translations)}
            </p>
          )}
          <button type="button" disabled={busy} onClick={() => void loadOpenClaims()}>
            {busy ? "Checking..." : "Load parked claims"}
          </button>
          <label htmlFor="claim-id">Claim number</label>
          <input
            id="claim-id"
            inputMode="numeric"
            placeholder="1, 2, 3"
            value={id}
            onChange={(event) => {
              setId(event.target.value);
              setClaims([]);
              setBatchSupported(null);
            }}
            disabled={busy}
          />
          <button
            type="button"
            disabled={!/^\d+(?:[\s,]+\d+)*$/.test(id.trim()) || busy}
            onClick={() => void lookup()}
          >
            {busy ? "Checking..." : "Review claims"}
          </button>
          {error && (
            <p role="alert" className={styles.error}>
              {error} Claim settlement remains unavailable until the verified router deployment
              matches.
            </p>
          )}
          {claims.length > 0 && (
            <>
              <ul>
                {claims.map((claim) => (
                  <li key={claim.id.toString()}>
                    <p className={styles.address}>
                      Claim {claim.id.toString()} recipient: {claim.recipient}
                    </p>
                    <p>
                      Amount:{" "}
                      {claim.token === TESTNET.token
                        ? `${formatUnits(claim.amount, 7)} USDC`
                        : `${claim.amount} base units of ${claim.token}`}
                    </p>
                    <p>Status: {claim.settled ? "settled on chain" : "parked"}</p>
                    <p className={styles.address}>
                      Verified router: {claim.deployment.router} (revision {claim.deployment.commit}
                      , deployed at ledger {claim.deployment.deployedLedger})
                    </p>
                    <p className={styles.address}>Router WASM: {claim.deployment.wasmHash}</p>
                    {(claims.length === 1 || batchSupported === false) &&
                      !claim.settled &&
                      claim.eligibility.status !== "unknown" &&
                      claimApproval && (
                        <>
                          <ApprovalDetails approval={claimApproval} />
                          <button
                            type="button"
                            disabled={
                              !wallet.address ||
                              busy ||
                              result?.status === "pending" ||
                              checkpoint !== null ||
                              !!claimStorageError
                            }
                            onClick={() => void settleOne(claim)}
                          >
                            Sign claim settlement
                          </button>
                        </>
                      )}
                  </li>
                ))}
              </ul>
              {claims.length > 1 && batchSupported === false && (
                <p>
                  Batch settlement is not supported by this router. Settle each claim separately.
                </p>
              )}
              {claims.length > 1 && batchSupported === true && claimApproval && (
                <>
                  <ApprovalDetails approval={claimApproval} />
                  <button
                    type="button"
                    disabled={
                      !wallet.address ||
                      busy ||
                      result?.status === "pending" ||
                      checkpoint !== null ||
                      !!claimStorageError
                    }
                    onClick={() => void settle()}
                  >
                    Sign batch settlement
                  </button>
                </>
              )}
              {!wallet.address && claims.some((claim) => !claim.settled) && (
                <p>Connect your Stellar wallet to pay the settlement network fee.</p>
              )}
            </>
          )}
          {result && (
            <Link ref={resultAction} href={`/transfers/${result.txHash}`}>
              {result.status === "confirmed"
                ? "Settlement confirmed"
                : result.status === "failed"
                  ? "Settlement failed"
                  : "Settlement pending"}
              : view transaction
            </Link>
          )}
        </div>
      </details>
    </section>
  );
}
