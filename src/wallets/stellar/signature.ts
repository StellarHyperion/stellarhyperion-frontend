import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { TESTNET } from "../../config/testnet";

// Re-exported here, next to the signature check it governs, so a reader of this file sees the
// conservative-timeout type that applies to a signing response. Defined in "./timeout" (not here)
// so that importing it never pulls in this file's "@stellar/stellar-sdk" dependency: sdk.ts needs
// the error type at module load, but must keep loading the Stellar SDK itself fully lazy.
export { WalletSigningUncertainError } from "./timeout";

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
