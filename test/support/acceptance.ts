import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { decodeEventLog, parseAbi, type TransactionReceipt } from "viem";
import type { FormattedTransfer } from "../../src/api/backend";
import { TESTNET } from "../../src/config/testnet";

export interface AcceptedIntent {
  sourceHash: string;
  sender: string;
  sourceToken: string;
  grossAmount: string;
  fee: string;
  destination: string;
  recipient: string;
  destinationToken: string;
  destinationAmount: string;
  route: number;
}

function exact(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error("Acceptance amounts must be exact integer strings.");
  return BigInt(value);
}

/** Public indexer evidence must match the saved, explicitly approved transfer. */
export function assertIndexedAcceptance(
  transfer: FormattedTransfer | null,
  intent: AcceptedIntent,
): asserts transfer is FormattedTransfer {
  if (!transfer) throw new Error("The signed source transaction is not indexed yet.");
  if (!/^[0-9a-f]{64}$/i.test(intent.sourceHash) || transfer.origin.txHash !== intent.sourceHash)
    throw new Error("The indexed origin hash does not match the real signed source transaction.");
  if (!transfer.destination.delivered || !transfer.destination.txHash)
    throw new Error("Source confirmation alone cannot satisfy cross-chain acceptance.");
  if (!/^0x[0-9a-f]{64}$/i.test(transfer.destination.txHash))
    throw new Error("Destination evidence has no valid transaction hash.");
  const gross = exact(transfer.origin.grossAmount),
    fee = exact(transfer.origin.fee);
  const net = exact(transfer.origin.netAmount),
    amount = exact(transfer.destination.amount);
  if (gross <= 0n || fee > gross || net !== gross - fee || amount <= 0n)
    throw new Error("Acceptance amounts are inconsistent or nonpositive.");
  if (
    gross !== exact(intent.grossAmount) ||
    fee !== exact(intent.fee) ||
    amount !== exact(intent.destinationAmount)
  )
    throw new Error("Acceptance amounts do not match the reviewed transfer.");
  if (
    transfer.origin.chain !== "stellar-testnet" ||
    transfer.origin.sender !== intent.sender ||
    transfer.origin.token !== intent.sourceToken ||
    transfer.route !== intent.route ||
    transfer.destination.chain !== intent.destination ||
    transfer.destination.recipient.toLowerCase() !== intent.recipient.toLowerCase() ||
    transfer.destination.token?.toLowerCase() !== intent.destinationToken.toLowerCase()
  )
    throw new Error(
      "Acceptance chain, recipient or issuer-specific token identity does not match.",
    );
}

/** A successful unrelated receipt or a balance increase is insufficient payment evidence. */
export function assertPaymentReceipt(
  receipt: Pick<TransactionReceipt, "status" | "transactionHash" | "blockNumber" | "logs">,
  transfer: FormattedTransfer,
  intent: AcceptedIntent,
): void {
  if (
    receipt.status !== "success" ||
    receipt.transactionHash.toLowerCase() !== transfer.destination.txHash?.toLowerCase() ||
    receipt.blockNumber !== exact(transfer.destination.block)
  )
    throw new Error("Destination receipt does not match the independently indexed payment.");
  let paid = 0n;
  for (const log of receipt.logs) {
    if (log.removed || log.address.toLowerCase() !== intent.destinationToken.toLowerCase())
      continue;
    try {
      const event = decodeEventLog({
        abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]),
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (event.args.to.toLowerCase() === intent.recipient.toLowerCase()) paid += event.args.value;
    } catch {
      /* Unrelated events are not payment evidence. */
    }
  }
  if (paid !== exact(intent.destinationAmount))
    throw new Error(
      "Destination receipt does not prove the exact token payment to this recipient.",
    );
}

/** The saved public envelope proves signing and binds the hash before any broadcast. */
export function assertSignedSource(envelope: string, sender: string, hash: string): void {
  const tx = TransactionBuilder.fromXdr(envelope, TESTNET.networkPassphrase);
  if (
    "innerTransaction" in tx ||
    tx.source !== sender ||
    Buffer.from(tx.hash()).toString("hex") !== hash ||
    !tx.signatures.some((signature) =>
      Keypair.fromPublicKey(sender).verify(tx.hash(), signature.signature),
    )
  )
    throw new Error("The saved source envelope has no matching account signature and hash.");
}
