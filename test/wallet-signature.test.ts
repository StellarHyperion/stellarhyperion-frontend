import { describe, expect, it } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  assertSigningAuthorized,
  assertWalletApproval,
  verifyWalletSignature,
  WalletSigningError,
} from "../src/wallets/stellar/signature";

const signer = Keypair.random();
function transaction(
  amount = "1",
  networkPassphrase = Networks.TESTNET,
  destination = Keypair.random().publicKey(),
) {
  return new TransactionBuilder(new Account(signer.publicKey(), "0"), {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination,
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
  it("keeps generated exact amounts in the signed intent without one-stroop tolerance", () => {
    let state = 0x159c0de;
    const amounts = [
      9007199254740993n,
      ...Array.from({ length: 24 }, () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return BigInt(state) * 100000000n + BigInt(state % 100000000) + 1n;
      }),
    ];
    const decimalOracle = (units: bigint): string => {
      const whole = units / 10000000n;
      const fraction = (units % 10000000n).toString().padStart(7, "0").replace(/0+$/, "");
      return fraction ? `${whole}.${fraction}` : whole.toString();
    };

    for (const units of amounts) {
      const destination = Keypair.random().publicKey();
      const amount = decimalOracle(units);
      const originalTx = transaction(amount, Networks.TESTNET, destination);
      const original = originalTx.toXdr();
      originalTx.sign(signer);
      expect(verifyWalletSignature(original, originalTx.toXdr(), signer.publicKey())).toBe(
        originalTx.toXdr(),
      );

      const alteredTx = transaction(decimalOracle(units + 1n), Networks.TESTNET, destination);
      alteredTx.sign(signer);
      expect(() =>
        verifyWalletSignature(original, alteredTx.toXdr(), signer.publicKey()),
      ).toThrow("changed the transaction");
    }
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
  it("rejects a fee-bump envelope as the returned XDR with 'unsupported'", () => {
    const tx = transaction();
    const original = tx.toXdr();
    tx.sign(signer);
    const feeSource = Keypair.random();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      "200",
      tx,
      Networks.TESTNET,
    );
    feeBump.sign(feeSource);
    expect(() => verifyWalletSignature(original, feeBump.toXdr(), signer.publicKey())).toThrow(
      "unsupported",
    );
  });
  it("rejects a fee-bump envelope as the original XDR with 'unsupported'", () => {
    const tx = transaction();
    tx.sign(signer);
    const feeSource = Keypair.random();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      "200",
      tx,
      Networks.TESTNET,
    );
    feeBump.sign(feeSource);
    expect(() => verifyWalletSignature(feeBump.toXdr(), tx.toXdr(), signer.publicKey())).toThrow(
      "unsupported",
    );
  });
  it("rejects garbage, empty, and truncated XDR with 'unreadable'", () => {
    const tx = transaction();
    const original = tx.toXdr();
    tx.sign(signer);
    const signed = tx.toXdr();
    expect(() =>
      verifyWalletSignature(original, "not-valid-xdr-at-all", signer.publicKey()),
    ).toThrow("unreadable");
    expect(() => verifyWalletSignature(original, "", signer.publicKey())).toThrow("unreadable");
    expect(() => verifyWalletSignature(original, signed.slice(0, 20), signer.publicKey())).toThrow(
      "unreadable",
    );
    expect(() => verifyWalletSignature("not-valid-xdr-at-all", signed, signer.publicKey())).toThrow(
      "unreadable",
    );
    expect(() => verifyWalletSignature("", signed, signer.publicKey())).toThrow("unreadable");
    expect(() => verifyWalletSignature(original.slice(0, 20), signed, signer.publicKey())).toThrow(
      "unreadable",
    );
  });

  describe("Read-only signing guard and reconciliation checks", () => {
    it("never permits signing for typed read-only accounts", () => {
      const typedKey = Keypair.random().publicKey();

      expect(() => {
        assertSigningAuthorized({
          account: typedKey,
          walletId: null,
          isReadOnly: true,
        });
      }).toThrow(WalletSigningError);

      try {
        assertSigningAuthorized({
          account: typedKey,
          walletId: null,
          isReadOnly: true,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(WalletSigningError);
        expect((err as WalletSigningError).code).toBe("READ_ONLY_MODE");
      }

      expect(() => {
        assertSigningAuthorized({
          account: typedKey,
          walletId: "freighter",
          isReadOnly: true,
        });
      }).toThrow("A typed public address cannot sign transactions. Connect a Stellar wallet.");

      expect(() => {
        assertWalletApproval(
          {
            account: signer.publicKey(),
            network: Networks.TESTNET,
            operation: "bridge",
          },
          signer.publicKey(),
          { isReadOnly: true, walletId: "freighter" },
        );
      }).toThrow("A typed public address cannot sign transactions. Connect a Stellar wallet.");
    });

    it("requires explicit reconciliation when connected wallet differs from viewed address", () => {
      const connectedKey = signer.publicKey();
      const viewedKey = Keypair.random().publicKey();

      expect(() => {
        assertSigningAuthorized({
          account: viewedKey,
          walletId: "freighter",
          isReadOnly: false,
          connectedAccount: connectedKey,
          viewedAddress: viewedKey,
        });
      }).toThrow(WalletSigningError);

      try {
        assertSigningAuthorized({
          account: viewedKey,
          walletId: "freighter",
          isReadOnly: false,
          connectedAccount: connectedKey,
          viewedAddress: viewedKey,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(WalletSigningError);
        expect((err as WalletSigningError).code).toBe("ACCOUNT_MISMATCH");
      }

      expect(() => {
        assertSigningAuthorized({
          account: connectedKey,
          walletId: "freighter",
          isReadOnly: false,
          connectedAccount: connectedKey,
          viewedAddress: connectedKey,
        });
      }).not.toThrow();
    });
  });

  it("rejects a signature from a stale, overlapping session whose sequence has moved on", () => {
    // Session A prepares and signs a transaction while session B, overlapping it, prepares a
    // fresh transaction for the same account after its sequence number has already advanced. A
    // wallet that mixes the two up must never have the stale signature accepted as current.
    const stale = transaction();
    const staleUnsigned = stale.toXdr();
    stale.sign(signer);
    const current = new TransactionBuilder(new Account(signer.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      )
      .setTimeout(60)
      .build();
    expect(() => verifyWalletSignature(current.toXdr(), stale.toXdr(), signer.publicKey())).toThrow(
      "changed the transaction",
    );
    // The stale envelope is only ever valid against the session that actually requested it.
    expect(verifyWalletSignature(staleUnsigned, stale.toXdr(), signer.publicKey())).toBe(
      stale.toXdr(),
    );
  });
});
