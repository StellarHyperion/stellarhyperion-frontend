import { describe, expect, it } from "vitest";
import { boundedRetryAfter, createFeeCooldown } from "../src/lib/relay-budget";

describe("provider fee cooldowns", () => {
  it("uses bounded integer seconds and HTTP dates without accepting malformed numeric dates", () => {
    const now = Date.UTC(2026, 10, 20);
    expect(boundedRetryAfter("120", now)).toBe(60);
    expect(boundedRetryAfter("0", now)).toBe(0);
    expect(boundedRetryAfter(new Date(now + 15_000).toUTCString(), now)).toBe(15);
    for (const header of [null, "", " ", "-1", "1.5", "invalid"])
      expect(boundedRetryAfter(header, now)).toBeNull();
  });
  it("shares a deadline across changing inputs and destinations while leaving the other rail available", () => {
    let time = 0;
    const cooldown = createFeeCooldown(() => time);
    expect(cooldown.block("cctp", "30")).toBe(30);
    expect(cooldown.remaining("relay")).toBe(0);
    time = 500;
    expect(cooldown.remaining("cctp")).toBe(30);
    expect(cooldown.block("cctp", "1")).toBe(30);
    time = 29_999;
    expect(cooldown.remaining("cctp")).toBe(1);
    time = 30_000;
    expect(cooldown.remaining("cctp")).toBe(0);
  });
  it("bounds missing/zero metadata with a nonzero fallback rather than triggering automatic retry storms", () => {
    const cooldown = createFeeCooldown(() => 0);
    expect(cooldown.block("relay", null)).toBe(5);
    expect(cooldown.block("cctp", "0")).toBe(1);
  });
});
