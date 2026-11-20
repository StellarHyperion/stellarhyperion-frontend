import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export function sourceKey(source) {
  const key = decodeURI(source)
    .replace(/^turbopack:\/\/\//, "")
    .replace(/ \[app-client\] \(css module\)$/, "");
  // A generated JSON module embeds its own virtual original-source URL below its module path.
  return key.replace(/(\.json\.\[json\]\.cjs)\/turbopack:\/\/\/.*$/, "$1");
}

function sourcesIn(map, mapDirectory) {
  if (map.version !== 3) throw new Error("Unsupported production source map version.");
  if (Array.isArray(map.sections))
    return map.sections.flatMap(({ map: section }) => sourcesIn(section, mapDirectory));
  if (!Array.isArray(map.sources) || typeof map.mappings !== "string")
    throw new Error("Missing production source map sources or mappings.");
  return map.sources.map((source) => {
    const combined = `${map.sourceRoot ?? ""}${source}`;
    if (/^[a-z][a-z+.-]*:\/\//i.test(combined)) return sourceKey(combined);
    return `[project]/${path.relative(process.cwd(), path.resolve(mapDirectory, combined)).replaceAll("\\", "/")}`;
  });
}

function sourceMapUrl(code) {
  return [...code.matchAll(/\/\/[#@]\s*sourceMappingURL=([^\s]+)/g)].at(-1)?.[1];
}

async function readMap(code, filename) {
  const url = sourceMapUrl(code);
  if (!url) return null;
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const data = url.slice(comma + 1);
    return {
      map: JSON.parse(
        url.slice(0, comma).includes(";base64")
          ? Buffer.from(data, "base64").toString("utf8")
          : decodeURIComponent(data),
      ),
      directory: path.dirname(filename),
    };
  }
  if (/^[a-z][a-z+.-]*:/i.test(url)) throw new Error(`Nonlocal source map: ${filename}`);
  const mapFile = path.resolve(path.dirname(filename), decodeURIComponent(url));
  if (!mapFile.startsWith(`${process.cwd()}${path.sep}`))
    throw new Error(`Source map escapes project: ${filename}`);
  return { map: JSON.parse(await readFile(mapFile, "utf8")), directory: path.dirname(mapFile) };
}

// Upstream packages map compiled JS to original TS or webpack URLs. Reconstruct that exact
// relationship rather than guessing package ownership from those flattened original paths.
export async function moduleSourceAliases(records) {
  const aliases = {};
  for (const graphModule of records) {
    if (graphModule.type !== "module" || !graphModule.ident.includes("[app-client]")) continue;
    const key = sourceKey(graphModule.path);
    if (aliases[key]) continue;
    aliases[key] = [key];
    if (!key.startsWith("[project]/")) continue;
    const filename = path.resolve(process.cwd(), key.slice("[project]/".length));
    if (!filename.startsWith(`${process.cwd()}${path.sep}`))
      throw new Error(`Module escapes project: ${key}`);
    let code;
    try {
      code = await readFile(filename, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const mapped = await readMap(code, filename);
    if (mapped) aliases[key].push(...sourcesIn(mapped.map, mapped.directory));
  }
  return aliases;
}

export async function emittedClientChunks(directory, records) {
  const chunks = {};
  const generated = new Set(
    records
      .filter(
        (record) =>
          record.type === "output" &&
          record.coverage === "not_a_chunk" &&
          record.filename.startsWith("[client-fs]/_next/static/chunks/"),
      )
      .map((record) => record.filename.slice("[client-fs]/_next/".length)),
  );
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(filename);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const mapped = await readMap(await readFile(filename, "utf8"), filename);
      const key = `static/chunks/${path.relative(directory, filename).replaceAll("\\", "/")}`;
      if (!mapped && !generated.has(key))
        throw new Error(`Production source map missing: ${filename}`);
      chunks[key] = {
        bytes: (await stat(filename)).size,
        sources: mapped ? sourcesIn(mapped.map, mapped.directory) : [],
        mappings: mapped?.map.mappings ?? "",
        generated: generated.has(key),
      };
    }
  }
  await walk(directory);
  return chunks;
}
