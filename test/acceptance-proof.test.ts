import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type TransactionReceipt } from "viem";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FormattedTransfer } from "../src/api/backend";
import { TESTNET } from "../src/config/testnet";
import {
  assertIndexedAcceptance,
  assertPaymentReceipt,
  assertSignedSource,
} from "./support/acceptance";
import { lockProof, readProof, saveProof } from "./support/proof-file";

const signer = Keypair.random();
const intent = {
  sourceHash: "a".repeat(64),
  sender: signer.publicKey(),
  sourceToken: TESTNET.token,
  grossAmount: "10000000",
  fee: "30000",
  destination: "sepolia",
  recipient: `0x${"1".repeat(40)}`,
  destinationToken: `0x${"2".repeat(40)}`,
  destinationAmount: "9970000",
  route: 1,
};
const transfer: FormattedTransfer = {
  id: "1",
  stage: "delivered",
  route: 1,
  origin: {
    chain: "stellar-testnet",
    nonce: "1",
    sender: intent.sender,
    token: intent.sourceToken,
    grossAmount: intent.grossAmount,
    fee: intent.fee,
    netAmount: "9970000",
    block: "123",
    txHash: intent.sourceHash,
    observedAt: "2026-11-19T00:00:00Z",
  },
  destination: {
    chain: "sepolia",
    recipient: intent.recipient,
    token: intent.destinationToken,
    amount: intent.destinationAmount,
    delivered: true,
    txHash: `0x${"b".repeat(64)}`,
    block: "456",
    deliveredAt: "2026-11-19T00:01:00Z",
  },
  rail: null,
  claim: null,
};
const receipt = {
  status: "success",
  transactionHash: transfer.destination.txHash,
  blockNumber: 456n,
  logs: [
    {
      address: intent.destinationToken,
      data: encodeAbiParameters([{ type: "uint256" }], [9970000n]),
      topics: encodeEventTopics({
        abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]),
        eventName: "Transfer",
        args: { from: `0x${"3".repeat(40)}`, to: intent.recipient as `0x${string}` },
      }),
      removed: false,
    },
  ],
} as Pick<TransactionReceipt, "status" | "transactionHash" | "blockNumber" | "logs">;

