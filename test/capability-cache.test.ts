import { describe, expect, it } from "vitest";
import { CapabilityCache, type CapabilityCacheKey } from "../src/lib/capability-cache";

const key = (adapter: string): CapabilityCacheKey => ({
  network: "testnet",
  router: "router-a",
  adapter,
  resource: "methods",
});

describe("deployment-scoped capability cache", () => {
  it("deduplicates reads only within the exact lane and expires them", async () => {
    let now = 0;
    let reads = 0;
    const cache = new CapabilityCache(10, () => now);
    const read = () => Promise.resolve(++reads);
    await expect(cache.get(key("adapter-a"), read)).resolves.toBe(1);
    await expect(cache.get(key("adapter-a"), read)).resolves.toBe(1);
    await expect(cache.get(key("adapter-b"), read)).resolves.toBe(2);
    now = 11;
    await expect(cache.get(key("adapter-a"), read)).resolves.toBe(3);
  });

  it("evicts failed reads and supports explicit invalidation", async () => {
    let reads = 0;
    const cache = new CapabilityCache(100);
    await expect(
      cache.get(key("adapter-a"), () => {
        reads++;
        return Promise.reject(new Error("offline"));
      }),
    ).rejects.toThrow("offline");
    await expect(cache.get(key("adapter-a"), () => Promise.resolve(++reads))).resolves.toBe(2);
    cache.invalidate(key("adapter-a"));
    await expect(cache.get(key("adapter-a"), () => Promise.resolve(++reads))).resolves.toBe(3);
  });
});
