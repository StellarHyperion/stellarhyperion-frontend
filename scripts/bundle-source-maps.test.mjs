import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { emittedClientChunks, moduleSourceAliases } from "./bundle-source-maps.mjs";

const temporaryDirectories = [];
async function directory() {
  const base = path.join(process.cwd(), ".next");
  await mkdir(base, { recursive: true });
  const created = await mkdtemp(path.join(base, "bundle-map-test-"));
  temporaryDirectories.push(created);
  return created;
}
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((created) => rm(created, { recursive: true, force: true })),
  );
});
const sourceMap = (sources) => ({ version: 3, sources, mappings: "AAAA", names: [] });

describe("emitted production source-map evidence", () => {
  it("follows the emitted JS directive even when the map has a different hashed name", async () => {
    const folder = await directory();
    const code = "export const value=1;\n//# sourceMappingURL=another-hash.js.map\n";
    await writeFile(path.join(folder, "real-chunk.js"), code);
    await writeFile(
      path.join(folder, "another-hash.js.map"),
      JSON.stringify(sourceMap(["turbopack:///[project]/src/app/page.tsx"])),
    );
    const chunks = await emittedClientChunks(folder, []);
    expect(chunks["static/chunks/real-chunk.js"].sources).toEqual(["[project]/src/app/page.tsx"]);
    expect(chunks["static/chunks/real-chunk.js"].bytes).toBe(Buffer.byteLength(code));
  });

  it("rejects missing source maps before any package can be reported as zero", async () => {
    const folder = await directory();
    await writeFile(path.join(folder, "real-chunk.js"), "export const value=1;");
    await expect(emittedClientChunks(folder, [])).rejects.toThrow("Production source map missing");
  });

  it("allows a native not_a_chunk polyfill while retaining its actual bytes", async () => {
    const folder = await directory();
    await writeFile(path.join(folder, "polyfill.js"), "/* compiled framework polyfill */");
    const native = [
      {
        type: "output",
        filename: "[client-fs]/_next/static/chunks/polyfill.js",
        coverage: "not_a_chunk",
      },
    ];
    const chunks = await emittedClientChunks(folder, native);
    expect(chunks["static/chunks/polyfill.js"].generated).toBe(true);
    expect(chunks["static/chunks/polyfill.js"].bytes).toBeGreaterThan(0);
  });

  it("reconstructs upstream original TS and webpack URI aliases exactly", async () => {
    const folder = await directory();
    await writeFile(
      path.join(folder, "compiled.js"),
      "export const value=1;\n//# sourceMappingURL=compiled.js.map",
    );
    await writeFile(
      path.join(folder, "compiled.js.map"),
      JSON.stringify(sourceMap(["original.ts", "webpack://wallet/./src/index.ts"])),
    );
    const key = `[project]/${path.relative(process.cwd(), path.join(folder, "compiled.js"))}`;
    const aliases = await moduleSourceAliases([
      { type: "module", ident: `${key} [app-client]`, path: key },
    ]);
    expect(aliases[key]).toEqual([
      key,
      `[project]/${path.relative(process.cwd(), path.join(folder, "original.ts"))}`,
      "webpack://wallet/./src/index.ts",
    ]);
  });

  it("fails closed on external source-map URLs", async () => {
    const folder = await directory();
    await writeFile(
      path.join(folder, "real-chunk.js"),
      "export const value=1;\n//# sourceMappingURL=https://example.invalid/source.map",
    );
    await expect(emittedClientChunks(folder, [])).rejects.toThrow("Nonlocal source map");
  });
});
