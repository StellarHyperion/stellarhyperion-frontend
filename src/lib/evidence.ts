import { type FormattedTransfer } from "../api/backend";
import { getExplorerUrl } from "./format";

export type EvidenceStageKey = "source" | "provider" | "destination";
export type EvidenceStageStatus = "confirmed" | "candidate" | "verified" | "pending" | "unknown";

export interface EvidenceStage {
  readonly key: EvidenceStageKey;
  readonly label: string;
  readonly status: EvidenceStageStatus;
  readonly detail: string;
  readonly href?: string;
  readonly observedAt?: string | null;
}

function publicReference(reference: string | null | undefined): string | undefined {
  if (!reference) return undefined;
  try {
    const url = new URL(reference.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function hasVerifiedDestinationEvidence(transfer: FormattedTransfer): boolean {
  return transfer.destination.delivered && Boolean(transfer.destination.txHash?.trim());
}

export function getEvidenceTimeline(transfer: FormattedTransfer): readonly EvidenceStage[] {
  const sourceHash = transfer.origin.txHash.trim();
  const providerReference = transfer.rail?.reference?.trim() ?? null;
  const providerHref = publicReference(providerReference);
  const destinationHash = transfer.destination.txHash?.trim() ?? null;
  const destinationVerified = hasVerifiedDestinationEvidence(transfer);

  return [
    {
      key: "source",
      label: "Source transaction",
      status: sourceHash ? "confirmed" : "unknown",
      detail: sourceHash ? "Committed on the origin chain." : "Source confirmation is unknown.",
      ...(sourceHash ? { href: getExplorerUrl(transfer.origin.chain, "tx", sourceHash) } : {}),
      observedAt: transfer.origin.observedAt,
    },
    {
      key: "provider",
      label: "Provider candidate",
      status: providerReference ? "candidate" : "pending",
      detail: providerReference
        ? transfer.rail?.railStatus
          ? `Provider status: ${transfer.rail.railStatus}. This is not destination proof.`
          : "A provider reference exists; destination delivery is not proven by it."
        : "No provider candidate evidence has been recorded.",
      ...(providerHref ? { href: providerHref } : {}),
      observedAt: transfer.rail?.attestedAt ?? null,
    },
    {
      key: "destination",
      label: "Destination payment",
      status: destinationVerified
        ? "verified"
        : transfer.destination.delivered
          ? "unknown"
          : destinationHash
            ? "unknown"
            : "pending",
      detail: destinationVerified
        ? "Independently verified on the destination chain."
        : destinationHash
          ? "A destination transaction exists, but delivery is not independently verified."
          : "Waiting for an independently verified destination payment.",
      ...(destinationHash
        ? { href: getExplorerUrl(transfer.destination.chain, "tx", destinationHash) }
        : {}),
      observedAt: transfer.destination.deliveredAt,
    },
  ];
}

export function getEvidenceAwareStage(transfer: FormattedTransfer): string {
  const destination = getEvidenceTimeline(transfer)[2];
  if (destination?.status === "verified") return transfer.stage;
  if (transfer.stage === "failed" || transfer.stage === "parked") return transfer.stage;
  return "destination pending";
}
