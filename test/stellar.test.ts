import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Contract, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import {
  bridgeOperation,
  claimMatchesDeployment,
  parseSendAmount,
  readTransaction,
  validateRecipient,
  verifyRouterDeployment,
  type LiveQuote,
} from "../src/contracts/stellar";
import { STELLAR_DEPLOYMENT, TESTNET } from "../src/config/testnet";
const quote: LiveQuote = {
  route: 1,
  adapter: TESTNET.router,
  destination: "sepolia",
  requestedAmount: 10000009n,
  grossAmount: 10000009n,
  fee: 30000n,
  netAmount: 9970009n,
  destinationAmount: 9970009n,
  representableAmount: 9970009n,
  flowAvailable: 10000000000n,
  ledger: 1,
  relayGas: 1051082n,
};
afterEach(() => vi.unstubAllGlobals());
describe("Real Stellar transaction encoding", () => {
  it("only offers recovery for a claim carrying the verified deployment identity", () => {
    const deployment = {
      chain: STELLAR_DEPLOYMENT.chain,
      router: STELLAR_DEPLOYMENT.router,
      wasmHash: STELLAR_DEPLOYMENT.wasmHash,
    };
    expect(claimMatchesDeployment({ deployment }, deployment)).toBe(true);
    expect(
      claimMatchesDeployment({ deployment: { ...deployment, router: "COTHER" } }, deployment),
    ).toBe(false);
    expect(claimMatchesDeployment({ deployment: null }, deployment)).toBe(false);
  });
  it("matches claims only to the exact chain, router and WASM revision", () => {
    const claim = {
      deployment: {
        chain: STELLAR_DEPLOYMENT.chain,
        router: STELLAR_DEPLOYMENT.router,
        wasmHash: STELLAR_DEPLOYMENT.wasmHash,
      },
    };
    expect(claimMatchesDeployment(claim, claim.deployment)).toBe(true);
    for (const change of [
      { chain: "ethereum-sepolia" },
      { router: "COTHER" },
      { wasmHash: "0".repeat(64) },
    ]) {
      expect(
        claimMatchesDeployment(
          { deployment: { ...claim.deployment, ...change } },
          claim.deployment,
        ),
      ).toBe(false);
    }
    expect(claimMatchesDeployment({ deployment: null }, claim.deployment)).toBe(false);
  });
  it("accepts only the configured router's verified on-chain WASM revision", async () => {
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: STELLAR_DEPLOYMENT.networkPassphrase,
      protocolVersion: "27",
    });
    vi.spyOn(rpc.Server.prototype, "getContractInstance").mockResolvedValue({
      executable: {
        type: "contractExecutableWasm",
        wasmHash: Uint8Array.from({ length: 32 }, (_, index) =>
          parseInt(STELLAR_DEPLOYMENT.wasmHash.slice(index * 2, index * 2 + 2), 16),
        ),
      },
      storage: null,
    } as never);
    await expect(verifyRouterDeployment()).resolves.toMatchObject({
      router: STELLAR_DEPLOYMENT.router,
      wasmHash: STELLAR_DEPLOYMENT.wasmHash,
      commit: STELLAR_DEPLOYMENT.commit,
    });
  });
  it("rejects an on-chain router revision that is not in the deployment manifest", async () => {
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: STELLAR_DEPLOYMENT.networkPassphrase,
      protocolVersion: "27",
    });
    vi.spyOn(rpc.Server.prototype, "getContractInstance").mockResolvedValue({
      executable: { type: "contractExecutableWasm", wasmHash: new Uint8Array(32) },
      storage: null,
    } as never);
    await expect(verifyRouterDeployment()).rejects.toThrow("revision is not verified");
  });
  it("keeps claim recovery read-only when the RPC network is unsupported", async () => {
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: "Public Global Stellar Network ; September 2015",
      protocolVersion: "27",
    });
    const contract = vi.spyOn(rpc.Server.prototype, "getContractInstance");
    await expect(verifyRouterDeployment()).rejects.toThrow("not Stellar Testnet");
    expect(contract).not.toHaveBeenCalled();
  });
  it("keeps values beyond Number precision exact and rejects invalid amounts", () => {
    expect(parseSendAmount("900719925.4740993")).toBe(9007199254740993n);
    for (const value of ["", "0", "-1", "1.12345678", "1e3", "NaN", "1,000"])
      expect(() => parseSendAmount(value)).toThrow();
  });
  it("requires a real nonzero EVM destination", () => {
    expect(validateRecipient("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toMatch(/^0x/);
    for (const value of ["", "0x123", "0x" + "0".repeat(40), TESTNET.reader])
      expect(() => validateRecipient(value)).toThrow();
  });
  it("builds the actual paid router call and includes exact amounts, gas and destination", () => {
    const operation = bridgeOperation(
      TESTNET.reader,
      quote,
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
    const tx = new TransactionBuilder(new Account(TESTNET.reader, "0"), {
      fee: "100",
      networkPassphrase: TESTNET.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();
    const decoded = TransactionBuilder.fromXdr(tx.toXdr(), TESTNET.networkPassphrase);
    const op = decoded.operations[0];
    expect(op?.type).toBe("invokeHostFunction");
    if (op?.type !== "invokeHostFunction") throw new Error("Wrong operation");
    if (op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("Wrong host function");
    const invocation = op.func.invokeContract;
    expect(invocation.functionName.toString()).toBe("bridge_out_with_gas");
    const args = invocation.args;
    if (!args[1] || !args[2]) throw new Error("Missing request or relay gas");
    const request = scValToNative(args[1]) as {
      amount: bigint;
      min_destination_amount: bigint;
      destination_decimals: number;
      destination: { chain: string; address: Uint8Array };
    };
    expect(request.amount).toBe(10000009n);
    expect(request.destination_decimals).toBe(7);
    expect(request.min_destination_amount).toBe(9970009n);
    expect(request.destination.chain).toBe("sepolia");
    expect(request.destination.address.length).toBe(32);
    expect(scValToNative(args[2])).toBe(1051082n);
    expect(new Contract(TESTNET.router).contractId()).toBe(TESTNET.router);
  });
  it("does not query arbitrary malformed transaction IDs", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await readTransaction("0xnot-a-stellar-tx")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("encodes Circle's post-forwarding receive minimum with six-decimal native USDC", () => {
    const operation = bridgeOperation(
      TESTNET.reader,
      { ...quote, route: 0, destinationAmount: 900000n, relayGas: 500000n },
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
    const tx = new TransactionBuilder(new Account(TESTNET.reader, "0"), {
      fee: "100",
      networkPassphrase: TESTNET.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();
    const op = tx.operations[0];
    if (op?.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract")
      throw new Error("Wrong bridge operation.");
    const encodedRequest = op.func.invokeContract.args[1];
    if (!encodedRequest) throw new Error("Missing bridge request.");
    const request = scValToNative(encodedRequest) as {
      route: number;
      destination_decimals: number;
      min_destination_amount: bigint;
    };
    expect(request.route).toBe(0);
    expect(request.destination_decimals).toBe(6);
    expect(request.min_destination_amount).toBe(900000n);
  });
});
