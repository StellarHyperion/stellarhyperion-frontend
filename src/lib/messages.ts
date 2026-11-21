import { formatUnits } from "@hyperion/protocol";
import type { TransactionPhase } from "../contracts/stellar";

export interface AmountVariables {
  readonly amount: string;
  readonly unit: string;
}

const english = {
  routeLoading: () => "Checking liquidity, bridge fees and the receive amount",
  runtimeChecking: () =>
    "Checking live fee availability. Source recovery and read-only history remain available where configured.",
  staticFeeUnavailable: () =>
    "Live fees are unavailable on this deployment. Source recovery and read-only history remain available where configured.",
  runtimeUnknown: () =>
    "Live fee availability could not be confirmed. Retry the read before reviewing a transfer. Source recovery and history remain available where configured.",
  runtimeReady: () =>
    "Live fee routes are available. Every transfer still requires a fresh quote, simulation and your wallet approval.",
  runtimeRetry: () => "Check live fee availability",
  runtimeRouteAvailable: ({ provider }: { readonly provider: string }) =>
    `${provider}: live fee route available.`,
  runtimeRouteUnavailable: ({ provider }: { readonly provider: string }) =>
    `${provider}: live fee route unavailable.`,
  runtimeReadOnly: () => "Source confirmation and destination delivery are checked separately.",
  transactionSubmitted: () =>
    "The transaction was submitted. Source confirmation and destination delivery are tracked separately.",
  phasePreparing: () => "checking the current quote",
  phaseSigning: () => "confirm in your wallet",
  phaseSubmitting: () => "submitting the signed transaction",
  phasePending: () => "waiting for Stellar confirmation",
  phaseConfirmed: () => "source confirmed on Stellar; destination delivery is checked separately",
  settlementPreparing: () => "Preparing claim settlement.",
  settlementSigning: () => "Confirm settlement in your wallet.",
  settlementSubmitting: () => "Broadcasting the signed settlement.",
  settlementPending: () => "Waiting for settlement confirmation; you may navigate away safely.",
  settlementConfirmed: () => "Settlement confirmed on Stellar.",
  settlementChecking: () => "Checking settlement...",
  settlementCheck: () => "Check settlement status",
  stepConversion: () => "Converting to USDC",
  stepBridge: () => "Preparing your bridge",
  sourceBroadcastUnknown: () => "The source broadcast outcome is unknown.",
  sourceConfirmationUnavailable: () => "Source confirmation is temporarily unavailable.",
  sourceCheckBeforeApproval: () =>
    "Check the saved source hash before approving another transaction.",
  recoveryFailedTitle: () => "Transaction failed on Stellar",
  conversionConfirmedTitle: () => "Conversion confirmed",
  conversionUnknownTitle: () => "Conversion source status unknown",
  bridgeConfirmedTitle: () => "Transfer confirmed on Stellar",
  bridgeUnknownTitle: () => "Transfer source status unknown",
  conversionConfirmed: () =>
    "Conversion confirmed on Stellar. Your bridge is a separate transaction and still requires your wallet approval.",
  conversionFailed: () => "Conversion failed on Stellar. No bridge transaction was submitted.",
  conversionUnknown: () =>
    "This saved signed hash does not establish broadcast or confirmation. Check the conversion source status before continuing with USDC.",
  bridgeConfirmed: () =>
    "Source transaction confirmed on Stellar. Destination delivery is tracked separately.",
  bridgeFailed: () =>
    "Source transaction failed on Stellar. No destination delivery was initiated.",
  bridgeUnknown: () =>
    "This saved signed hash does not establish broadcast or confirmation. Check its source status before approving another transfer.",
  recoveryNetworkMismatch: () =>
    "This recovery record belongs to another network or router deployment. Lookup and continuation are blocked. Reconnect to its original deployment.",
  recoveryExport: () => "Export recovery metadata",
  recoveryExportFailed: () =>
    "Recovery export failed. Your original checkpoint is unchanged. Retry or copy its transaction hash.",
  recoveryCompare: () => "Compare a recovery export",
  recoveryCompareHelp: () =>
    "Paste public recovery metadata to check every signed hash against Stellar Testnet. This read cannot sign, resubmit, or replace your saved transaction.",
  recoveryMetadata: () => "Recovery metadata",
  recoveryBothChecking: () => "Checking both records...",
  recoveryEvidenceCheck: () => "Check recovery evidence",
  recoveryCompareCancel: () => "Cancel comparison",
  recoveryUnresolvedAudit: () =>
    "At least one signed hash remains unresolved. Preserve both records and retry their reads.",
  recoveryTerminalAudit: () =>
    "Every source outcome was independently checked. The signed hashes remain separate; destination delivery is tracked separately.",
  recoveryAuditChecked: ({
    time,
    comparison,
  }: {
    readonly time: string;
    readonly comparison: string;
  }) => `Checked ${time}. Comparison: ${comparison}.`,
  recoveryAuditRecord: ({
    number,
    hash,
    status,
    source,
  }: {
    readonly number: string;
    readonly hash: string;
    readonly status: string;
    readonly source: string;
  }) => `Record ${number}: ${hash} (${status}, ${source}).`,
  recoveryAuditDownload: () => "Download public audit",
  recoveryAuditSaveFailed: () =>
    "The public audit could not be saved. Download this checked summary. Your pending checkpoint is unchanged.",
  recoveryCompareFailed: () => "Recovery comparison failed. Your pending checkpoint is unchanged.",
  recoveryChecking: () => "Checking Stellar Testnet transaction history...",
  recoveryCheckingAction: () => "Checking transaction...",
  recoveryContinue: () => "Check and continue",
  recoveryCheck: () => "Check status",
  recoveryStartAnother: () => "Start another transfer",
  recoveryExistingUSDC: () =>
    "Conversion confirmed. This step bridges the USDC already in your wallet.",
  recoveryOwner: ({ account }: { readonly account: string }) =>
    `This recoverable operation belongs to ${account}.`,
  recoveryReconnect: ({ account }: { readonly account: string }) =>
    `Reconnect ${account} to continue this transfer.`,
  conversionPreparationFailed: ({ reason }: { readonly reason: string }) =>
    `Conversion confirmed on Stellar; its USDC remains in your wallet. Fresh bridge preparation failed: ${reason}. No new bridge was submitted.`,
  conversionAttemptFailed: ({ reason }: { readonly reason: string }) =>
    `Conversion remains confirmed on Stellar. Fresh bridge attempt failed before submission: ${reason}. Its USDC remains in your wallet.`,
  amountLabel: ({ amount, unit }: AmountVariables) => `${amount} ${unit}`,
  requestedSourceLabel: () => "Requested source amount",
  sourceDebitLabel: () => "Actual source debit",
  protocolFeeLabel: () => "Protocol fee",
  bridgeAmountLabel: () => "Representable bridge amount",
  dustLabel: () => "Retained precision dust",
  circleEstimateLabel: () => "Circle forwarding estimate",
  axelarEstimateLabel: () => "Axelar gas estimate",
  circleBudgetLabel: () => "Approved Circle budget",
  axelarBudgetLabel: () => "Approved Axelar XLM",
  headroomLabel: () => "Integer headroom (rounded up)",
  forwardingLabel: () => "Full destination forwarding deduction",
  destinationMinimumLabel: () => "Conservative destination minimum",
  resourceFeeLabel: () => "Assembled resource fee",
  networkFeeLabel: () => "Stellar network fee",
  receivedMinimumLabel: () => "Minimum received",
  amountValid: () => "Amount is valid.",
  amountUnavailable: () => "Unavailable",
  reviewSend: () => "You send",
  reviewSendMaximum: () => "You send up to",
  reviewReceive: () => "You receive at least",
  confirmInWallet: () => "Confirm in wallet",
  simulationEstimating: () => "Estimating simulation...",
  approvalBlocked: () => "Approval blocked",
  amountPrompt: () => "Enter an amount to send.",
  amountPrecision: () => "Enter a positive amount with up to 7 decimal places.",
  amountPositive: () => "Enter an amount greater than zero.",
  amountLimit: () => "Amount exceeds Stellar's asset limit.",
  amountInvalid: () => "Enter a valid amount.",
  walletChanged: () => "Your wallet account changed. Review the transfer again.",
  reviewTransfer: () => "Review transfer",
  approveBridge: () => "Bridge converted USDC",
  stopWaiting: () => "Stop waiting",
} satisfies Record<string, (...args: never[]) => string>;

