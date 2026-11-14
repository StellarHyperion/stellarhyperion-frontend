import { NextResponse } from "next/server";
import { destinationFor } from "../../../config/testnet";
import {
  feeQuoteCoalescer,
  feeQuoteKey,
  isAbortError,
  relayBudget,
  type FeeQuotePayload,
} from "../../../lib/relay-budget";

const AXELAR_STELLAR_SOURCE = "stellar-2026-q1-2";

// The fee API expects a method in the JSON body. Its /gmp/estimateITSFee path returns help text.
export async function GET(request?: Request) {
  const rawDestination = request ? new URL(request.url).searchParams.get("destination") : null;
  const requestedKey = rawDestination?.trim() ? rawDestination.trim() : "sepolia";

  let destinationChain: string;
  try {
    const destination = destinationFor(requestedKey);
    if (destination.key !== "sepolia" || destination.axelarName === null) {
      return NextResponse.json(
        { error: "Axelar ITS is configured for Sepolia. Choose Circle CCTP for this network." },
        { status: 400 },
      );
    }
    destinationChain = destination.axelarName;
  } catch {
    return NextResponse.json({ error: "Choose a supported destination testnet." }, { status: 400 });
  }

  const key = feeQuoteKey({
    provider: "axelar-its",
    source: AXELAR_STELLAR_SOURCE,
    destination: `${requestedKey}:${destinationChain}`,
    token: "XLM",
    issuer: null,
    decimals: 7,
  });

  try {
    const quote = await feeQuoteCoalescer.coalesce(
      key,
      async (signal): Promise<FeeQuotePayload> => {
        const response = await fetch("https://testnet.api.gmp.axelarscan.io", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            method: "estimateITSFee",
            sourceChain: AXELAR_STELLAR_SOURCE,
            destinationChain,
            event: "InterchainTransfer",
          }),
          signal,
          cache: "no-store",
        });
        const value = (await response.text()).trim().replace(/^"(\d+)"$/, "$1");
        if (!response.ok || !/^\d+$/.test(value) || BigInt(value) <= 0n) {
          throw new Error("Invalid gas estimate");
        }
        return {
          amount: String(relayBudget(BigInt(value))),
          estimatedAmount: value,
          token: "XLM",
          issuer: null,
          decimals: 7,
        };
      },
      { signal: request?.signal },
    );
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    if (isAbortError(error) && request?.signal.aborted) {
      return NextResponse.json(
        { error: "Relay gas quote request was cancelled." },
        { status: 499, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: "Relay gas pricing is unavailable. No transfer can be prepared." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
