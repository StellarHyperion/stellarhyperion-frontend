export type CapabilityCacheKey = Readonly<{
  network: string;
  router: string;
  adapter: string;
  resource: string;
  revision?: string;
}>;

interface Entry<T> {
  expiresAt: number;
  value: Promise<T>;
}

/** Bounded read-only discovery; rejected or unknown reads never remain healthy. */
export class CapabilityCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly limit = 64,
    private readonly healthy: (value: T) => boolean = (value) =>
      value !== null && value !== undefined,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 60_000)
      throw new Error("Capability cache TTL must be positive and at most one minute.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new Error("Capability cache capacity must be between one and 256 entries.");
  }

  get(key: CapabilityCacheKey, read: () => Promise<T>): Promise<T> {
    const fields = [key.network, key.router, key.adapter, key.resource, key.revision ?? ""];
    if (fields.some((value) => typeof value !== "string" || value.length > 2048))
      throw new Error("Capability identity is invalid.");
    const cacheKey = JSON.stringify(fields);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Capability clock is invalid.");
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
    const current = this.entries.get(cacheKey);
    if (current) return current.value;
    while (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const entry: Entry<T> = {
      expiresAt: now + this.ttlMs,
      value: Promise.resolve().then(read),
    };
    entry.value = entry.value.then(
      (value) => {
        if (!this.healthy(value) && this.entries.get(cacheKey) === entry)
          this.entries.delete(cacheKey);
        return value;
      },
      (error: unknown) => {
        if (this.entries.get(cacheKey) === entry) this.entries.delete(cacheKey);
        throw error;
      },
    );
    this.entries.set(cacheKey, entry);
    return entry.value;
  }

  invalidate(key?: CapabilityCacheKey): void {
    if (!key) this.entries.clear();
    else
      this.entries.delete(
        JSON.stringify([key.network, key.router, key.adapter, key.resource, key.revision ?? ""]),
      );
  }
}
