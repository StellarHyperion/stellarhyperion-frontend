import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { TESTNET } from "../../config/testnet";
import type { WalletApprovalProvenance } from "./types";

export type WalletSigningErrorCode = "READ_ONLY_MODE" | "ACCOUNT_MISMATCH";

export class WalletSigningError extends Error {
  readonly code: WalletSigningErrorCode;

  constructor(code: WalletSigningErrorCode, message: string) {
    super(message);
    this.name = "WalletSigningError";
    this.code = code;
    Object.setPrototypeOf(this, WalletSigningError.prototype);
  }
}

export interface SigningAuthorizationCheck {
  account?: string | undefined;
  walletId?: string | null | undefined;
  isReadOnly?: boolean | undefined;
  connectedAccount?: string | null | undefined;
  viewedAddress?: string | null | undefined;
}

export function assertSigningAuthorized(options: SigningAuthorizationCheck): void {
  if (options.isReadOnly || !options.walletId) {
    throw new WalletSigningError(
      "READ_ONLY_MODE",
      "A typed public address cannot sign transactions. Connect a Stellar wallet.",
    );
  }
  if (
    options.connectedAccount &&
    options.viewedAddress &&
    options.connectedAccount !== options.viewedAddress
  ) {
    throw new WalletSigningError(
      "ACCOUNT_MISMATCH",
      "Connected wallet differs from viewed address. Reconcile mode before signing.",
    );
  }
}

export function assertWalletApproval(
  approval: WalletApprovalProvenance,
  account: string,
  options?: SigningAuthorizationCheck,
): void {
  if (options) {
    assertSigningAuthorized(options);
  }
  if (!(["conversion", "bridge", "claim-settlement"] as const).includes(approval.operation))
    throw new Error("The approval operation is unsupported. Review the transaction again.");
  if (approval.account !== account)
    throw new Error("The wallet account changed. Review the transaction again.");
  if (approval.network !== TESTNET.networkPassphrase)
    throw new Error(
      "The approval is for a different Stellar network. Review the transaction again.",
    );
}

export function verifyWalletSignature(original: string, signed: string, account: string): string {
  const requested = TransactionBuilder.fromXdr(original, TESTNET.networkPassphrase);
  const result = TransactionBuilder.fromXdr(signed, TESTNET.networkPassphrase);
  if (!(requested instanceof Transaction) || !(result instanceof Transaction))
    throw new Error("The wallet returned an unsupported transaction envelope.");
  const requestedHash = requested.hash();
  const resultHash = result.hash();
  if (
    requestedHash.length !== resultHash.length ||
    !requestedHash.every((byte, index) => byte === resultHash[index])
  )
    throw new Error("The wallet changed the transaction. Review the transfer again.");
  const key = Keypair.fromPublicKey(account);
  if (!result.signatures.some((signature) => key.verify(resultHash, signature.signature)))
    throw new Error("The wallet did not sign with the connected account on Stellar Testnet.");
  return signed;
}
