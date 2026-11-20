import type { FormattedTransfer } from "../api/backend";
import { publicIdentifier } from "./evidence";

export const PROOF_CHECKS = {
  commandIdentityMatched: "Command identity matches this source transfer.",
  successfulDestinationReceipt: "The destination execution receipt succeeded.",
  receiptCanonical: "The stored receipt belongs to the canonical block.",
  tokenManagerScopedToProofBlock: "The token manager mapping is scoped to the proof block.",
  exactErc20PaymentMatched: "The exact token payment matches the recorded recipient and amount.",
} as const;
export type ProofCheck = keyof typeof PROOF_CHECKS;
export interface TransferProof {
  readonly status: "verified" | "candidate" | "unavailable" | "not_applicable";
  readonly checks: Readonly<Record<ProofCheck, boolean>>;
  readonly commandId: string | null;
  readonly executionHash: string | null;
  readonly receiptBlock: string | null;
  readonly receiptBlockHash: string | null;
  readonly mappingBlock: string | null;
  readonly mappingBlockHash: string | null;
  readonly token: string | null;
  readonly recipient: string | null;
  readonly amount: string | null;
  readonly revalidatedAt: string | null;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function integer(value: unknown): string | null {
  return typeof value === "string" && value.length <= 78 && /^(0|[1-9][0-9]*)$/.test(value)
    ? value
    : null;
}
function address(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value : null;
}
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 24) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}

/** Project the implemented evidence API onto public proof fields; never retain provider payloads. */
export function parseTransferProof(value: unknown, transfer: FormattedTransfer): TransferProof {
  const entry = record(value);
  if (entry.transferId !== transfer.id)
    throw new Error("Proof evidence does not match this transfer.");
  const command = record(entry.command);
  const receipt = record(entry.destinationReceipt);
  const mapping = record(entry.tokenManagerMapping);
  const payment = record(entry.tokenPayment);
  const checklist = record(entry.verificationChecklist);
  const checks = Object.fromEntries(
    Object.keys(PROOF_CHECKS).map((key) => [key, record(checklist[key]).passed === true]),
  ) as Record<ProofCheck, boolean>;
  const commandId = publicIdentifier(command.id);
  const executionHash = publicIdentifier(command.executionTransaction);
  const receiptHash = publicIdentifier(receipt.transactionHash);
  const receiptBlock = integer(receipt.blockNumber);
  const receiptBlockHash = publicIdentifier(receipt.blockHash);
  const mappingBlock = integer(mapping.proofBlockNumber);
  const mappingBlockHash = publicIdentifier(mapping.proofBlockHash);
  const token = address(payment.token);
  const recipient = address(payment.recipient);
  const amount = integer(payment.amount);
  const equalHash = (a: string | null, b: string | null | undefined) =>
    a !== null && a.toLowerCase() === b?.toLowerCase();
  const independentlyMatched =
    entry.evidenceStatus === "canonical" &&
    entry.providerExecutionSufficient === false &&
    Object.values(checks).every(Boolean) &&
    commandId !== null &&
    executionHash !== null &&
    equalHash(executionHash, receiptHash) &&
    equalHash(executionHash, transfer.destination.txHash) &&
    receiptBlock !== null &&
    receiptBlock === transfer.destination.block &&
    receiptBlockHash !== null &&
    mappingBlock !== null &&
    mappingBlockHash !== null &&
    receipt.canonical === true &&
    receipt.status === "success" &&
    mapping.verified === true &&
    mapping.destinationChain === transfer.destination.chain &&
    token !== null &&
    equalHash(token, transfer.destination.token) &&
    recipient !== null &&
    equalHash(recipient, transfer.destination.recipient) &&
    amount !== null &&
    amount === transfer.destination.amount &&
    BigInt(amount) > 0n &&
    payment.exactMatch === true &&
    equalHash(publicIdentifier(payment.transactionHash), executionHash) &&
    transfer.destination.delivered;
  return {
    status: independentlyMatched
      ? "verified"
      : entry.evidenceStatus === "not_applicable"
        ? "not_applicable"
        : entry.evidenceStatus === "unavailable"
          ? "unavailable"
          : "candidate",
    checks,
    commandId,
    executionHash,
    receiptBlock,
    receiptBlockHash,
    mappingBlock,
    mappingBlockHash,
    token,
    recipient,
    amount,
    revalidatedAt: timestamp(receipt.lastRevalidatedAt),
  };
}
