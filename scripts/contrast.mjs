/**
 * The accessibility claim, measured rather than asserted.
 *
 * The palette is locked by `.planning/DESIGN-TOKENS.md` and is not up for negotiation. What is up
 * for negotiation is which locked colour does which job, and that is the only lever available when
 * a rolled value does not clear WCAG AA. So this file holds the role table: every colour, the
 * background steps it is allowed to sit on, and the ratio that role has to clear. It prints the
 * measured numbers and exits non zero if any role falls short.
 *
 * One role was reassigned because of what this script measured. `--fg-3` is 4.01:1 on `--ink`,
 * which clears the 3.00 bar for a graphic and misses the 4.50 bar for text. The plan puts it on
 * 11px mono data labels. Those labels are text, so they use `--fg-2` at 7.57:1 instead, and
 * `--fg-3` keeps the jobs where 3.00 is the real bar: the dotted losing tracks in the switchyard,
 * and tick marks. The palette is untouched; only the job changed.
 *
 * Thresholds are WCAG 2.2: 4.50 for normal text, 3.00 for large text (at least 24px, or 18.66px
 * bold) and for non text contrast on a graphic or a focus indicator.
 */

/** Exactly the values in `.planning/DESIGN-TOKENS.md`, which is the only reason this file has any. */
const TOKEN = {
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

const TEXT = 4.5;
const LARGE = 3.0;
const GRAPHIC = 3.0;

const STEPS = ["ink", "ink-2", "ink-3", "ink-4"];

/**
 * Every role the stylesheet actually uses, with the surfaces it is allowed to appear on.
 *
 * A colour missing a background step from its list is not an oversight. `bad` is absent from
 * `ink-4` because it measures 4.17:1 there, so an error message never sits in an input well.
 */
const ROLES = [
  { role: "body and display text", fg: "fg", on: STEPS, need: TEXT },
  { role: "secondary prose", fg: "fg-2", on: STEPS, need: TEXT },
  { role: "mono data labels and annotations", fg: "fg-2", on: STEPS, need: TEXT },
  { role: "origin leg accent text", fg: "copper", on: STEPS, need: TEXT },
  { role: "origin leg hover text", fg: "copper-2", on: STEPS, need: TEXT },
  { role: "destination leg accent text", fg: "instr", on: STEPS, need: TEXT },
  { role: "settled state text", fg: "ok", on: STEPS, need: TEXT },
  { role: "caution state text", fg: "warn", on: STEPS, need: TEXT },
  { role: "failure state text", fg: "bad", on: ["ink", "ink-2", "ink-3"], need: TEXT },
  { role: "losing track stroke and tick marks", fg: "fg-3", on: STEPS, need: GRAPHIC },
  { role: "focus ring on the page", fg: "copper", on: ["ink", "ink-2"], need: GRAPHIC },
  { role: "focus ring on a control", fg: "copper", on: ["ink-3", "ink-4"], need: GRAPHIC },
  { role: "winning track, origin end", fg: "copper", on: ["ink-2"], need: GRAPHIC },
  { role: "winning track, destination end", fg: "instr", on: ["ink-2"], need: GRAPHIC },
  { role: "large display numerals", fg: "fg-2", on: STEPS, need: LARGE },
];

const channel = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function luminance(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = channel(((n >> 16) & 255) / 255);
  const g = channel(((n >> 8) & 255) / 255);
  const b = channel((n & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(TOKEN[a]), luminance(TOKEN[b])].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const rows = [];
const failed = [];

for (const { role, fg, on, need } of ROLES) {
  for (const bg of on) {
    const measured = ratio(fg, bg);
    const ok = measured >= need;
    rows.push({ role, fg, bg, need, measured, ok });
    if (!ok) failed.push({ role, fg, bg, need, measured });
  }
}

const width = Math.max(...rows.map((r) => r.role.length));
console.log("WCAG 2.2 contrast over the locked Hyperion palette\n");
for (const r of rows) {
  const verdict = r.ok ? "pass" : "FAIL";
  console.log(
    `  ${r.role.padEnd(width)}  ${`--${r.fg}`.padEnd(11)} on ${`--${r.bg}`.padEnd(7)} ` +
      `${r.measured.toFixed(2).padStart(6)} : 1  needs ${r.need.toFixed(2)}  ${verdict}`,
  );
}

console.log("");
if (failed.length > 0) {
  console.error(
    `${failed.length} role(s) below the bar. Reassign the role, do not re-roll the palette.`,
  );
  process.exit(1);
}
console.log(`${rows.length} role and surface pairs, all at or above their bar.`);
