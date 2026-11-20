import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Keypair,
  Networks,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { conversionOperations, USDC, XLM, type Conversion } from "../src/contracts/assets";
import { bridgeOperation, settleClaimsOperation, type LiveQuote } from "../src/contracts/stellar";
import { TESTNET } from "../src/config/testnet";
import { verifyWalletSignature } from "../src/wallets/stellar/signature";

const signer = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(17));
const other = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(18));
const recipient = "0x1111111111111111111111111111111111111111";
const otherRouter = new Address(TESTNET.router).toScAddress();
const alteredRouter = Address.contract(Buffer.alloc(32, 19)).toScAddress();
const reviewed: LiveQuote = {
  route: 1,
  destination: "sepolia",
  adapter: TESTNET.router,
  requestedAmount: 123456789n,
  grossAmount: 123456789n,
  fee: 12345n,
  netAmount: 123444444n,
  representableAmount: 123444444n,
  destinationAmount: 123444444n,
  relayGas: 100001n,
  estimatedRelayGas: 90000n,
  flowAvailable: 999999999n,
  ledger: 44,
};
const conversion: Conversion = {
  source: XLM,
  sourceMax: 20000001n,
  usdcAmount: 10000001n,
  path: [],
  pathComparison: {
    returnedPaths: 1,
    eligiblePaths: 1,
    selectedOutput: 10000001n,
    excludedPaths: 0,
    diagnostics: [],
    omittedDiagnostics: 0,
  },
};

function envelope(operations: readonly xdr.Operation[], fee = "100") {
  const builder = new TransactionBuilder(new Account(signer.publicKey(), "42"), {
    fee,
    networkPassphrase: Networks.TESTNET,
  });
  operations.forEach((operation) => builder.addOperation(operation));
  return builder.setTimebounds(0, 2000000000).build();
}

// This oracle inspects independently decoded XDR against literal review fields. It never calls
// production intent serialization, matching helpers or the operation constructor to make expectations.
function call(operation: xdr.Operation) {
  const body = operation.body;
  if (body.type !== "invokeHostFunction") throw new Error("Expected a contract operation.");
  const host = body.invokeHostFunctionOp.hostFunction;
  if (host.type !== "hostFunctionTypeInvokeContract") throw new Error("Expected an invocation.");
  return host.invokeContract;
}
function replaceInvocation(
  operation: xdr.Operation,
  replacement: xdr.InvokeContractArgs,
): xdr.Operation {
  const body = operation.body;
  if (body.type !== "invokeHostFunction") throw new Error("Expected a contract operation.");
  return new xdr.Operation({
    sourceAccount: operation.sourceAccount,
    body: xdr.OperationBody.invokeHostFunction(
      new xdr.InvokeHostFunctionOp({
        auth: body.invokeHostFunctionOp.auth,
        hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(replacement),
      }),
    ),
  });
}
function invocation(operation: xdr.Operation) {
  const decoded = xdr.TransactionEnvelope.fromXdr(envelope([operation]).toXdr(), "base64");
  if (decoded.type !== "envelopeTypeTx") throw new Error("Unexpected envelope type.");
  const assembled = decoded.v1.tx.operations[0];
  if (!assembled) throw new Error("Missing operation.");
  const invocation = call(assembled);
  return {
    router: Address.fromScAddress(invocation.contractAddress).toString(),
    method: invocation.functionName.toString(),
    args: invocation.args.map(scValToNative),
  };
}

function assertBridge(operation: xdr.Operation) {
  expect(invocation(operation)).toEqual({
    router: TESTNET.router,
    method: "bridge_out_with_gas",
    args: [
      signer.publicKey(),
      {
        token: TESTNET.token,
        amount: 123456789n,
        route: 1,
        destination: {
          chain: "sepolia",
          address: Uint8Array.from(Buffer.from("00".repeat(12) + "11".repeat(20), "hex")),
        },
        destination_decimals: 7,
        min_destination_amount: 123444444n,
      },
      100001n,
    ],
  });
}
function assertConversion(operations: readonly xdr.Operation[]) {
  const decoded = TransactionBuilder.fromXdr(envelope(operations).toXdr(), Networks.TESTNET);
  if ("innerTransaction" in decoded) throw new Error("Unexpected fee bump.");
  expect(decoded.source).toBe(signer.publicKey());
  expect(decoded.sequence).toBe("43");
  expect(decoded.operations).toHaveLength(2);
  const trust = decoded.operations[0];
  const payment = decoded.operations[1];
  if (
    !trust ||
    !payment ||
    trust.type !== "changeTrust" ||
    payment.type !== "pathPaymentStrictReceive"
  )
    throw new Error("Conversion operation changed.");
  if (!("getCode" in trust.line)) throw new Error("Unexpected pool trustline.");
  expect(trust.line.getCode()).toBe("USDC");
  expect(trust.line.getIssuer()).toBe(TESTNET.usdcIssuer);
  expect(payment.sendAsset.isNative()).toBe(true);
  expect(payment.sendMax).toBe("2.0000001");
  expect(payment.destination).toBe(signer.publicKey());
  expect(payment.destAsset.getCode()).toBe("USDC");
  expect(payment.destAsset.getIssuer()).toBe(TESTNET.usdcIssuer);
  expect(payment.destAmount).toBe("1.0000001");
  expect(payment.path).toEqual([]);
}
function assertSettlement(operation: xdr.Operation) {
  expect(invocation(operation)).toEqual({
    router: TESTNET.router,
    method: "settle_claims",
    args: [signer.publicKey(), [7n, 11n]],
  });
}

