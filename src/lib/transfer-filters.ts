import { StrKey } from "@stellar/stellar-sdk";
import type { FormattedTransfer, TransferFilters } from "../api/backend";

function canonicalIdentity(value: string, kind: "asset" | "deployment"): string | null {
  const identity = value.trim();
  if (!identity) return "";
  if (/^0x[0-9a-f]{40}$/i.test(identity)) return identity.toLowerCase();
  if (kind === "deployment" && /^[0-9a-f]{64}$/i.test(identity)) return identity.toLowerCase();
  if (StrKey.isValidContract(identity)) return identity;
  if (kind === "asset" && StrKey.isValidEd25519PublicKey(identity)) return identity;
  const issuer = identity.split(":");
  if (
    kind === "asset" &&
    issuer.length === 2 &&
    /^[A-Za-z0-9]{1,12}$/.test(issuer[0] ?? "") &&
    StrKey.isValidEd25519PublicKey(issuer[1] ?? "")
  )
    return identity;
  return null;
}

export function validateTransferFilters(input: TransferFilters): {
  filters: TransferFilters;
  error: string | null;
} {
  const asset = canonicalIdentity(input.asset ?? "", "asset");
  const deployment = canonicalIdentity(input.deployment ?? "", "deployment");
  if (asset === null)
    return {
      filters: {},
      error:
        "Enter an exact token address, Stellar contract or issuer identity. A symbol alone cannot identify an asset.",
    };
  if (deployment === null)
    return {
      filters: {},
      error: "Enter an exact router address or 64-character deployment revision hash.",
    };
  return { filters: { asset, deployment }, error: null };
}

export function readTransferFilters(search: string): {
  filters: TransferFilters;
  error: string | null;
} {
  const params = new URLSearchParams(search);
  if (params.getAll("asset").length > 1 || params.getAll("deployment").length > 1)
    return {
      filters: {},
      error:
        "Each identity filter must appear only once in the URL. Clear the filters to continue.",
    };
  return validateTransferFilters({
    asset: params.get("asset") ?? "",
    deployment: params.get("deployment") ?? "",
  });
}

export function filterSupportError(
  transfers: readonly FormattedTransfer[],
  filters: TransferFilters,
): string | null {
  if (
    filters.deployment &&
    transfers.some((transfer) => !transfer.origin.router || !transfer.origin.revision)
  )
    return "Deployment filtering is unavailable for this page because the indexer omitted source router or revision metadata. Clear the filter or check the source proofs.";
  return null;
}

export function transferRowIdentity(transfer: FormattedTransfer): string {
  return JSON.stringify([
    transfer.origin.chain,
    transfer.origin.router ?? null,
    transfer.origin.revision ?? null,
    transfer.origin.token,
    transfer.origin.nonce,
    transfer.origin.txHash,
    transfer.id,
  ]);
}
