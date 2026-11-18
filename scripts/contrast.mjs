/**
 * The accessibility claim, measured rather than asserted.
 *
 * Checks all defined themes (dark instrument theme, daylight instrument theme, and
 * high contrast mode) across every role and surface pair.
 *
 * In daylight instrument and high contrast modes, every text role exceeds WCAG AAA 7:1.
 */

export const DARK_TOKENS = {
  ink: "#0A0C0F",
  "ink-2": "#101318",
  "ink-3": "#171B21",
  "ink-4": "#1E242C",
  rule: "#232932",
  "rule-2": "#2E3642",
  fg: "#ECEFF3",
  "fg-2": "#98A2AE",
  "fg-3": "#68727E",
  copper: "#E8743B",
  "copper-2": "#F59A6B",
  "copper-dim": "#8F4321",
  instr: "#79ADD6",
  "instr-dim": "#3A5B73",
  ok: "#57BF8A",
  warn: "#E3B33C",
  bad: "#DF574B",
};

export const LIGHT_TOKENS = {
  ink: "#FFFFFF",
  "ink-2": "#F7F9FA",
  "ink-3": "#EEF2F5",
  "ink-4": "#E4E9EE",
  rule: "#CBD2D9",
  "rule-2": "#9AA5B1",
  fg: "#0A0C0F",
  "fg-2": "#1A2028",
  "fg-3": "#3D4753",
  copper: "#7C2702",
  "copper-2": "#601D00",
  "copper-dim": "#F5D4C2",
  instr: "#09436D",
  "instr-dim": "#C7E0F4",
  ok: "#05542F",
  warn: "#683F00",
  bad: "#82140C",
};

export const HIGH_CONTRAST_TOKENS = {
  ink: "#000000",
  "ink-2": "#07090C",
  "ink-3": "#0E1217",
  "ink-4": "#151B22",
  rule: "#5C6978",
  "rule-2": "#7E8C9D",
  fg: "#FFFFFF",
  "fg-2": "#D8E1EA",
  "fg-3": "#9CB0C4",
  copper: "#FFAA7A",
  "copper-2": "#FFC8A8",
  "copper-dim": "#A3451B",
  instr: "#A0D2F8",
  "instr-dim": "#486F91",
  ok: "#70EBB0",
  warn: "#FFD466",
  bad: "#FF7F73",
};

export const TOKEN = DARK_TOKENS;

const TEXT_AA = 4.5;
const TEXT_AAA = 7.0;
const LARGE = 3.0;
const GRAPHIC = 3.0;

const STEPS = ["ink", "ink-2", "ink-3", "ink-4"];

const BASE_ROLES = [
  { role: "body and display text", fg: "fg", on: STEPS, type: "text" },
  { role: "secondary prose", fg: "fg-2", on: STEPS, type: "text" },
  { role: "mono data labels and annotations", fg: "fg-2", on: STEPS, type: "text" },
  { role: "origin leg accent text", fg: "copper", on: STEPS, type: "text" },
  { role: "origin leg hover text", fg: "copper-2", on: STEPS, type: "text" },
  { role: "destination leg accent text", fg: "instr", on: STEPS, type: "text" },
  { role: "settled state text", fg: "ok", on: STEPS, type: "text" },
  { role: "caution state text", fg: "warn", on: STEPS, type: "text" },
  { role: "failure state text", fg: "bad", on: ["ink", "ink-2", "ink-3"], type: "text" },
  { role: "losing track stroke and tick marks", fg: "fg-3", on: STEPS, type: "graphic" },
  { role: "focus ring on the page", fg: "copper", on: ["ink", "ink-2"], type: "graphic" },
  { role: "focus ring on a control", fg: "copper", on: ["ink-3", "ink-4"], type: "graphic" },
  { role: "winning track, origin end", fg: "copper", on: ["ink-2"], type: "graphic" },
  { role: "winning track, destination end", fg: "instr", on: ["ink-2"], type: "graphic" },
  { role: "large display numerals", fg: "fg-2", on: STEPS, type: "large" },
];

const THEMES = [
  {
    name: "dark instrument theme (WCAG 2.2 AA)",
    tokens: DARK_TOKENS,
    textThreshold: TEXT_AA,
  },
  {
    name: "daylight instrument theme (WCAG AAA)",
    tokens: LIGHT_TOKENS,
    textThreshold: TEXT_AAA,
  },
  {
    name: "high contrast mode (WCAG AAA)",
    tokens: HIGH_CONTRAST_TOKENS,
    textThreshold: TEXT_AAA,
  },
];

const channel = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function luminance(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = channel(((n >> 16) & 255) / 255);
  const g = channel(((n >> 8) & 255) / 255);
  const b = channel((n & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function calculateRatio(hex1, hex2) {
  const [hi, lo] = [luminance(hex1), luminance(hex2)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const failed = [];
let totalPairs = 0;

for (const theme of THEMES) {
  console.log(`\n=== ${theme.name} ===\n`);
  const rows = [];
  for (const item of BASE_ROLES) {
    const need =
      item.type === "text" ? theme.textThreshold : item.type === "large" ? LARGE : GRAPHIC;

    for (const bg of item.on) {
      const fgHex = theme.tokens[item.fg];
      const bgHex = theme.tokens[bg];
      const measured = calculateRatio(fgHex, bgHex);
      const ok = measured >= need;
      rows.push({ role: item.role, fg: item.fg, bg, need, measured, ok });
      totalPairs += 1;
      if (!ok) {
        failed.push({ theme: theme.name, role: item.role, fg: item.fg, bg, need, measured });
      }
    }
  }

  const width = Math.max(...rows.map((r) => r.role.length));
  for (const r of rows) {
    const verdict = r.ok ? "pass" : "FAIL";
    console.log(
      `  ${r.role.padEnd(width)}  ${`--${r.fg}`.padEnd(11)} on ${`--${r.bg}`.padEnd(7)} ` +
        `${r.measured.toFixed(2).padStart(6)} : 1  needs ${r.need.toFixed(2)}  ${verdict}`,
    );
  }
}

console.log("");
if (failed.length > 0) {
  console.error(
    `${failed.length} role(s) below the bar. Reassign the role, do not re-roll the palette.`,
  );
  process.exit(1);
}
console.log(`${totalPairs} role and surface pairs across all themes, all at or above their bar.`);