export type MessageKey = keyof typeof english;
export type MessageArguments<K extends MessageKey> = Parameters<(typeof english)[K]>;
export type TranslationCatalog = {
  readonly [K in MessageKey]?: (...args: MessageArguments<K>) => string;
};

export function formatMessage<K extends MessageKey>(
  translations: TranslationCatalog | undefined,
  key: K,
  ...args: MessageArguments<K>
): string {
  const fallback = english[key] as (...values: MessageArguments<K>) => string;
  const translation = translations?.[key] as
    ((...values: MessageArguments<K>) => string) | undefined;
  if (translation) {
    try {
      const value = translation(...args);
      if (typeof value === "string" && value.trim()) return value;
    } catch {
      // Missing or broken translations retain the complete English state message.
    }
  }
  return fallback(...args);
}

export function message<K extends MessageKey>(key: K, ...args: MessageArguments<K>): string {
  return formatMessage(undefined, key, ...args);
}

export type MessageFormatter = typeof message;

const phaseKeys = {
  preparing: "phasePreparing",
  signing: "phaseSigning",
  submitting: "phaseSubmitting",
  pending: "phasePending",
  confirmed: "phaseConfirmed",
} as const satisfies Record<TransactionPhase, MessageKey>;

export function phaseMessage(
  phase: TransactionPhase | null,
  translations?: TranslationCatalog,
): string {
  return formatMessage(translations, phaseKeys[phase ?? "preparing"]);
}

