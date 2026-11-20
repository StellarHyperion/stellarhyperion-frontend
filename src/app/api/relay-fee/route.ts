import { NextResponse } from "next/server";
import { feeObservation, relayBudget } from "../../../lib/relay-budget";
import {
  feeRequestGuard,
  readFeeResponse,
  validateFeeRequest,
  providerFeeCooldown,
} from "../../../lib/fee-request-guard";
import { validateProviderFee } from "../../../lib/fee-schema";
// The fee API expects a method in the JSON body. Its /gmp/estimateITSFee path returns help text.
export async function GET(request: Request) {
  try {
    validateFeeRequest(request, []);
  } catch {
    return NextResponse.json(
      { error: "Choose a supported fee request.", code: "BAD_REQUEST" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const admission = feeRequestGuard.acquire();
  if ("retryAfter" in admission)
    return NextResponse.json(
      {
        error: "Fee estimates are busy. Retry after the indicated delay.",
        code: "RATE_LIMITED",
        retryAfter: admission.retryAfter,
      },
      {
        status: 429,
        headers: { "Retry-After": String(admission.retryAfter), "Cache-Control": "no-store" },
      },
    );
  const cooldown = providerFeeCooldown.remaining("relay");
  if (cooldown > 0) {
    admission.release();
    return NextResponse.json(
      {
        error: "Live provider pricing is cooling down. No transfer can be prepared.",
        code: "RATE_LIMITED",
        retryAfter: cooldown,
      },
      { status: 429, headers: { "Retry-After": String(cooldown), "Cache-Control": "no-store" } },
    );
  }
  try {
    const response = await fetch("https://testnet.api.gmp.axelarscan.io", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "estimateITSFee",
        sourceChain: "stellar-2026-q1-2",
        destinationChain: "ethereum-sepolia",
        event: "InterchainTransfer",
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      cache: "no-store",
    });
    if (response.status === 429 || response.status === 503) {
      const retryAfter = providerFeeCooldown.block("relay", response.headers.get("retry-after"));
      await response.body?.cancel();
      return NextResponse.json(
        {
          error: "Axelar relay gas pricing is rate-limited. No transfer can be prepared.",
          code: "RATE_LIMITED",
          retryAfter,
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" },
        },
      );
    }
    const value = (await readFeeResponse(response)).trim().replace(/^"(\d+)"$/, "$1");
    if (!response.ok || value.length > 39 || !/^\d+$/.test(value) || BigInt(value) <= 0n)
      throw new Error("Invalid gas estimate");
    const quote = validateProviderFee(
      {
        amount: String(relayBudget(BigInt(value))),
        estimatedAmount: value,
        token: "XLM",
        decimals: 7,
        destination: "ethereum-sepolia",
        provider: "Axelar ITS",
        ...feeObservation(),
        lane: { source: "stellar-testnet", destination: "ethereum-sepolia", route: 1 },
      },
      { token: "XLM", destination: "ethereum-sepolia" },
    );
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "Relay gas pricing is unavailable. No transfer can be prepared." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    admission.release();
  }
}
