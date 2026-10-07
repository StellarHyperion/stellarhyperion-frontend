import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Accessibility and Design Token Audits", () => {
  const globalsCss = readFileSync(join(__dirname, "../src/app/globals.css"), "utf-8");

  it("declares prefers-reduced-motion media query collapsing all motion durations to zero", () => {
    expect(globalsCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(globalsCss).toContain("--motion-tap: 0ms;");
    expect(globalsCss).toContain("--motion-state: 0ms;");
    expect(globalsCss).toContain("--motion-draw: 0ms;");
    expect(globalsCss).toContain("--motion-draw-stagger: 0ms;");
    expect(globalsCss).toContain("animation-duration: 0.01ms !important;");
    expect(globalsCss).toContain("transition-duration: 0.01ms !important;");
  });

  it("configures copper focus visible rings passing WCAG AA", () => {
    expect(globalsCss).toContain(":focus-visible {");
    expect(globalsCss).toContain("outline: var(--focus-width) solid var(--focus-color);");
    expect(globalsCss).toContain("--focus-color: var(--copper);");
  });

  it("defines keyboard skip link styles", () => {
    expect(globalsCss).toContain(".skipLink {");
    expect(globalsCss).toContain(".skipLink:focus-visible {");
  });

  it("enforces role-based radii according to locked design tokens", () => {
    expect(globalsCss).toContain("--radius-panel: 4px;");
    expect(globalsCss).toContain("--radius-control: 2px;");
    expect(globalsCss).toContain("--radius-yard: 0;");
  });
});
