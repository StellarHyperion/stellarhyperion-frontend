import { NextResponse } from "next/server";
import { TESTNET, destinationFor } from "../../../config/testnet";
import {
  feeQuoteCoalescer,
  feeQuoteKey,
  isAbortError,
  relayBudget,
  type FeeQuotePayload,
} from "../../../lib/relay-budget";

const CIRCLE_STELLAR_DOMAIN = 27;

export async function GET(request: Request) {
  let destination: ReturnType<typeof destinationFor>;
  try {
    destination = destinationFor(new URL(request.url).searchParams.get("destination") ?? "");
  } catch {
    return NextResponse.json({ error: "Choose a supported destination testnet." }, { status: 400 });
  }

  const key = feeQuoteKey({
    provider: "circle-cctp",
    source: `domain:${CIRCLE_STELLAR_DOMAIN}`,
    destination: `${destination.key}:domain:${destination.cctpDomain}`,
    token: TESTNET.usdcCode,
    issuer: TESTNET.usdcIssuer,
    decimals: 7,
  });

  try {
    const quote = await feeQuoteCoalescer.coalesce(
      key,
      async (signal): Promise<FeeQuotePayload> => {
        const response = await fetch(
          `https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/${CIRCLE_STELLAR_DOMAIN}/${destination.cctpDomain}?forward=true`,
          {
            signal,
            cache: "no-store",
          },
        );
        const body: unknown = await response.json();
        if (!response.ok || !Array.isArray(body)) throw new Error("Invalid Circle fee response.");
        const fee = body.find(
          (
            item: unknown,
          ): item is {
            finalityThreshold: number;
            minimumFee: number;
            forwardFee: { med: number };
          } => {
            if (!item || typeof item !== "object") return false;
            const entry = item as Record<string, unknown>;
            return (
              entry.finalityThreshold === 2000 &&
              entry.minimumFee === 0 &&
              typeof entry.forwardFee === "object" &&
              entry.forwardFee !== null
            );
          },
        );
        if (!fee || !Number.isSafeInteger(fee.forwardFee.med) || fee.forwardFee.med <= 0) {
          throw new Error("No finalized forwarding estimate.");
        }
        return {
          amount: String(relayBudget(BigInt(fee.forwardFee.med)) * 10n),
          estimatedAmount: String(BigInt(fee.forwardFee.med) * 10n),
          token: TESTNET.usdcCode,
          issuer: TESTNET.usdcIssuer,
          decimals: 7,
          finality: 2000,
        };
      },
      { signal: request.signal },
    );
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    if (isAbortError(error) && request.signal.aborted) {
      return NextResponse.json(
        { error: "Circle forwarding quote request was cancelled." },
        { status: 499, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: "Circle forwarding pricing is unavailable. Try again later." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
