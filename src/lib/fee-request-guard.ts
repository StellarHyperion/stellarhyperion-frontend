const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const requests = new Map<string, { startedAt: number; count: number }>();

export function feeRequestKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() || "anonymous";
}

export function feeRequestLimit(request: Request): { retryAfter: number } | null {
  const now = Date.now();
  for (const [key, value] of requests) {
    if (now - value.startedAt >= WINDOW_MS) requests.delete(key);
  }
  const key = feeRequestKey(request);
  const current = requests.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    requests.set(key, { startedAt: now, count: 1 });
    return null;
  }
  if (current.count >= MAX_REQUESTS)
    return { retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - current.startedAt)) / 1000)) };
  current.count++;
  return null;
}
