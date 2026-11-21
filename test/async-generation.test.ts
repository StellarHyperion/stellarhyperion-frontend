import { describe, expect, it } from "vitest";
import { AsyncGeneration } from "../src/lib/async-generation";

describe("async response generations", () => {
  it("accepts only the latest scheduled response", () => {
    const guard = new AsyncGeneration();
    const first = guard.next();
    const second = guard.next();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });
});
