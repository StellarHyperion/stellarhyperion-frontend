import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { attributeBundles } from "./bundle-attribution.mjs";
import { emittedClientChunks, moduleSourceAliases } from "./bundle-source-maps.mjs";

const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), ".next");
const diagnostics = path.join(dist, "diagnostics");
try {
  const metadata = JSON.parse(
    await readFile(path.join(diagnostics, "analyze/data/metadata.json"), "utf8"),
  );
  const build = await stat(path.join(dist, "BUILD_ID"));
  if (
    metadata.noMangling !== false ||
    metadata.nextVersion !== require("next/package.json").version ||
    !Number.isFinite(Date.parse(metadata.createdAt)) ||
    Date.parse(metadata.createdAt) < build.mtimeMs
  )
    throw new Error("Analysis does not belong to the current mangled production build.");
  // The exporter can produce partial stdout before failing. Check status before parsing any of it.
  const exported = spawnSync(
    process.execPath,
    [require.resolve("next/dist/bin/next"), "analyze", "export"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (exported.error || exported.status !== 0)
    throw new Error(`Native graph export failed: ${exported.error?.message ?? exported.stderr}`);
  const records = exported.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (records[0]?.snapshot_name !== metadata.name)
    throw new Error("Native graph snapshot does not match current production analysis.");
  const chunks = await emittedClientChunks(path.join(dist, "static/chunks"), records);
  const aliases = await moduleSourceAliases(records);
  const firstLoads = JSON.parse(
    await readFile(path.join(diagnostics, "route-bundle-stats.json"), "utf8"),
  );
  const report = attributeBundles(records, firstLoads, chunks, aliases);
  await writeFile(
    path.join(diagnostics, "bundle-attribution.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  for (const route of report.routes) {
    console.log(`${route.route}: ${route.firstLoadBytes} initial client bytes`);
    for (const category of route.categories) {
      console.log(
        `  ${category.name}: ${category.bytes}/${category.maxBytes} bytes (${category.initialBytes} initial)`,
      );
      for (const chunk of category.chunks) {
        console.log(
          `    ${chunk.filename}: ${chunk.bytes} bytes, ${chunk.initial ? "initial" : "async"}`,
        );
        for (const imported of chunk.imports)
          console.log(
            `      ${imported.package}: ${imported.chain.map(({ path: source, via }, index) => `${index ? ` -${via}-> ` : ""}${source}`).join("")}`,
          );
      }
    }
  }
  for (const total of report.totals)
    console.log(
      `${total.name}: ${total.bytes}/${total.maxBytes} unique client bytes across ${total.chunks} chunks`,
    );
  if (report.errors.length) throw new Error(report.errors.join("\n"));
} catch (error) {
  console.error(
    `Client bundle check failed: ${error.message}\nRun npm run build to produce fresh Turbopack attribution.`,
  );
  process.exitCode = 1;
}
