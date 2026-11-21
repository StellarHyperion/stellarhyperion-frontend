import type { FormattedTransfer } from "../api/backend";
import type { TransactionResult } from "../contracts/stellar";

export type DeliveryProofState = "unresolved" | "delivered" | "failed";

export function deliveryProofState(
  record: FormattedTransfer | null,
  origin: TransactionResult | null,
): DeliveryProofState {
  if (record?.stage === "failed" || origin?.status === "failed") return "failed";
  if (
    record?.stage === "delivered" &&
    record.destination.delivered &&
    !!record.destination.txHash &&
    !!record.destination.amount &&
    record.destination.decimals !== null &&
    record.destination.decimals !== undefined
  )
    return "delivered";
  return "unresolved";
}
