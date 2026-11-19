import { describe, expect, it } from "vitest";
import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const passphrase = "Test SDF Network ; September 2015";
const source = Keypair.random().publicKey();
const recipient = Keypair.random().publicKey();

function envelope(destination: string, amount: string) {
  return new TransactionBuilder(new Account(source, "1"), {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount }))
    .setTimeout(60)
    .build();
}

describe("independent transaction intent checks", () => {
  it("detects altered recipient and amount without reusing production comparison code", () => {
    const reviewed = envelope(recipient, "1");
    const altered = envelope(recipient, "2");
    const reviewedOperation = reviewed.toXDR();
    const alteredOperation = altered.toXDR();
    expect(alteredOperation).not.toBe(reviewedOperation);
    expect(envelope(Keypair.random().publicKey(), "1").toXDR()).not.toBe(reviewedOperation);
  });
});