describe("independent review oracles for production transaction envelopes", () => {
  it("checks the actual conversion payment, issuer-specific trustline and exact integer amounts", () => {
    assertConversion(conversionOperations(signer.publicKey(), conversion, true));
    expect(USDC.issuer).toBe(TESTNET.usdcIssuer);
  });
  it.each(["maximum", "receive", "recipient", "source issuer"])(
    "detects altered conversion %s",
    (field) => {
      const changed = { ...conversion };
      if (field === "maximum") changed.sourceMax += 1n;
      if (field === "receive") changed.usdcAmount += 1n;
      if (field === "source issuer")
        changed.source = { ...USDC, issuer: other.publicKey(), id: `USDC:${other.publicKey()}` };
      expect(() => {
        assertConversion(
          conversionOperations(
            field === "recipient" ? other.publicKey() : signer.publicKey(),
            changed,
            true,
          ),
        );
      }).toThrow();
    },
  );
  it("checks every reviewed bridge argument against the assembled production call", () => {
    assertBridge(bridgeOperation(signer.publicKey(), reviewed, recipient));
  });
  it.each(["amount", "recipient", "router", "gas budget", "minimum", "token"])(
    "detects altered bridge %s and refuses its real signature for the reviewed envelope",
    (field) => {
      const originalOperation = bridgeOperation(signer.publicKey(), reviewed, recipient);
      const changedQuote = { ...reviewed };
      if (field === "amount") changedQuote.requestedAmount += 1n;
      if (field === "gas budget") changedQuote.relayGas += 1n;
      if (field === "minimum") changedQuote.destinationAmount -= 1n;
      let changed = bridgeOperation(
        signer.publicKey(),
        changedQuote,
        field === "recipient" ? "0x2222222222222222222222222222222222222222" : recipient,
      );
      const invocation = call(changed);
      if (field === "router")
        changed = replaceInvocation(
          changed,
          new xdr.InvokeContractArgs({
            functionName: invocation.functionName,
            args: invocation.args,
            contractAddress: alteredRouter,
          }),
        );
      if (field === "token") {
        const argument = invocation.args[1];
        if (argument?.type !== "scvMap") throw new Error("Missing request map.");
        const entries = argument.map;
        if (!entries?.some((entry) => scValToNative(entry.key) === "token"))
          throw new Error("Missing token argument.");
        const request = xdr.ScVal.scvMap(
          entries.map((entry) =>
            scValToNative(entry.key) === "token"
              ? new xdr.ScMapEntry({
                  key: entry.key,
                  val: Address.fromScAddress(alteredRouter).toScVal(),
                })
              : entry,
          ),
        );
        const senderArg = invocation.args[0],
          gasArg = invocation.args[2];
        if (!senderArg || !gasArg) throw new Error("Missing sender or gas budget.");
        changed = replaceInvocation(
          changed,
          new xdr.InvokeContractArgs({
            contractAddress: invocation.contractAddress,
            functionName: invocation.functionName,
            args: [senderArg, request, gasArg],
          }),
        );
      }
      expect(() => {
        assertBridge(changed);
      }).toThrow();
      const original = envelope([originalOperation]);
      const signed = envelope([changed]);
      signed.sign(signer);
      expect(() =>
        verifyWalletSignature(original.toXdr(), signed.toXdr(), signer.publicKey()),
      ).toThrow("changed the transaction");
    },
  );
  it("checks production settlement router, account and exact ordered claim identities", () => {
    assertSettlement(settleClaimsOperation(signer.publicKey(), [7n, 11n]));
    expect(() => {
      assertSettlement(settleClaimsOperation(signer.publicKey(), [7n, 12n]));
    }).toThrow();
    expect(() => {
      assertSettlement(settleClaimsOperation(other.publicKey(), [7n, 11n]));
    }).toThrow();
    const original = settleClaimsOperation(signer.publicKey(), [7n, 11n]);
    const changed = replaceInvocation(
      original,
      new xdr.InvokeContractArgs({
        functionName: call(original).functionName,
        args: call(original).args,
        contractAddress: alteredRouter,
      }),
    );
    expect(() => {
      assertSettlement(changed);
    }).toThrow();
    expect(Address.fromScAddress(otherRouter).toString()).toBe(TESTNET.router);
  });
  it.each(["conversion", "bridge", "settlement"])(
    "validates real local %s signatures on the exact production envelope",
    (kind) => {
      const operations =
        kind === "conversion"
          ? conversionOperations(signer.publicKey(), conversion, true)
          : kind === "bridge"
            ? [bridgeOperation(signer.publicKey(), reviewed, recipient)]
            : [settleClaimsOperation(signer.publicKey(), [7n, 11n])];
      const tx = envelope(operations);
      const original = tx.toXdr();
      tx.sign(signer);
      expect(verifyWalletSignature(original, tx.toXdr(), signer.publicKey())).toBe(tx.toXdr());
      const changedFee = envelope(operations, "200");
      changedFee.sign(signer);
      expect(() => verifyWalletSignature(original, changedFee.toXdr(), signer.publicKey())).toThrow(
        "changed the transaction",
      );
      const wrongNetwork = TransactionBuilder.fromXdr(original, Networks.PUBLIC);
      wrongNetwork.sign(signer);
      expect(() =>
        verifyWalletSignature(original, wrongNetwork.toXdr(), signer.publicKey()),
      ).toThrow();
    },
  );
});
