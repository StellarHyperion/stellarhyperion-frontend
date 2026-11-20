import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { createPublicClient, http, parseAbi } from "viem";
import { fetchTransferByTx } from "../src/api/backend";
import {
  parseSendAmount,
  quoteTransfer,
  readBalance,
  readLane,
  readTransaction,
  submitBridgeOut,
  validateRecipient,
} from "../src/contracts/stellar";
import { TESTNET } from "../src/config/testnet";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import {
  assertIndexedAcceptance,
  assertPaymentReceipt,
  assertSignedSource,
} from "./support/acceptance";
import { defaultProofFile, lockProof, readProof, saveProof } from "./support/proof-file";

interface Proof {
  network: "stellar-testnet";
  router: string;
  sender: string;
  recipient: string;
  grossAmount: string;
  fee?: string;
  destinationAmount?: string;
  balanceBefore?: string;
  recipientBalanceBefore?: string;
  sourceHash?: string;
  sourceEnvelope?: string;
  destinationHash?: string;
  status: string;
}

function isProof(value: Record<string, unknown>): value is Record<string, unknown> & Proof {
  return (
    value.network === "stellar-testnet" &&
    ["router", "sender", "recipient", "grossAmount", "status"].every(
      (field) =>
        typeof value[field] === "string" && value[field].length > 0 && value[field].length <= 2048,
    ) &&
    [
      "fee",
      "destinationAmount",
      "balanceBefore",
      "recipientBalanceBefore",
      "sourceHash",
      "sourceEnvelope",
      "destinationHash",
    ].every(
      (field) =>
        value[field] === undefined ||
        (typeof value[field] === "string" &&
          value[field].length <= (field === "sourceEnvelope" ? 200000 : 2048)),
    )
  );
}

