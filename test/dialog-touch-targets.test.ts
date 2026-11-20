import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf-8");

describe("Touch target and small screen hardening", () => {
  const globalsCss = read("src/app/globals.css");
  const dialog = read("src/components/common/Dialog.tsx");
  const picker = read("src/components/bridge/AssetPicker.tsx");
  const pickerCss = read("src/components/bridge/AssetPicker.module.css");
  const bridge = read("src/components/bridge/Bridge.tsx");
  const bridgeCss = read("src/components/bridge/Bridge.module.css");

  it("defines one tap target token and applies it to coarse pointers and narrow viewports", () => {
    expect(globalsCss).toContain("--tap-target: 2.75rem;");
    expect(globalsCss).toContain("@media (pointer: coarse), (width <= 30rem) {");
    expect(globalsCss).toMatch(/button,[\s\S]*?summary \{\s*min-block-size: var\(--tap-target\);/);
  });

  it("scrolls the dialog body while heading and footer actions stay outside the scroll region", () => {
    expect(dialog).toContain("footer?: ReactNode");
    expect(dialog).toContain("styles.body");
    expect(dialog).toContain("styles.footer");
    expect(pickerCss).toMatch(/\.dialog \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
    expect(pickerCss).toMatch(/\.body \{[\s\S]*?overflow-y: auto;/);
    expect(pickerCss).toMatch(/\.footer \{[\s\S]*?flex-shrink: 0;/);
    expect(pickerCss).toMatch(/\.footer > button \{[\s\S]*?min-block-size: var\(--tap-target\);/);
  });

  it("gives dialog close and copy controls a full touch target", () => {
    expect(pickerCss).toMatch(/\.heading button \{[\s\S]*?width: var\(--tap-target\);/);
    expect(bridgeCss).toMatch(/\.copyHash \{[\s\S]*?min-block-size: var\(--tap-target\);/);
    expect(bridgeCss).toMatch(
      /\.secondary,[\s\S]*?\.recoveryBody button \{[\s\S]*?min-block-size: var\(--tap-target\);/,
    );
  });

  it("wraps long amounts above the token selector instead of overlapping it", () => {
    expect(bridgeCss).toMatch(/\.amountRow \{[\s\S]*?flex-wrap: wrap;/);
    expect(bridgeCss).toContain("@media (width<=30rem) {");
    expect(bridgeCss).toMatch(
      /@media \(width<=30rem\) \{[\s\S]*?\.amountRow input,[\s\S]*?\.receiveAmount \{[\s\S]*?flex: 1 1 100%;/,
    );
  });

  it("keeps an explicit cancel control beside every review primary action", () => {
    const reviews = bridge.match(/<ReviewDialog/g) ?? [];
    expect(reviews).toHaveLength(2);
    expect(bridge.match(/footer=\{/g) ?? []).toHaveLength(2);
    expect(bridge.match(/>\s*Cancel\s*</g) ?? []).toHaveLength(2);
    expect(picker).toContain("footer?: ReactNode");
  });
});
