import { NextResponse } from "next/server";
import { destinationFor } from "../../../config/testnet";
import { createSingleFlightCache } from "../../../lib/single-flight";
import { relayBudget } from "../../../lib/relay-budget";
import { validateProviderFee } from "../../../lib/fee-schema";
import type { ProviderFeeQuote } from "../../../lib/fee-schema";

const loadCircleFee = createSingleFlightCache<ProviderFeeQuote>(2_000);

export async function GET(request: Request) {
  let destination: ReturnType<typeof destinationFor>;
  try {
    destination = destinationFor(new URL(request.url).searchParams.get("destination") ?? "");
  } catch {
    return NextResponse.json({ error: "Choose a supported destination testnet." }, { status: 400 });
  }
  if (!destination.routes.includes(0))
    return NextResponse.json(
      { error: "The CCTP lane is not active for this destination." },
      { status: 400 },
    );

  try {
    const quote = await loadCircleFee(
      `circle:USDC:${destination.key}:${destination.cctpDomain}`,
      async () => {
        const response = await fetch(
          `https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/27/${destination.cctpDomain}?forward=true`,
          {
            signal: AbortSignal.timeout(15_000),
            cache: "no-store",
          },
        );
        const body: unknown = await response.json();
        if (!response.ok || !Array.isArray(body) || body.length > 32)
          throw new Error("Invalid Circle fee response.");
        const fee = body.find(
          (
            item: unknown,
          ): item is { finalityThreshold: number; minimumFee: number; forwardFee: { med: number } } => {
            if (!item || typeof item !== "object") return false;
            const entry = item as Record<string, unknown>;
            return (
              entry.finalityThreshold === 2000 &&
              entry.minimumFee === 0 &&
              entry.forwardFee !== null &&
              typeof entry.forwardFee === "object" &&
              !Array.isArray(entry.forwardFee)
            );
          },
        );
        if (!fee || !Number.isSafeInteger(fee.forwardFee.med) || fee.forwardFee.med <= 0)
          throw new Error("No finalized forwarding estimate.");
        return validateProviderFee(
          {
            amount: String(relayBudget(BigInt(fee.forwardFee.med)) * 10n),
            estimatedAmount: String(BigInt(fee.forwardFee.med) * 10n),
            token: "USDC",
            decimals: 7,
            destination: destination.key,
            finality: 2000,
          },
          {
            token: "USDC",
            destination: destination.key,
          },
        );
      },
    );
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "Circle forwarding pricing is unavailable. Try again later." },
      { status: 503 },
    );
  }
}
