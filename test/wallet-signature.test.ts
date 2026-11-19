import { describe, expect, it } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { assertWalletApproval, verifyWalletSignature } from "../src/wallets/stellar/signature";

const signer = Keypair.random();
function transaction(amount = "1", networkPassphrase = Networks.TESTNET) {
  return new TransactionBuilder(new Account(signer.publicKey(), "0"), {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount,
      }),
    )
    .setTimeout(60)
    .build();
}

describe("Wallet signature verification", () => {
  it("accepts provenance for the exact connected account and Testnet", () => {
    expect(() => {
      assertWalletApproval(
        {
          account: signer.publicKey(),
          network: Networks.TESTNET,
          operation: "bridge",
        },
        signer.publicKey(),
      );
    }).not.toThrow();
  });
  it("rejects provenance when the account or network changed", () => {
    expect(() => {
      assertWalletApproval(
        {
          account: Keypair.random().publicKey(),
          network: Networks.TESTNET,
          operation: "conversion",
        },
        signer.publicKey(),
      );
    }).toThrow("account changed");
    expect(() => {
      assertWalletApproval(
        {
          account: signer.publicKey(),
          network: Networks.PUBLIC,
          operation: "claim-settlement",
        },
        signer.publicKey(),
      );
    }).toThrow("different Stellar network");
  });
  it("rejects an unsupported approval operation", () => {
    expect(() => {
      assertWalletApproval(
        {
          account: signer.publicKey(),
          network: Networks.TESTNET,
          operation: "unexpected" as never,
        },
        signer.publicKey(),
      );
    }).toThrow("unsupported");
  });
  it("accepts the actual connected account's signature on the exact Testnet transaction", () => {
    const tx = transaction();
    const original = tx.toXdr();
    tx.sign(signer);
    expect(verifyWalletSignature(original, tx.toXdr(), signer.publicKey())).toBe(tx.toXdr());
  });
  it("rejects a signature made for the public network even when the transaction body matches", () => {
    const tx = transaction();
    const original = tx.toXdr();
    const wrongNetwork = TransactionBuilder.fromXdr(original, Networks.PUBLIC);
    wrongNetwork.sign(signer);
    expect(() => verifyWalletSignature(original, wrongNetwork.toXdr(), signer.publicKey())).toThrow(
      "Stellar Testnet",
    );
  });
  it("rejects a wallet switching the signer account", () => {
    const tx = transaction();
    const original = tx.toXdr();
    tx.sign(Keypair.random());
    expect(() => verifyWalletSignature(original, tx.toXdr(), signer.publicKey())).toThrow(
      "connected account",
    );
  });
  it("rejects wallet changes to transaction operations", () => {
    const original = transaction().toXdr();
    const changed = transaction("2");
    changed.sign(signer);
    expect(() => verifyWalletSignature(original, changed.toXdr(), signer.publicKey())).toThrow(
      "changed the transaction",
    );
  });
  it("rejects a returned envelope with no signature", () => {
    const original = transaction().toXdr();
    expect(() => verifyWalletSignature(original, original, signer.publicKey())).toThrow(
      "did not sign",
    );
  });
});
