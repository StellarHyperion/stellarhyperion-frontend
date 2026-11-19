export type CapabilityCacheKey = Readonly<{
  network: string;
  router: string;
  adapter: string;
  resource: string;
}>;

interface Entry<T> {
  expiresAt: number;
  value: Promise<T>;
}

/**
 * Cache read-only capability discovery without allowing one deployment lane to satisfy another.
 * Failed reads are never retained as healthy capabilities.
 */
export class CapabilityCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new Error("Capability cache TTL must be positive.");
  }

  get(key: CapabilityCacheKey, read: () => Promise<T>): Promise<T> {
    const cacheKey = JSON.stringify(key);
    const current = this.entries.get(cacheKey);
    const now = this.now();
    if (current && current.expiresAt > now) return current.value;
    if (current) this.entries.delete(cacheKey);
    const value = read().catch((error: unknown) => {
      this.entries.delete(cacheKey);
      throw error;
    });
    this.entries.set(cacheKey, { expiresAt: now + this.ttlMs, value });
    return value;
  }

  invalidate(key?: CapabilityCacheKey): void {
    if (!key) {
      this.entries.clear();
      return;
    }
    this.entries.delete(JSON.stringify(key));
  }
}
