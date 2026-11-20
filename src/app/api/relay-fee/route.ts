import { NextResponse } from "next/server";
import { DESTINATIONS } from "../../../config/testnet";
import { createSingleFlightCache } from "../../../lib/single-flight";
import { relayBudget } from "../../../lib/relay-budget";
import { validateProviderFee } from "../../../lib/fee-schema";
import type { ProviderFeeQuote } from "../../../lib/fee-schema";

const relayDestination = DESTINATIONS.find(
  (destination) =>
    destination.axelarName === "ethereum-sepolia" && destination.routes.includes(1),
);
const loadRelayFee = createSingleFlightCache<ProviderFeeQuote>(2_000);

// The fee API expects a method in the JSON body. Its /gmp/estimateITSFee path returns help text.
export async function GET() {
  if (!relayDestination)
    return NextResponse.json(
      { error: "Relay gas pricing is unavailable. No transfer can be prepared." },
      { status: 503 },
    );

  try {
    const destination = relayDestination.axelarName;
    const quote = await loadRelayFee(
      `axelar:XLM:${relayDestination.key}:${destination}`,
      async () => {
        const response = await fetch("https://testnet.api.gmp.axelarscan.io", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            method: "estimateITSFee",
            sourceChain: "stellar-2026-q1-2",
            destinationChain: destination,
            event: "InterchainTransfer",
          }),
          signal: AbortSignal.timeout(15_000),
          cache: "no-store",
        });
        const value = (await response.text()).trim().replace(/^"(\d+)"$/, "$1");
        if (!response.ok || value.length > 39 || !/^\d+$/.test(value) || BigInt(value) <= 0n)
          throw new Error("Invalid gas estimate");
        return validateProviderFee(
          {
            amount: String(relayBudget(BigInt(value))),
            estimatedAmount: value,
            token: "XLM",
            decimals: 7,
            destination,
          },
          { token: "XLM", destination },
        );
      },
    );
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "Relay gas pricing is unavailable. No transfer can be prepared." },
      { status: 503 },
    );
  }
}