describe("Independent public acceptance evidence", () => {
  it("requires exact indexed intent and a matching token payment log", () => {
    assertIndexedAcceptance(transfer, intent);
    assertPaymentReceipt(receipt, transfer, intent);
  });
  it.each([null, "1.1", "1e7", 9970000, "", "09970000"])(
    "refuses missing/inexact destination amount %s",
    (amount) => {
      expect(() => {
        assertIndexedAcceptance(
          { ...transfer, destination: { ...transfer.destination, amount: amount as string } },
          intent,
        );
      }).toThrow("exact integer");
    },
  );
  it("refuses source-only completion even with a provider reference", () => {
    expect(() => {
      assertIndexedAcceptance(
        {
          ...transfer,
          destination: { ...transfer.destination, delivered: false, txHash: null },
          rail: {
            status: "complete",
            railStatus: "complete",
            reference: "https://provider.example/accepted",
            attestedAt: null,
            lastError: null,
          },
        },
        intent,
      );
    }).toThrow("Source confirmation alone");
  });
  it.each([
    { token: `0x${"4".repeat(40)}` },
    { recipient: `0x${"5".repeat(40)}` },
    { chain: "base-sepolia" },
    { amount: "9970001" },
    { txHash: "fake" },
  ])("refuses mismatched destination evidence %j", (change) => {
    expect(() => {
      assertIndexedAcceptance(
        { ...transfer, destination: { ...transfer.destination, ...change } },
        intent,
      );
    }).toThrow();
  });
  it("refuses inconsistent source arithmetic and an unrelated source hash", () => {
    expect(() => {
      assertIndexedAcceptance(
        { ...transfer, origin: { ...transfer.origin, netAmount: "1" } },
        intent,
      );
    }).toThrow("inconsistent");
    expect(() => {
      assertIndexedAcceptance(
        { ...transfer, origin: { ...transfer.origin, txHash: "f".repeat(64) } },
        intent,
      );
    }).toThrow("hash");
  });
  it.each([
    { status: "reverted" },
    { transactionHash: `0x${"c".repeat(64)}` },
    { blockNumber: 457n },
    { logs: [] },
  ])("refuses unrelated successful receipts or absent payments %s", (change) => {
    expect(() => {
      assertPaymentReceipt({ ...receipt, ...change } as typeof receipt, transfer, intent);
    }).toThrow();
  });
  it("refuses wrong token and wrong payment amounts despite receipt success", () => {
    const log = receipt.logs[0];
    if (!log) throw Error("Missing fixture log");
    expect(() => {
      assertPaymentReceipt(
        { ...receipt, logs: [{ ...log, address: `0x${"4".repeat(40)}` }] },
        transfer,
        intent,
      );
    }).toThrow("exact token payment");
    expect(() => {
      assertPaymentReceipt(
        { ...receipt, logs: [{ ...log, data: encodeAbiParameters([{ type: "uint256" }], [1n]) }] },
        transfer,
        intent,
      );
    }).toThrow("exact token payment");
  });
  it("requires an actual account signature over the recorded source hash", () => {
    const tx = new TransactionBuilder(new Account(signer.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: TESTNET.networkPassphrase,
    })
      .addOperation(
        Operation.payment({ destination: signer.publicKey(), asset: Asset.native(), amount: "1" }),
      )
      .setTimeout(60)
      .build();
    const hash = Buffer.from(tx.hash()).toString("hex");
    expect(() => {
      assertSignedSource(tx.toXdr(), signer.publicKey(), hash);
    }).toThrow("signature");
    tx.sign(signer);
    assertSignedSource(tx.toXdr(), signer.publicKey(), hash);
    expect(() => {
      assertSignedSource(tx.toXdr(), signer.publicKey(), "f".repeat(64));
    }).toThrow("hash");
    expect(() => {
      assertSignedSource(tx.toXdr(), Keypair.random().publicKey(), hash);
    }).toThrow("signature");
  });
});

describe("Interrupted and concurrent live proof recovery", () => {
  it("rejects symlinks and public-readable proof records before loading their content", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperion-proof-safety-"));
    const file = join(dir, "proof.json");
    const link = join(dir, "link.json");
    try {
      expect(readProof(file)).toBeNull();
      saveProof(file, { sourceHash: intent.sourceHash });
      symlinkSync(file, link);
      expect(() => readProof(link)).toThrow("safely");
      chmodSync(file, 0o644);
      expect(() => readProof(file)).toThrow("private regular file");
      expect(() => {
        saveProof(file, { sourceHash: intent.sourceHash });
      }).toThrow("private regular file");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("keeps public hashes after failed replacement and refuses dropping a pending hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperion-proof-test-")),
      file = join(dir, "proof.json"),
      proof = { sourceHash: intent.sourceHash, status: "signed" };
    try {
      saveProof(file, proof);
      expect(() => {
        saveProof(file, { ...proof, status: "confirmed" }, () => {
          throw Error("simulated interruption");
        });
      }).toThrow("interruption");
      expect(readProof(file)).toEqual(proof);
      expect(() => {
        saveProof(file, { status: "preparing" });
      }).toThrow("Never overwrite");
      expect(statSync(file).mode & 0o077).toBe(0);
      saveProof(file, { ...proof, status: "source-confirmed" });
      expect(readProof(file)?.sourceHash).toBe(intent.sourceHash);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it("allows only one live runner to own a proof and never clears its public hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperion-proof-lock-")),
      file = join(dir, "proof.json");
    try {
      saveProof(file, { sourceHash: intent.sourceHash });
      const release = lockProof(file);
      expect(() => lockProof(file)).toThrow("another live runner");
      release();
      const retry = lockProof(file);
      retry();
      expect(readProof(file)?.sourceHash).toBe(intent.sourceHash);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
