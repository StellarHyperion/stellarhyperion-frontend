import { FeeBumpTransaction, Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { TESTNET } from "../../config/testnet";
import type { WalletApprovalProvenance } from "./types";

export function assertWalletApproval(approval: WalletApprovalProvenance, account: string): void {
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
  let requested: Transaction | FeeBumpTransaction;
  let result: Transaction | FeeBumpTransaction;
  try {
    requested = TransactionBuilder.fromXdr(original, TESTNET.networkPassphrase);
  } catch {
    throw new Error("The transaction to sign is unreadable.");
  }
  try {
    result = TransactionBuilder.fromXdr(signed, TESTNET.networkPassphrase);
  } catch {
    throw new Error("The wallet returned an unreadable transaction envelope.");
  }
  if (requested instanceof FeeBumpTransaction || result instanceof FeeBumpTransaction)
    throw new Error(
      "The wallet returned an unsupported fee-bump envelope. Hyperion signs standard transactions only.",
    );
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
