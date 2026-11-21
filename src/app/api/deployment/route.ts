import { NextResponse } from "next/server";
import { DEPLOYMENT_IDENTITY } from "../../../config/testnet";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET(): Response {
  return NextResponse.json(
    { identity: DEPLOYMENT_IDENTITY },
    { headers: { "Cache-Control": "no-store" } },
  );
}
