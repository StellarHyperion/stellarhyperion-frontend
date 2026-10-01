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

const SKIP_DIRS = new Set([".git", ".next", "node_modules", "out", "coverage"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".css", ".json", ".md", ".py", ".svg"]);

/** The only file allowed to contain a raw colour. Everything else reads a custom property. */
const TOKEN_LAYER = join("src", "app", "globals.css");

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
const SHADOW = /\b(box-shadow|drop-shadow|text-shadow)\b/;

for (const file of files) {
  if (file === "package-lock.json") continue;
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const isSelf = file === SELF;
  const isTokenLayer = file === TOKEN_LAYER;
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
      report(file, lineNo, "hex colour outside the token layer", line);
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
console.log(`  token layer: ${TOKEN_LAYER.split(sep).join("/")} is the one file allowed a colour`);
