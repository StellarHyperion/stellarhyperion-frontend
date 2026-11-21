import type { TransactionPhase } from "../../contracts";

export type TransferStepId = "prepare" | "approve" | "submit" | "source" | "destination";
export type TransferStepState = "done" | "active" | "waiting";

export interface TransferProgressStep {
  id: TransferStepId;
  label: string;
  state: TransferStepState;
  detail: string;
}

export const DESTINATION_DELIVERY_NOTICE =
  "Destination delivery is tracked separately and is never confirmed by this screen.";

const PHASE_ORDER: Record<TransactionPhase, number> = {
  preparing: 0,
  signing: 1,
  submitting: 2,
  pending: 3,
  confirmed: 4,
};

const OPERATION_LABEL: Record<"conversion" | "bridge", string> = {
  conversion: "Converting to USDC",
  bridge: "Preparing your bridge",
};

/**
 * The same operation and outcome facts the animated indicator shows, expressed as static text.
 *
 * The destination step never advances here: Stellar source confirmation starts processing and
 * does not establish delivery on the destination chain. Decorating this list is up to CSS, so the
 * information survives with every animation disabled.
 */
export function transactionProgress(
  step: "conversion" | "bridge",
  phase: TransactionPhase | null,
): TransferProgressStep[] {
  const reached = phase === null ? -1 : PHASE_ORDER[phase];
  const state = (index: number): TransferStepState =>
    reached > index ? "done" : reached === index ? "active" : "waiting";
  const conversion = step === "conversion";
  return [
    {
      id: "prepare",
      label: conversion ? "Prepare Stellar conversion" : "Prepare Stellar bridge",
      state: state(0),
      detail: conversion
        ? "Rebuild the reviewed path and its exact source spending cap."
        : "Rebuild the reviewed bridge operation and its fee budget.",
    },
    {
      id: "approve",
      label: "Approve in your wallet",
      state: state(1),
      detail: "Your wallet signs this exact transaction. Nothing is signed automatically.",
    },
    {
      id: "submit",
      label: "Submit the signed transaction",
      state: state(2),
      detail: "Only the reviewed signed envelope is sent to Stellar Testnet.",
    },
    {
      id: "source",
      label: "Stellar source confirmation",
      state: state(3),
      detail: conversion
        ? "A confirmed conversion does not bridge funds. The bridge is a separate transaction."
        : "Source confirmation starts processing. It does not confirm destination delivery.",
    },
    {
      id: "destination",
      label: "Destination delivery",
      state: "waiting",
      detail: DESTINATION_DELIVERY_NOTICE,
    },
  ];
}

/** A single sentence for the live status region, independent of any animation. */
export function transactionProgressSummary(
  step: "conversion" | "bridge",
  phase: TransactionPhase | null,
): string {
  const prefix = `${OPERATION_LABEL[step]}: `;
  switch (phase) {
    case "signing":
      return `${prefix}confirm in your wallet.`;
    case "submitting":
      return `${prefix}submitting the signed transaction.`;
    case "pending":
      return `${prefix}waiting for Stellar source confirmation. ${DESTINATION_DELIVERY_NOTICE}`;
    case "confirmed":
      return step === "conversion"
        ? `${prefix}conversion confirmed on Stellar. The bridge is a separate transaction and still requires your wallet approval. ${DESTINATION_DELIVERY_NOTICE}`
        : `${prefix}Stellar source confirmed. ${DESTINATION_DELIVERY_NOTICE}`;
    default:
      return `${prefix}checking the current quote.`;
  }
}