export function settlementPhaseMessage(
  phase: TransactionPhase,
  translations?: TranslationCatalog,
): string {
  const keys = {
    preparing: "settlementPreparing",
    signing: "settlementSigning",
    submitting: "settlementSubmitting",
    pending: "settlementPending",
    confirmed: "settlementConfirmed",
  } as const satisfies Record<TransactionPhase, MessageKey>;
  return formatMessage(translations, keys[phase]);
}

export function recoveryMessage(
  stage: "conversion" | "bridge",
  status: "confirmed" | "failed" | "unknown" | null,
  title = false,
  translations?: TranslationCatalog,
): string {
  if (title && status === "failed") return formatMessage(translations, "recoveryFailedTitle");
  const keys = {
    conversion: {
      confirmed: ["conversionConfirmed", "conversionConfirmedTitle"],
      failed: ["conversionFailed", "recoveryFailedTitle"],
      unknown: ["conversionUnknown", "conversionUnknownTitle"],
    },
    bridge: {
      confirmed: ["bridgeConfirmed", "bridgeConfirmedTitle"],
      failed: ["bridgeFailed", "recoveryFailedTitle"],
      unknown: ["bridgeUnknown", "bridgeUnknownTitle"],
    },
  } as const;
  return formatMessage(translations, keys[stage][status ?? "unknown"][title ? 1 : 0]);
}

export function amountLabel(
  raw: bigint,
  decimals: number,
  unit: string,
  translations?: TranslationCatalog,
): string {
  return formatMessage(translations, "amountLabel", { amount: formatUnits(raw, decimals), unit });
}