// Explicit opt-in only: this test signs and spends 0.1 testnet USDC plus testnet XLM fees.
const enabled = process.env.HYPERION_LIVE_TESTNET === "1";
it.skipIf(!enabled)(
  "signs a real Stellar transfer and verifies indexed Sepolia token delivery",
  async () => {
    const identity = process.env.HYPERION_TESTNET_IDENTITY;
    const recipientInput = process.env.HYPERION_TESTNET_RECIPIENT;
    const apiOrigin = process.env.NEXT_PUBLIC_HYPERION_API_URL;
    const appOrigin = process.env.HYPERION_TESTNET_APP_URL;
    if (!identity || !recipientInput || !apiOrigin || !appOrigin)
      throw new Error("Set the testnet identity, recipient, API origin and application origin.");
    const sender = execFileSync("stellar", ["keys", "address", identity], {
      encoding: "utf8",
    }).trim();
    const recipient = validateRecipient(recipientInput) as `0x${string}`;
    const file = process.env.HYPERION_TESTNET_PROOF ?? defaultProofFile();
    // Retain the proof on interruption; set this path explicitly to resume without resending.
    console.log(`Live transfer proof: ${file}`);
    const amount = parseSendAmount("0.1");
    const releaseProof = lockProof(file);
    const savedProof = readProof(file);
    if (savedProof && !isProof(savedProof))
      throw new Error("The saved live proof has invalid fields; retain it for manual recovery.");
    const proof: Proof = savedProof ?? {
      network: "stellar-testnet" as const,
      router: TESTNET.router,
      sender,
      recipient,
      grossAmount: String(amount),
      status: "preparing",
    };
    expect(proof.network).toBe("stellar-testnet");
    expect(proof.router).toBe(TESTNET.router);
    expect(proof.sender).toBe(sender);
    expect(proof.recipient).toBe(recipient);
    expect(proof.grossAmount).toBe(String(amount));
    const save = () => {
      saveProof(file, proof);
    };
    const remote = createPublicClient({
      transport: http("https://ethereum-sepolia-rpc.publicnode.com", { timeout: 15_000 }),
    });
    expect(await remote.getChainId()).toBe(11155111);
    const receivedToken = "0xFd5a146686d16060ef9c595B37C30b248402304c";
    const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    const recipientBalance = () =>
      remote.readContract({
        address: receivedToken,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [recipient],
      });
    const originalFetch = globalThis.fetch;
    // Resolve the application's relative fee URL to its real running Next server.
    globalThis.fetch = (input, init) =>
      originalFetch(
        typeof input === "string" && input.startsWith("/") ? new URL(input, appOrigin) : input,
        init,
      );
    try {
      if (!proof.sourceHash) {
        const lane = await readLane("sepolia");
        expect(lane.available, lane.reason ?? "Lane unavailable").toBe(true);
        const quote = await quoteTransfer("sepolia", amount);
        proof.balanceBefore = String(await readBalance(sender));
        proof.recipientBalanceBefore = String(await recipientBalance());
        proof.fee = String(quote.fee);
        proof.destinationAmount = String(quote.destinationAmount);
        save();
        const result = await submitBridgeOut(
          sender,
          quote,
          recipient,
          (value) => {
            const signedTxXdr = execFileSync(
              "stellar",
              ["tx", "sign", "--sign-with-key", identity, "--network", "testnet"],
              { input: value, encoding: "utf8" },
            ).trim();
            const hash = Buffer.from(
              TransactionBuilder.fromXdr(signedTxXdr, TESTNET.networkPassphrase).hash(),
            ).toString("hex");
            assertSignedSource(signedTxXdr, sender, hash);
            proof.sourceEnvelope = signedTxXdr;
            proof.sourceHash = hash;
            proof.status = "signed";
            save();
            return Promise.resolve({ signedTxXdr });
          },
          (phase, hash) => {
            proof.status = phase;
            if (hash) proof.sourceHash = hash;
            save();
          },
        );
        proof.sourceHash = result.txHash;
        proof.status = result.status;
        save();
      }
      // A saved source hash is checked on restart; the test never blindly sends twice.
      const hash = proof.sourceHash;
      if (!proof.sourceEnvelope || !hash)
        throw new Error(
          "The saved proof needs its public signed source envelope; retain the hash for manual recovery.",
        );
      assertSignedSource(proof.sourceEnvelope, sender, hash);
      if (!hash) throw new Error("No submitted source transaction was recorded.");
      let source = await readTransaction(hash);
      for (let attempt = 0; attempt < 30 && source?.status === "pending"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        source = await readTransaction(hash);
      }
      expect(source?.status, `Check source transaction ${hash} before retrying`).toBe("confirmed");
      if (!proof.balanceBefore || !proof.destinationAmount || !proof.recipientBalanceBefore)
        throw new Error("The saved proof is missing its pre-transfer balances.");
      expect(await readBalance(sender)).toBe(BigInt(proof.balanceBefore) - amount);
      proof.status = "source-confirmed";
      save();
      const deadline = Date.now() + 12 * 60_000;
      while (Date.now() < deadline) {
        const indexed = await fetchTransferByTx(hash);
        if (indexed?.stage === "delivered" && indexed.destination.txHash) {
          const intent = {
            sourceHash: hash,
            sender,
            sourceToken: TESTNET.token,
            grossAmount: String(amount),
            fee: proof.fee ?? "",
            destination: "sepolia",
            recipient,
            destinationToken: receivedToken,
            destinationAmount: proof.destinationAmount,
            route: 1,
          };
          assertIndexedAcceptance(indexed, intent);
          expect(indexed.origin.txHash).toBe(hash);
          expect(indexed.origin.sender).toBe(sender);
          expect(indexed.origin.grossAmount).toBe(String(amount));
          expect(indexed.origin.fee).toBe(proof.fee);
          expect(indexed.destination.delivered).toBe(true);
          const destinationHash = indexed.destination.txHash as `0x${string}`;
          const receipt = await remote.getTransactionReceipt({ hash: destinationHash });
          assertPaymentReceipt(receipt, indexed, intent);
          expect(await recipientBalance()).toBeGreaterThanOrEqual(
            BigInt(proof.recipientBalanceBefore) + BigInt(proof.destinationAmount),
          );
          proof.destinationHash = destinationHash;
          proof.status = "delivered";
          save();
          console.log(JSON.stringify(proof));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      throw new Error(
        `Source confirmed, but indexed destination delivery is still pending: ${hash}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
      releaseProof();
    }
  },
  15 * 60_000,
);
