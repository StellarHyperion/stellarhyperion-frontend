/**
 * The house rules, enforced instead of remembered.
 *
 * Five of this repository's rules are the kind a person follows for a week and then stops
 * following at two in the morning: no hex colour outside the token layer, no box shadow anywhere,
 * no em or en dashes in any file, no emoji, and none of the marketing vocabulary the brief banned.
 * A reviewer cannot hold five greps in their head on every pull request, so the greps live here
 * and run in `npm run check`.
 *
 * Exits non zero with a file, a line and the offending text. No autofix: every one of these wants
 * a human to decide what the sentence should say instead.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SELF = "scripts/house-rules.mjs";

const SKIP_DIRS = new Set([".git", ".next", ".vercel", "node_modules", "out", "coverage"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".css", ".json", ".md", ".py", ".svg"]);

/**
 * The token layer: the only files allowed to contain a raw colour.
 *
 * `globals.css` is the real one. `tokens.ts` exists because the `theme-color` meta tag and the
 * favicon generator both need a literal before any stylesheet is parsed, and every hex in it is
 * checked against the stylesheet below so the exception cannot grow into a second palette.
 */
const TOKEN_CSS = join("src", "app", "globals.css");
const TOKEN_TS = join("src", "app", "tokens.ts");
const TOKEN_LAYER = new Set([TOKEN_CSS, TOKEN_TS]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT)
  .map((f) => relative(ROOT, f))
  .filter((f) => TEXT_EXT.has(f.slice(f.lastIndexOf("."))))
  .sort();

const failures = [];

function report(file, lineNo, rule, text) {
  failures.push({ file, lineNo, rule, text: text.trim().slice(0, 110) });
}

// A checker cannot contain the text it is checking for, so the rules whose patterns spell out the
// banned thing skip this one file. The hex rule does not, because its pattern spells nothing.
const DASHES = /[\u2012\u2013\u2014\u2015]/;
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
const BANNED = [
  /\bseamless(ly)?\b/i,
  /\brobust(ly|ness)?\b/i,
  /\bleverag(e|es|ed|ing)\b/i,
  /\bempower(s|ed|ing|ment)?\b/i,
  /\bunlock(s|ed|ing)?\b/i,
  /\brevolutionary\b/i,
  /\beffortless(ly)?\b/i,
  /\bcomprehensive(ly)?\b/i,
  /\bcutting[\s-]edge\b/i,
  /\bdelv(e|es|ed|ing)\b/i,
  /\belevat(e|es|ed|ing|ion)\b/i,
];

const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{1,5})?\b/;

/**
 * Generated icon assets, which have to carry literal colour and cannot be whitelisted blindly.
 *
 * An SVG favicon is loaded by the browser as an image, outside the document, so it has no access
 * to a custom property. It needs the hex. Exempting it from the rule entirely would open the one
 * hole the rule exists to close, so instead every hex in these files has to appear in the token
 * file that generated them. `npm run icons` rewrites them from the mark and the tokens, and this
 * check is what keeps a hand edit from drifting the tab icon away from the palette.
 */
const GENERATED_ICONS = new Set([join("public", "icon.svg")]);
const SHADOW = /\b(box-shadow|drop-shadow|text-shadow)\b/;

/** Every colour the token layer defines, lowercased, for the generated icon check above. */
const tokenHexes = new Set(
  [...readFileSync(join(ROOT, TOKEN_CSS), "utf8").matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) =>
    m[0].toLowerCase(),
  ),
);

for (const file of files) {
  if (file === "package-lock.json") continue;
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const isSelf = file === SELF;
  const isTokenLayer = TOKEN_LAYER.has(file);
  const isStyle = file.endsWith(".css");
  const isComponent = file.endsWith(".tsx") || file.endsWith(".ts") || file.endsWith(".svg");

  lines.forEach((line, i) => {
    const lineNo = i + 1;

    if (!isSelf) {
      if (DASHES.test(line)) report(file, lineNo, "em or en dash", line);
      if (EMOJI.test(line)) report(file, lineNo, "emoji or glyph arrow", line);
      for (const pattern of BANNED) {
        const hit = pattern.exec(line);
        if (hit) report(file, lineNo, `banned word "${hit[0]}"`, line);
      }
    }

    if (!isSelf && SHADOW.test(line)) report(file, lineNo, "shadow (the plan says zero)", line);

    if (!isTokenLayer && !isSelf && (isStyle || isComponent) && HEX.test(line)) {
      if (GENERATED_ICONS.has(file)) {
        // Checked against the token file rather than waved through.
        const hit = /#[0-9a-fA-F]{3,8}\b/.exec(line);
        if (hit && !tokenHexes.has(hit[0].toLowerCase())) {
          report(file, lineNo, `${hit[0]} is not a token colour; run npm run icons`, line);
        }
      } else {
        report(file, lineNo, "hex colour outside the token layer", line);
      }
    }
  });
}

// The TypeScript side of the token layer is allowed its literals only while they still agree with
// the stylesheet. Two palettes that drift apart is exactly the failure this whole arrangement
// exists to prevent.
{
  const css = readFileSync(join(ROOT, TOKEN_CSS), "utf8").toLowerCase();
  const ts = readFileSync(join(ROOT, TOKEN_TS), "utf8");
  ts.split("\n").forEach((line, i) => {
    const hit = /#[0-9a-fA-F]{3,8}\b/.exec(line);
    if (hit && !css.includes(hit[0].toLowerCase())) {
      report(TOKEN_TS, i + 1, `${hit[0]} is not in ${TOKEN_CSS}`, line);
    }
  });
}

if (failures.length > 0) {
  console.error(`house rules: ${failures.length} problem(s)\n`);
  for (const f of failures) {
    console.error(`  ${f.file}:${f.lineNo}  ${f.rule}\n    ${f.text}`);
  }
  console.error("");
  process.exit(1);
}

console.log(`house rules: ${files.length} files clean (dashes, emoji, vocabulary, shadows, hex)`);
console.log(
  `  token layer: ${[...TOKEN_LAYER].map((f) => f.split(sep).join("/")).join(" and ")}, ` +
    "and their hex values agree",
);
