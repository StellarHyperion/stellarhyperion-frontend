import { sourceKey } from "./bundle-source-maps.mjs";

export const budgets = [
  {
    name: "wallet adapters",
    packages: [
      "@stellar/freighter-api",
      "@albedo-link/intent",
      "@creit.tech/xbull-wallet-connect",
      "@lobstrco/signer-extension-api",
    ],
    maxBytes: 450_000,
  },
  {
    name: "transaction code",
    packages: ["@stellar/stellar-sdk", "@hyperion/protocol"],
    maxBytes: 1_200_000,
  },
];

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Bundle attribution is incomplete: ${message}`);
}

export function clientChunk(filename) {
  requireEvidence(typeof filename === "string", "invalid output filename");
  const normalized = filename.replaceAll("\\", "/");
  if (!normalized.includes("static/chunks/") || !normalized.endsWith(".js")) return null;
  const result = normalized.slice(normalized.indexOf("static/chunks/"));
  requireEvidence(!result.split("/").includes(".."), "output path traversal");
  return result;
}

function packageOf(modulePath, budget) {
  return budget.packages.find((name) =>
    modulePath.replaceAll("\\", "/").includes(`node_modules/${name}/`),
  );
}

function importChains(roots, modules) {
  const chains = new Map(roots.map((ident) => [ident, [{ ident, via: "client-reference" }]]));
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    const ident = queue[index];
    for (const kind of ["sync", "async"])
      for (const next of modules.get(ident).dependencies[kind]) {
        if (chains.has(next)) continue;
        chains.set(next, [...chains.get(ident), { ident: next, via: kind }]);
        queue.push(next);
      }
  }
  return chains;
}

// Actual source maps supply chunk membership. The native graph supplies route entries and
// importer edges; its independently materialized chunk filenames cannot substitute for output.
export function attributeBundles(records, firstLoads, emittedChunks, aliases = {}) {
  requireEvidence(Array.isArray(records) && records[0]?.type === "meta", "missing graph header");
  const meta = records[0];
  requireEvidence(
    meta.schema_version === 1 &&
      typeof meta.module_index_hash === "string" &&
      meta.module_index_hash,
    "unsupported graph schema or missing module fingerprint",
  );
  requireEvidence(
    meta.route_count > 0 && meta.selected_routes === meta.route_count,
    "the graph must include every route",
  );
  const modules = new Map();
  const routes = new Map();
  const nativeOutputs = new Map();
  const sourceModules = new Map();
  for (const record of records.slice(1)) {
    if (record.type === "module") {
      requireEvidence(
        typeof record.ident === "string" &&
          typeof record.path === "string" &&
          record.path &&
          !modules.has(record.ident),
        "invalid or duplicate module",
      );
      modules.set(record.ident, record);
      if (record.ident.includes("[app-client]"))
        for (const source of aliases[sourceKey(record.path)] ?? [sourceKey(record.path)]) {
          if (!sourceModules.has(source)) sourceModules.set(source, new Set());
          sourceModules.get(source).add(record.ident);
        }
    } else if (record.type === "route") {
      requireEvidence(
        typeof record.route === "string" && !routes.has(record.route),
        "duplicate route",
      );
      requireEvidence(
        record.coverage?.entries === "exact" &&
          record.coverage?.groups === "exact" &&
          Array.isArray(record.entries) &&
          record.entries.length > 0,
        `missing route coverage for ${record.route}`,
      );
      routes.set(record.route, { ...record, groups: [] });
    } else if (record.type === "output") {
      requireEvidence(routes.has(record.route), `output has no route: ${record.route}`);
      requireEvidence(
        Array.isArray(record.modules) &&
          Array.isArray(record.async_loaders) &&
          ["exact", "not_a_chunk", "unsupported"].includes(record.coverage),
        `missing output coverage: ${record.filename}`,
      );
      for (const ident of [...record.modules, ...record.async_loaders])
        requireEvidence(modules.has(ident), `unjoined output module: ${ident}`);
      const filename = clientChunk(record.filename);
      if (filename) {
        requireEvidence(
          record.coverage !== "unsupported" &&
            (record.coverage !== "not_a_chunk" ||
              (record.modules.length === 0 && record.async_loaders.length === 0)),
          `missing client membership: ${record.route} ${filename}`,
        );
        if (!nativeOutputs.has(filename)) nativeOutputs.set(filename, record);
        else
          requireEvidence(
            JSON.stringify(nativeOutputs.get(filename).modules) === JSON.stringify(record.modules),
            `inconsistent native membership: ${filename}`,
          );
      }
    } else if (record.type === "group") {
      const route = routes.get(record.route);
      requireEvidence(
        route &&
          ["bootstrap", "render_dependent", "async"].includes(record.kind) &&
          Array.isArray(record.outputs),
        `missing group coverage: ${record.route}`,
      );
      if (record.trigger_join === "joined")
        requireEvidence(
          modules.has(record.trigger_module_ident),
          `unjoined group trigger: ${record.route}`,
        );
      route.groups.push(record);
    } else requireEvidence(record.type === "part", `unknown record: ${record.type}`);
  }
  requireEvidence(routes.size === meta.route_count && modules.size > 0, "truncated graph");
  for (const graphModule of modules.values())
    for (const kind of ["sync", "async", "traced"]) {
      requireEvidence(
        Array.isArray(graphModule.dependencies?.[kind]),
        `missing ${kind} edges: ${graphModule.path}`,
      );
      for (const ident of graphModule.dependencies[kind])
        requireEvidence(modules.has(ident), `unjoined dependency: ${ident}`);
    }
  const chunkModules = new Map();
  requireEvidence(Object.keys(emittedChunks).length > 0, "no emitted client chunks");
  for (const [filename, chunk] of Object.entries(emittedChunks)) {
    requireEvidence(
      Number.isSafeInteger(chunk.bytes) && chunk.bytes > 0 && Array.isArray(chunk.sources),
      `missing actual client bytes or source map: ${filename}`,
    );
    const membership = new Set();
    for (const source of chunk.sources) {
      if (source.startsWith("[turbopack]/")) continue;
      requireEvidence(sourceModules.has(source), `unjoined emitted source: ${filename} ${source}`);
      for (const ident of sourceModules.get(source)) membership.add(ident);
    }
    if (!chunk.sources.length) {
      const native = nativeOutputs.get(filename);
      requireEvidence(
        native && native.coverage !== "unsupported",
        `empty source map has no exact native join: ${filename}`,
      );
      for (const ident of native.modules) membership.add(ident);
    }
    chunkModules.set(filename, membership);
  }
  requireEvidence(
    Array.isArray(firstLoads) && firstLoads.some(({ route }) => route === "/"),
    "landing first-load manifest missing",
  );
  const firstLoadByRoute = new Map(firstLoads.map((entry) => [entry.route, entry]));
  requireEvidence(firstLoadByRoute.size === firstLoads.length, "duplicate first-load route");
  for (const firstLoad of firstLoads)
    requireEvidence(
      routes.has(firstLoad.route),
      `first-load route absent from graph: ${firstLoad.route}`,
    );
  const errors = [];
  const reports = [];
  const globalChunks = budgets.map(() => new Map());
  const attributed = new Set();
  for (const route of routes.values()) {
    const roots = new Set();
    for (const entry of route.entries) {
      requireEvidence(
        modules.has(entry.module_ident) &&
          modules.get(entry.module_ident).path === entry.module_path,
        `unjoined route entry: ${route.route}`,
      );
      if (entry.entry_kind === "client_bootstrap") roots.add(entry.module_ident);
      for (const reference of entry.client_references ?? []) {
        requireEvidence(
          modules.has(reference.module_ident) &&
            modules.get(reference.module_ident).path === reference.module_path,
          `unjoined client reference: ${route.route}`,
        );
        roots.add(reference.module_ident);
      }
    }
    if (!roots.size) continue; // API routes have no client entry.
    requireEvidence(route.groups.length > 0, `missing route chunk groups: ${route.route}`);
    const chains = importChains([...roots], modules);
    const firstLoad = firstLoadByRoute.get(route.route);
    // The internal global error route is analyzed but does not have a navigation first-load entry.
    requireEvidence(
      firstLoad || route.route === "/_global-error",
      `missing first-load route: ${route.route}`,
    );
    const initial = new Set(firstLoad?.firstLoadChunkPaths.map(clientChunk) ?? []);
    requireEvidence(!initial.has(null), `invalid first-load client path: ${route.route}`);
    if (firstLoad) requireEvidence(initial.size > 0, `missing first-load paths: ${route.route}`);
    for (const filename of initial)
      requireEvidence(
        chunkModules.has(filename),
        `initial chunk absent from output: ${route.route} ${filename}`,
      );
    const initialBytes = [...initial].reduce(
      (sum, filename) => sum + emittedChunks[filename].bytes,
      0,
    );
    if (firstLoad)
      requireEvidence(
        initialBytes === firstLoad.firstLoadUncompressedJsBytes,
        `first-load bytes disagree: ${route.route}`,
      );
    const categories = budgets.map((budget, budgetIndex) => {
      const chunks = [];
      for (const [filename, membership] of chunkModules) {
        const reachable = [...membership].filter((ident) => chains.has(ident));
        if (!reachable.length && !initial.has(filename)) continue;
        attributed.add(filename);
        const witnesses = new Map();
        for (const ident of membership) {
          const name = packageOf(modules.get(ident).path, budget);
          if (!name) continue;
          // Shared chunks can contain a module without an import edge from this route. Report
          // the real loading chain and the explicit chunk co-location instead of dropping it.
          const chain =
            chains.get(ident) ??
            (reachable.length ? [...chains.get(reachable[0]), { ident, via: "same-chunk" }] : null);
          requireEvidence(
            chain,
            `missing import chain: ${route.route} ${filename} ${modules.get(ident).path}`,
          );
          if (!witnesses.has(name) || witnesses.get(name).length > chain.length)
            witnesses.set(name, chain);
        }
        if (!witnesses.size) continue;
        const chunk = {
          filename,
          bytes: emittedChunks[filename].bytes,
          initial: initial.has(filename),
          imports: [...witnesses].map(([name, chain]) => ({
            package: name,
            chain: chain.map(({ ident, via }) => ({ path: modules.get(ident).path, via })),
          })),
        };
        chunks.push(chunk);
        globalChunks[budgetIndex].set(filename, chunk.bytes);
        if (route.route === "/" && budgetIndex === 0 && chunk.initial)
          errors.push(`Wallet adapter loaded on landing: ${filename}`);
      }
      return {
        name: budget.name,
        maxBytes: budget.maxBytes,
        bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
        initialBytes: chunks
          .filter((chunk) => chunk.initial)
          .reduce((sum, chunk) => sum + chunk.bytes, 0),
        chunks,
      };
    });
    reports.push({
      route: route.route,
      firstLoadBytes: firstLoad ? initialBytes : null,
      categories,
    });
  }
  for (const [filename, membership] of chunkModules)
    requireEvidence(
      !membership.size || attributed.has(filename),
      `emitted chunk has no route import chain: ${filename}`,
    );
  const totals = budgets.map((budget, index) => {
    const bytes = [...globalChunks[index].values()].reduce((sum, size) => sum + size, 0);
    requireEvidence(bytes > 0, `no ${budget.name} attribution across application routes`);
    if (bytes > budget.maxBytes)
      errors.push(`${budget.name} client budget exceeded: ${bytes} > ${budget.maxBytes}`);
    return {
      name: budget.name,
      bytes,
      maxBytes: budget.maxBytes,
      chunks: globalChunks[index].size,
    };
  });
  return {
    schemaVersion: 1,
    moduleIndexHash: meta.module_index_hash,
    measurement:
      "uncompressed complete emitted client chunks; source map membership; native import chains; deduplicated across routes",
    routes: reports,
    totals,
    errors,
  };
}
