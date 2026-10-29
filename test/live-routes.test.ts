import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createPublicClient, http, parseAbi } from "viem";
import { destinationFor, TESTNET, type BridgeRoute } from "../src/config/testnet";
import {
  quoteTransfer,
  readBalance,
  readLane,
  readTransaction,
  submitBridgeOut,
  validateRecipient,
  type WalletSigner,
} from "../src/contracts/stellar";
import { accountAssets, quoteTrade, submitConversion, USDC, XLM } from "../src/contracts/assets";
import { fetchTransferByTx } from "../src/api/backend";

interface Proof {
  router: string;
  identity: string;
  sender: string;
  recipient: string;
  mode: string;
  destination: string;
  route: BridgeRoute;
  bridgeAmount?: string;
  conversionHash?: string;
  sourceHash?: string;
  destinationHash?: string;
  destinationToken?: string;
  destinationAmount?: string;
  recipientBefore?: string;
  trustlineBefore?: boolean;
  status: string;
}
// Explicit opt-in only. Conversion spends at most 1 testnet XLM plus network/relay fees.
// CCTP spends 0.3 testnet USDC. Named CLI identities hold keys outside the repository.
it.skipIf(process.env.HYPERION_LIVE_ROUTES !== "1")(
  "verifies a real conversion or CCTP route through destination payment",
  { timeout: 900000 },
  async () => {
    const identity = process.env.HYPERION_ROUTE_IDENTITY;
    const mode = process.env.HYPERION_ROUTE_MODE;
    const file = process.env.HYPERION_ROUTE_PROOF;
    const appOrigin = process.env.HYPERION_TESTNET_APP_URL;
    const recipient = validateRecipient(
      process.env.HYPERION_TESTNET_RECIPIENT ?? "",
    ) as `0x${string}`;
    const destination = destinationFor(process.env.HYPERION_ROUTE_DESTINATION ?? "sepolia");
    if (
      !identity ||
      !file ||
      !appOrigin ||
      !process.env.NEXT_PUBLIC_HYPERION_API_URL ||
      (mode !== "convert" && mode !== "cctp")
    )
      throw new Error(
        "Set route mode, CLI identity, proof path, application/API origins and recipient.",
      );
    const route: BridgeRoute = mode === "cctp" ? 0 : 1;
    const sender = execFileSync("stellar", ["keys", "address", identity], {
      encoding: "utf8",
    }).trim();
    const proof: Proof = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Proof)
      : {
          router: TESTNET.router,
          identity,
          sender,
          recipient,
          mode,
          destination: destination.key,
          route,
          status: "preparing",
        };
    if (
      proof.router !== TESTNET.router ||
      proof.sender !== sender ||
      proof.recipient !== recipient ||
      proof.mode !== mode ||
      proof.destination !== destination.key ||
      proof.route !== route
    )
      throw new Error(
        "The saved proof belongs to a different transfer. Never overwrite a pending transfer.",
      );
    const save = () => {
      writeFileSync(file, JSON.stringify(proof, null, 2) + "\n");
    };
    const sign: WalletSigner = (value) =>
      Promise.resolve({
        signedTxXdr: execFileSync(
          "stellar",
          ["tx", "sign", "--sign-with-key", identity, "--network", "testnet"],
          { input: value, encoding: "utf8" },
        ).trim(),
      });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      originalFetch(
        typeof input === "string" && input.startsWith("/") ? new URL(input, appOrigin) : input,
        init,
      );
    try {
      const lane = await readLane(destination.key, route);
      expect(lane.available, lane.reason ?? "Unavailable lane").toBe(true);
      if (!lane.destinationToken) throw new Error("No verified destination token.");
      const token = lane.destinationToken as `0x${string}`;
      const client = createPublicClient({ transport: http(destination.rpcUrl) });
      const balance = () =>
        client.readContract({
          address: token,
          abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
          functionName: "balanceOf",
          args: [recipient],
        });
      if (proof.recipientBefore === undefined) {
        proof.recipientBefore = String(await balance());
        proof.destinationToken = token;
        save();
      }
      if (mode === "convert" && !proof.conversionHash) {
        const assets = await accountAssets(sender);
        proof.trustlineBefore = assets.some((asset) => asset.id === USDC.id);
        save();
        const quote = await quoteTrade(destination.key, XLM, "1", route);
        if (!quote.conversion) throw new Error("Conversion missing.");
        proof.bridgeAmount = String(quote.bridge.requestedAmount);
        save();
        const result = await submitConversion(sender, quote.conversion, sign, (phase, hash) => {
          proof.status = `conversion-${phase}`;
          if (hash) proof.conversionHash = hash;
          save();
        });
        proof.conversionHash = result.txHash;
        proof.status = `conversion-${result.status}`;
        save();
      }
      if (proof.conversionHash) {
        let converted = await readTransaction(proof.conversionHash);
        for (let attempt = 0; attempt < 40 && converted?.status === "pending"; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          converted = await readTransaction(proof.conversionHash);
        }
        expect(converted?.status, `Check conversion ${proof.conversionHash} before retrying`).toBe(
          "confirmed",
        );
        expect((await accountAssets(sender)).some((asset) => asset.id === USDC.id)).toBe(true);
      }
      if (mode === "cctp" && !proof.bridgeAmount) {
        proof.bridgeAmount = "3000000";
        save();
      }
      if (!proof.bridgeAmount) throw new Error("The saved bridge amount is missing.");
      if (!proof.sourceHash) {
        for (let attempt = 0; attempt < 3 && !proof.sourceHash; attempt++) {
          const quote = await quoteTransfer(destination.key, BigInt(proof.bridgeAmount), route);
          expect(await readBalance(sender)).toBeGreaterThanOrEqual(quote.grossAmount);
          proof.destinationAmount = String(quote.destinationAmount);
          save();
          try {
            const result = await submitBridgeOut(sender, quote, recipient, sign, (phase, hash) => {
              proof.status = phase;
              if (hash) proof.sourceHash = hash;
              save();
            });
            proof.sourceHash = result.txHash;
            proof.status = result.status;
            save();
          } catch (error) {
            if (
              proof.sourceHash ||
              !(error instanceof Error) ||
              !error.message.includes("quote changed") ||
              attempt === 2
            )
              throw error;
          }
        }
      }
      if (!proof.sourceHash) throw new Error("No real source transaction was recorded.");
      let source = await readTransaction(proof.sourceHash);
      for (let attempt = 0; attempt < 40 && source?.status === "pending"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        source = await readTransaction(proof.sourceHash);
      }
      expect(source?.status, `Check source ${proof.sourceHash} before retrying`).toBe("confirmed");
      proof.status = "source-confirmed";
      save();
      let delivered = false;
      for (let attempt = 0; attempt < 240; attempt++) {
        const indexed = await fetchTransferByTx(proof.sourceHash);
        if (indexed?.stage === "delivered" && indexed.destination.txHash) {
          const receipt = await client.getTransactionReceipt({
            hash: indexed.destination.txHash as `0x${string}`,
          });
          expect(receipt.status).toBe("success");
          expect(await balance()).toBeGreaterThanOrEqual(
            BigInt(proof.recipientBefore) + BigInt(proof.destinationAmount ?? "0"),
          );
          proof.destinationHash = indexed.destination.txHash;
          proof.status = "delivered";
          save();
          delivered = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      expect(
        delivered,
        `Preserve proof and inspect ${proof.sourceHash}; never resend blindly`,
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
