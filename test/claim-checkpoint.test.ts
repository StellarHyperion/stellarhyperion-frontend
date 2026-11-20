import { describe, expect, it } from "vitest";
import { parseClaimSettlementCheckpoint } from "../src/contracts/checkpoint";
import { TESTNET } from "../src/config/testnet";

describe("claim settlement checkpoints", () => {
  it("accepts a signed claim hash with exact claim identity", () => {
    expect(
      parseClaimSettlementCheckpoint(
        JSON.stringify({
          router: TESTNET.router,
          account: TESTNET.reader,
          claimId: "9007199254740993",
          recipient: TESTNET.reader,
          token: TESTNET.token,
          amount: "10000001",
          txHash: "a".repeat(64),
        }),
      ),
    ).toMatchObject({ claimId: "9007199254740993", amount: "10000001" });
  });

  it("rejects malformed or empty checkpoints", () => {
    expect(parseClaimSettlementCheckpoint(null)).toBeNull();
    expect(parseClaimSettlementCheckpoint('{"claimId":"1"}')).toBeNull();
  });
});
