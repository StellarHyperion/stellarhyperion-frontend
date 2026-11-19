export type RuntimeCapability = "feeRoutes" | "readOnlyHistory";

export async function detectRuntimeCapabilities(): Promise<Record<RuntimeCapability, boolean>> {
  try {
    const response = await fetch("/api/relay-fee", {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    return { feeRoutes: response.status !== 404, readOnlyHistory: true };
  } catch {
    return { feeRoutes: false, readOnlyHistory: true };
  }
}
