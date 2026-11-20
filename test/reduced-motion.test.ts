import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESTINATION_DELIVERY_NOTICE,
  transactionProgress,
  transactionProgressSummary,
} from "../src/components/bridge/progress";

const PHASES = ["preparing", "signing", "submitting", "pending", "confirmed"] as const;

describe("Reduced motion transaction progress", () => {
  it("describes the same five steps for every phase without an animation", () => {
    for (const step of ["conversion", "bridge"] as const) {
      for (const phase of PHASES) {
        const progress = transactionProgress(step, phase);
        expect(progress.map((item) => item.id)).toEqual([
          "prepare",
          "approve",
          "submit",
          "source",
          "destination",
        ]);
        for (const item of progress) expect(item.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it("advances one step at a time and leaves the destination waiting", () => {
    for (const step of ["conversion", "bridge"] as const) {
      const seen = PHASES.map((phase) => ({
        phase,
        progress: transactionProgress(step, phase),
      }));
      seen.forEach(({ phase, progress }, index) => {
        expect(progress.filter((item) => item.state === "active")).toHaveLength(
          phase === "confirmed" ? 0 : 1,
        );
        expect(progress[progress.length - 1]?.state).toBe("waiting");
        if (index > 0) {
          const previous = seen[index - 1]?.progress ?? [];
          expect(progress.filter((item) => item.state === "done").length).toBe(
            previous.filter((item) => item.state === "done").length + 1,
          );
        }
      });
    }
  });

  it("never lets source confirmation imply destination delivery", () => {
    for (const step of ["conversion", "bridge"] as const) {
      const confirmed = transactionProgress(step, "confirmed");
      const destination = confirmed.find((item) => item.id === "destination");
      expect(destination?.state).toBe("waiting");
      expect(destination?.detail).toBe(DESTINATION_DELIVERY_NOTICE);
      expect(confirmed.find((item) => item.id === "source")?.state).toBe("done");
      const summary = transactionProgressSummary(step, "confirmed");
      expect(summary).toContain("Destination delivery is tracked separately");
      expect(summary).not.toMatch(/delivered|complete on the destination/i);
    }
    expect(transactionProgressSummary("conversion", "confirmed")).toContain(
      "still requires your wallet approval",
    );
  });

  it("gives each phase a static summary sentence", () => {
    for (const step of ["conversion", "bridge"] as const) {
      for (const phase of PHASES) {
        const summary = transactionProgressSummary(step, phase);
        expect(
          summary.startsWith(
            step === "conversion" ? "Converting to USDC: " : "Preparing your bridge: ",
          ),
        ).toBe(true);
        expect(summary.endsWith(".")).toBe(true);
      }
    }
  });
});

describe("Reduced motion stylesheet contract", () => {
  const globalsCss = readFileSync(join(__dirname, "../src/app/globals.css"), "utf-8");
  const pickerCss = readFileSync(
    join(__dirname, "../src/components/bridge/AssetPicker.module.css"),
    "utf-8",
  );

  it("removes decorative animation markers when motion is reduced", () => {
    expect(globalsCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(globalsCss).toContain('[data-motion="decorative"]');
    expect(globalsCss).toContain("animation: none !important;");
  });

  it("opens dialogs without motion when the preference is on", () => {
    expect(pickerCss).toContain('[data-reduced-motion="true"]');
    expect(pickerCss).toContain("@media (prefers-reduced-motion: no-preference)");
  });
});
