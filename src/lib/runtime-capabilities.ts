export type FeeRoute = "relay" | "cctp";
export type CapabilityState = "checking" | "available" | "missing" | "unknown";
export interface RuntimeCapabilities {
  readonly routes: Readonly<Record<FeeRoute, CapabilityState>>;
  readonly readOnlyHistory: true;
}

export const runtimeProtocol = "next-server-v1";
export const initialRuntimeCapabilities: RuntimeCapabilities = {
  routes: { relay: "checking", cctp: "checking" },
  readOnlyHistory: true,
};

// This proves endpoint presence only. A fresh valid fee and simulation remain required to sign.
export function feeRouteCapabilityResponse(route: FeeRoute): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "X-Hyperion-Runtime": runtimeProtocol,
      "X-Hyperion-Fee-Route": route,
      "Cache-Control": "no-store",
    },
  });
}

export function runtimeSigningAvailable(capabilities: RuntimeCapabilities, route: number): boolean {
  if (route !== 0 && route !== 1) return false;
  return capabilities.routes[route === 0 ? "cctp" : "relay"] === "available";
}

export async function detectRuntimeCapabilities(
  signal?: AbortSignal,
): Promise<RuntimeCapabilities> {
  const deadline = AbortSignal.timeout(5_000);
  const probeSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  async function probe(route: FeeRoute): Promise<CapabilityState> {
    if (probeSignal.aborted) return "unknown";
    try {
      const response = await fetch(`/api/${route === "relay" ? "relay" : "cctp"}-fee`, {
        method: "HEAD",
        cache: "no-store",
        redirect: "error",
        signal: probeSignal,
      });
      await response.body?.cancel();
      probeSignal.throwIfAborted();
      if (response.status === 404 || response.status === 410) return "missing";
      return response.status === 204 &&
        response.headers.get("X-Hyperion-Runtime") === runtimeProtocol &&
        response.headers.get("X-Hyperion-Fee-Route") === route
        ? "available"
        : "unknown";
    } catch {
      return "unknown";
    }
  }
  const [relay, cctp] = await Promise.all([probe("relay"), probe("cctp")]);
  return { routes: { relay, cctp }, readOnlyHistory: true };
}
