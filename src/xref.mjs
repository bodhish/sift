// Cross-reference index for a PR: who imports whom, which symbols, and where they're used.
// Regex-based on purpose: fast, dependency-free, and good enough for review navigation.
import fs from "node:fs/promises";
import path from "node:path";
import * as gh from "./github.mjs";

const SRC_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const RESOLVE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".d.ts", ".json"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];
const STOP_TOKENS = new Set(["index", "types", "type", "utils", "util", "common", "page", "pages", "spec", "test", "tests", "component", "components", "helper", "helpers", "form", "forms", "list", "card", "sheet", "view", "views", "main", "base", "data", "hook", "hooks", "editor", "detail", "details", "item", "items", "panel", "layout", "facility", "patient", "encounter"]);

const IMPORT_FROM_RE = /^[ \t]*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*["']([^"']+)["']/gm;
const IMPORT_SIDE_RE = /^[ \t]*import\s*["']([^"']+)["']/gm;
const IMPORT_DYN_RE = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;
const EXPORT_DECL_RE = /^[ \t]*export\s+(?:declare\s+)?(?:async\s+)?(const|let|var|function\*?|class|type|interface|enum|abstract\s+class|namespace)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_DEFAULT_RE = /^[ \t]*export\s+default\s+(?:async\s+)?(?:(function\*?|class)\s*([A-Za-z_$][\w$]*)?|([A-Za-z_$][\w$]*)\s*;?\s*$|)/gm;
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;
const TESTID_USE_RE = /getByTestId\(\s*["']([^"']+)["']|data-(?:testid|cy)=["']([^"']+)["']|\[data-(?:testid|cy)=["']?([^"'\]]+)["']?\]/g;
const TESTID_DEF_RE = /data-(?:testid|cy)=(?:["']([^"']+)["']|\{["']([^"']+)["']\})/g;
const TEST_TEXT_RE = /\b(?:getByRole\([^)]*?name:\s*|getByText\(\s*|getByLabel\(\s*|getByPlaceholder\(\s*|getByTitle\(\s*|getByAltText\(\s*)["']([^"']{3,80})["']/g;
const I18N_USE_RE = /\bt\(\s*["']([a-zA-Z0-9_.:-]+)["']/g;

const GRAPH_VERSION = 2;

export class Xref {
  constructor(store) {
    this.store = store;
    this.graphPath = path.join(store.dir, "graph.json");
    this.graph = null;
    this.contents = new Map();
    this.tree = null; // Set of repo paths at head
    this.treeShas = null; // path -> blob sha
    this.building = null;
    this.progress = { phase: "idle", done: 0, total: 0 };
  }

  get headSha() {
    return this.store.state.pr?.headSha || null;
  }
  get ready() {
    return Boolean(this.graph && this.graph.headSha === this.headSha);
  }
  status() {
    return { ready: this.ready, building: Boolean(this.building), progress: this.progress, builtAt: this.graph?.builtAt || null, files: this.graph ? Object.keys(this.graph.files).length : 0 };
  }

  async load() {
    try {
      const g = JSON.parse(await fs.readFile(this.graphPath, "utf8"));
      if (g.headSha === this.headSha && g.version === GRAPH_VERSION) this.graph = g;
    } catch {}
    return this;
  }

  /** Build (or rebuild) the index. Safe to call concurrently; later callers await the same build. */
  build({ onProgress = () => {} } = {}) {
    if (this.building) return this.building;
    this.building = this._build(onProgress).finally(() => {
      this.building = null;
    });
    return this.building;
  }

  async _build(onProgress) {
    const store = this.store;
    const files = Object.values(store.files);
    const headSha = this.headSha;
    const report = (phase, done, total) => {
      this.progress = { phase, done, total };
      onProgress(this.progress);
    };

    report("tree", 0, 1);
    await this.loadTree().catch(() => {});
    const aliases = await this.loadAliases().catch(() => defaultAliases());
    report("tree", 1, 1);

    // 1. contents (new side) for every non-removed file
    const live = files.filter((f) => f.status !== "removed");
    report("content", 0, live.length);
    let done = 0;
    await pool(live, 8, async (f) => {
      try {
        this.contents.set(f.path, await this.newContent(f));
      } catch {
        this.contents.set(f.path, "");
      }
      report("content", ++done, live.length);
    });

    // 2. parse
    report("parse", 0, live.length);
    const prSet = new Set(files.map((f) => f.path));
    const parsed = {};
    for (const f of live) {
      const text = this.contents.get(f.path) || "";
      parsed[f.path] = isSource(f.path) ? parseSource(f.path, text) : { imports: [], exports: [], testIds: [], testTexts: [], i18nKeys: [], testIdDefs: [] };
    }
    report("parse", live.length, live.length);

    // 3. resolve + reverse index
    const resolve = (from, spec) => resolveSpec(from, spec, aliases, prSet, this.tree);
    const usedBy = {};
    for (const [p, info] of Object.entries(parsed)) {
      for (const imp of info.imports) {
        imp.target = resolve(p, imp.spec);
        if (imp.target.kind === "pr") {
          (usedBy[imp.target.path] ||= []).push({ from: p, names: imp.names.map((n) => n.local || n.imported), imported: imp.names.map((n) => n.imported), line: imp.line, kind: imp.kind });
        }
      }
    }

    // 4. former importers of removed files (from deleted import lines in other files' patches)
    const formerImporters = {};
    for (const f of files) {
      if (!f.patch) continue;
      for (const m of f.patch.matchAll(/^-[ \t]*(?:import|export)\b[^'"\n]*?["']([^"']+)["']/gm)) {
        const t = resolve(f.path, m[1]);
        if (t.kind === "pr" && store.files[t.path]?.status === "removed") (formerImporters[t.path] ||= new Set()).add(f.path);
      }
    }

    // 5. tests ↔ sources via i18n text, test ids and name tokens
    const i18n = await this.loadI18n().catch(() => null);
    const tests = {};
    const testFiles = live.filter((f) => isTest(f.path));
    const srcFiles = live.filter((f) => !isTest(f.path) && isSource(f.path));
    const srcIds = new Map(srcFiles.map((f) => [f.path, new Set(parsed[f.path].testIdDefs)]));
    const srcKeys = new Map(srcFiles.map((f) => [f.path, new Set(parsed[f.path].i18nKeys)]));
    const srcTokens = new Map(srcFiles.map((f) => [f.path, tokensOf(f.path)]));
    for (const t of testFiles) {
      const info = parsed[t.path];
      const keys = new Set();
      if (i18n) for (const txt of info.testTexts) for (const k of i18n.get(normText(txt)) || []) keys.add(k);
      const ids = new Set(info.testIds);
      const toks = tokensOf(t.path);
      for (const s of srcFiles) {
        let via = null;
        let count = 0;
        const sharedIds = [...ids].filter((x) => srcIds.get(s.path).has(x));
        const sharedKeys = [...keys].filter((x) => srcKeys.get(s.path).has(x));
        const sharedToks = [...toks].filter((x) => srcTokens.get(s.path).has(x));
        if (sharedIds.length) {
          via = "testid";
          count = sharedIds.length;
        } else if (sharedKeys.length >= 2 || (sharedKeys.length === 1 && sharedToks.length)) {
          via = "text";
          count = sharedKeys.length;
        } else if (sharedToks.some((x) => x.length >= 6) || sharedToks.length >= 2) {
          via = "name";
          count = sharedToks.length;
        }
        if (via) (tests[s.path] ||= []).push({ test: t.path, via, count, keys: sharedKeys.slice(0, 6), ids: sharedIds.slice(0, 6) });
      }
    }
    const strength = { testid: 3, text: 2, name: 1 };
    for (const arr of Object.values(tests)) arr.sort((a, b) => strength[b.via] - strength[a.via] || b.count - a.count);

    this.graph = {
      version: GRAPH_VERSION,
      headSha,
      builtAt: new Date().toISOString(),
      aliases,
      treeLoaded: Boolean(this.tree),
      files: Object.fromEntries(Object.entries(parsed).map(([p, i]) => [p, { exports: i.exports, imports: i.imports }])),
      usedBy,
      formerImporters: Object.fromEntries(Object.entries(formerImporters).map(([k, v]) => [k, [...v]])),
      tests,
    };
    await fs.writeFile(this.graphPath, JSON.stringify(this.graph));
    report("ready", 1, 1);
    return this.status();
  }

  /** Ensure contents are in memory (after a restart the graph loads from disk but contents don't). */
  async ensureContents() {
    if (this.contents.size) return;
    const live = Object.values(this.store.files).filter((f) => f.status !== "removed");
    await pool(live, 8, async (f) => {
      try {
        this.contents.set(f.path, await this.newContent(f));
      } catch {
        this.contents.set(f.path, "");
      }
    });
  }

  async newContent(f) {
    // Prefer the cached blob; added files can be rebuilt from their patch without a network call.
    try {
      return await fs.readFile(path.join(this.store.blobDir, f.sha), "utf8");
    } catch {}
    if (f.status === "added" && f.patch) {
      return f.patch
        .split("\n")
        .filter((l) => l.startsWith("+"))
        .map((l) => l.slice(1))
        .join("\n");
    }
    return this.store.headContent(f);
  }

  async loadTree() {
    const sha = this.headSha;
    const cache = path.join(this.store.dir, `tree-${sha}.json`);
    let entries;
    try {
      entries = JSON.parse(await fs.readFile(cache, "utf8"));
    } catch {
      const res = await gh.api(`repos/${this.store.ref.owner}/${this.store.ref.repo}/git/trees/${sha}?recursive=1`);
      entries = (res.tree || []).filter((e) => e.type === "blob").map((e) => [e.path, e.sha]);
      await fs.writeFile(cache, JSON.stringify(entries));
    }
    this.tree = new Set(entries.map((e) => e[0]));
    this.treeShas = new Map(entries);
  }

  async loadAliases() {
    const text = await this.repoFile("tsconfig.json");
    if (!text) return defaultAliases();
    const json = JSON.parse(stripJsonComments(text));
    const paths = json?.compilerOptions?.paths || {};
    const out = [];
    for (const [k, v] of Object.entries(paths)) {
      const target = String((Array.isArray(v) ? v[0] : v) || "").replace(/^\.\//, "");
      if (!target) continue;
      if (k.endsWith("/*")) out.push({ prefix: k.slice(0, -1), replace: target.replace(/\*$/, "") });
      else out.push({ exact: k, replace: target });
    }
    if (!out.some((a) => a.prefix === "@/")) out.push({ prefix: "@/", replace: "src/" });
    return out;
  }

  async loadI18n() {
    const candidates = ["public/locale/en.json", "src/locale/en.json", "public/locales/en.json"];
    for (const p of candidates) {
      const text = this.contents.get(p) || (await this.repoFile(p));
      if (!text) continue;
      const map = new Map();
      const walk = (obj, prefix) => {
        for (const [k, v] of Object.entries(obj)) {
          const key = prefix ? `${prefix}.${k}` : k;
          if (typeof v === "string") {
            const n = normText(v);
            if (n.length >= 3) (map.get(n) || map.set(n, []).get(n)).push(key);
          } else if (v && typeof v === "object") walk(v, key);
        }
      };
      try {
        walk(JSON.parse(text), "");
        return map;
      } catch {}
    }
    return null;
  }

  /** Content of any file at head: PR files from the index, others from the repo tree. */
  async repoFile(p) {
    if (this.contents.has(p)) return this.contents.get(p);
    const f = this.store.files[p];
    if (f && f.status !== "removed") return this.newContent(f);
    if (!this.tree) await this.loadTree().catch(() => {});
    const sha = this.treeShas?.get(p);
    if (!sha) return null;
    return this.store.blob(sha);
  }

  usageLines(fromPath, names, importLine, max = 6) {
    const text = this.contents.get(fromPath);
    if (!text || !names.length) return [];
    const lines = text.split("\n");
    const res = [];
    const re = new RegExp(`\\b(${names.map(escapeRe).join("|")})\\b`);
    for (let i = 0; i < lines.length && res.length < max; i++) {
      const n = i + 1;
      if (importLine && n >= importLine.start && n <= importLine.end) continue;
      if (/^\s*(import|export)\b.*\bfrom\b/.test(lines[i])) continue;
      if (re.test(lines[i])) res.push({ line: n, text: lines[i].trim().slice(0, 140) });
    }
    return res;
  }

  async related(p) {
    const store = this.store;
    const g = this.graph;
    if (!g) return { status: "building" };
    await this.ensureContents();
    const f = store.files[p];
    if (!f) throw new Error(`Unknown file ${p}`);
    const summary = (q) => (store.files[q] ? store.fileSummary(q) : null);
    const node = g.files[p] || { exports: [], imports: [] };

    const usedBy = (g.usedBy[p] || []).map((u) => ({
      path: u.from,
      file: summary(u.from),
      names: u.imported,
      line: u.line,
      kind: u.kind,
      usages: this.usageLines(u.from, u.names, { start: u.line, end: u.line + 12 }),
    }));
    usedBy.sort((a, b) => (a.file?.tier ?? 9) - (b.file?.tier ?? 9) || a.path.localeCompare(b.path));

    const imports = [];
    const packages = new Map();
    for (const imp of node.imports) {
      if (imp.target.kind === "package") {
        const pkg = imp.spec.startsWith("@") ? imp.spec.split("/").slice(0, 2).join("/") : imp.spec.split("/")[0];
        packages.set(pkg, (packages.get(pkg) || 0) + 1);
        continue;
      }
      imports.push({
        spec: imp.spec,
        kind: imp.kind,
        target: imp.target.kind,
        path: imp.target.path || null,
        file: imp.target.kind === "pr" ? summary(imp.target.path) : null,
        names: imp.names.map((n) => n.imported),
        line: imp.line,
      });
    }
    imports.sort((a, b) => (a.target === b.target ? 0 : a.target === "pr" ? -1 : 1) || (a.file?.tier ?? 9) - (b.file?.tier ?? 9) || a.spec.localeCompare(b.spec));

    const exportUse = new Map();
    for (const u of g.usedBy[p] || []) for (const n of u.imported) exportUse.set(n, (exportUse.get(n) || 0) + 1);
    const exports = node.exports.map((e) => ({ ...e, usedBy: exportUse.get(e.kind === "default" ? "default" : e.name) || 0 }));

    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    const siblings = Object.keys(store.files)
      .filter((q) => q !== p && (q.includes("/") ? q.slice(0, q.lastIndexOf("/")) : "") === dir)
      .sort()
      .slice(0, 40)
      .map(summary);

    const tests = (g.tests[p] || []).slice(0, 8).map((t) => ({ ...t, file: summary(t.test) }));
    const testedSources = isTest(p)
      ? Object.entries(g.tests)
          .filter(([, arr]) => arr.some((t) => t.test === p))
          .map(([src, arr]) => ({ ...arr.find((t) => t.test === p), path: src, file: summary(src) }))
          .sort((a, b) => ({ testid: 3, text: 2, name: 1 }[b.via] || 0) - ({ testid: 3, text: 2, name: 1 }[a.via] || 0) || b.count - a.count)
          .slice(0, 12)
      : [];

    return {
      status: "ready",
      path: p,
      exports,
      usedBy,
      imports,
      packages: [...packages.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      tests,
      testedSources,
      siblings,
      formerImporters: (g.formerImporters[p] || []).map(summary).filter(Boolean),
      treeLoaded: Boolean(g.treeLoaded),
    };
  }
}

// ---------- parsing ----------

export function parseSource(filePath, text) {
  const imports = [];
  const exports = [];
  const lineAt = lineIndexer(text);

  for (const m of text.matchAll(IMPORT_FROM_RE)) {
    const [, verb, typeOnly, clause, spec] = m;
    const names = parseClause(clause.trim(), filePath);
    const line = lineAt(m.index);
    imports.push({ spec, line, kind: verb === "export" ? "reexport" : typeOnly ? "type" : "static", names });
    if (verb === "export") {
      for (const n of names) if (n.kind !== "namespace-all") exports.push({ name: n.local || n.imported, kind: "reexport", line });
      if (clause.trim() === "*") exports.push({ name: "*", kind: "reexport-all", line, from: spec });
    }
  }
  for (const m of text.matchAll(IMPORT_SIDE_RE)) imports.push({ spec: m[1], line: lineAt(m.index), kind: "side-effect", names: [] });
  for (const m of text.matchAll(IMPORT_DYN_RE)) imports.push({ spec: m[1], line: lineAt(m.index), kind: "dynamic", names: [{ imported: "default", local: inferDefaultName(m[1]), kind: "default" }] });

  for (const m of text.matchAll(EXPORT_DECL_RE)) exports.push({ name: m[2], kind: m[1].replace(/\s+/g, " ").replace("*", ""), line: lineAt(m.index) });
  for (const m of text.matchAll(EXPORT_DEFAULT_RE)) exports.push({ name: m[2] || m[3] || inferDefaultName(filePath), kind: "default", line: lineAt(m.index) });
  for (const m of text.matchAll(EXPORT_LIST_RE)) {
    for (const part of m[1].split(",")) {
      const seg = part.trim().replace(/^type\s+/, "");
      if (!seg) continue;
      const mm = seg.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (mm) exports.push({ name: mm[2] || mm[1], kind: "named", line: lineAt(m.index) });
    }
  }
  const seen = new Set();
  const dedupExports = exports.filter((e) => {
    const k = `${e.kind === "default" ? "default" : e.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const testIds = [];
  const testTexts = [];
  const testIdDefs = [];
  const i18nKeys = [];
  if (isTest(filePath)) {
    for (const m of text.matchAll(TESTID_USE_RE)) testIds.push(m[1] || m[2] || m[3]);
    for (const m of text.matchAll(TEST_TEXT_RE)) testTexts.push(m[1]);
  } else {
    for (const m of text.matchAll(TESTID_DEF_RE)) testIdDefs.push(m[1] || m[2]);
    for (const m of text.matchAll(I18N_USE_RE)) i18nKeys.push(m[1]);
  }
  return { imports, exports: dedupExports, testIds: uniq(testIds), testTexts: uniq(testTexts), testIdDefs: uniq(testIdDefs), i18nKeys: uniq(i18nKeys) };
}

function parseClause(clause, filePath) {
  const names = [];
  if (!clause) return names;
  let rest = clause;
  const ns = rest.match(/\*\s+as\s+([\w$]+)/);
  if (ns) {
    names.push({ imported: "*", local: ns[1], kind: "namespace" });
    rest = rest.replace(ns[0], "");
  } else if (rest.trim() === "*") {
    names.push({ imported: "*", local: null, kind: "namespace-all" });
    rest = "";
  }
  const braces = rest.match(/\{([^}]*)\}/);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const seg = part.trim().replace(/^type\s+/, "");
      if (!seg) continue;
      const mm = seg.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (mm) names.push({ imported: mm[1], local: mm[2] || mm[1], kind: "named" });
    }
    rest = rest.replace(braces[0], "");
  }
  const def = rest.replace(/,/g, " ").trim().match(/^([A-Za-z_$][\w$]*)$/);
  if (def) names.push({ imported: "default", local: def[1], kind: "default" });
  void filePath;
  return names;
}

export function resolveSpec(from, spec, aliases, prSet, tree) {
  let base = null;
  if (spec.startsWith(".")) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  } else {
    for (const a of aliases) {
      if (a.exact && spec === a.exact) {
        base = a.replace;
        break;
      }
      if (a.prefix && spec.startsWith(a.prefix)) {
        base = a.replace + spec.slice(a.prefix.length);
        break;
      }
    }
  }
  if (base == null) {
    // tsconfig baseUrl-style bare specifiers ("tests/helper/x") resolve from the repo root.
    const top = spec.split("/")[0];
    if (!spec.startsWith("@") && spec.includes("/") && (prSet.has(spec) || [...candidates(spec)].some((c) => prSet.has(c) || tree?.has(c)) || [...prSet].some((p) => p.startsWith(top + "/")))) base = spec;
    else return { kind: "package" };
  }
  base = base.replace(/^\.\//, "");
  for (const c of candidates(base)) {
    if (prSet.has(c)) return { kind: "pr", path: c };
  }
  if (tree) for (const c of candidates(base)) if (tree.has(c)) return { kind: "repo", path: c };
  return { kind: "missing", path: base };
}

function candidates(base) {
  const out = [base];
  const ext = path.posix.extname(base);
  if (/\.(js|jsx|mjs)$/.test(ext)) out.push(base.replace(/\.[cm]?jsx?$/, ".ts"), base.replace(/\.[cm]?jsx?$/, ".tsx"));
  if (!ext || !RESOLVE_EXT.includes(ext)) {
    for (const e of RESOLVE_EXT) out.push(base + e);
    for (const i of INDEX_FILES) out.push(`${base}/${i}`);
  }
  return out;
}

// ---------- helpers ----------

export function isSource(p) {
  return SRC_EXT.includes(path.posix.extname(p));
}
export function isTest(p) {
  return /^tests?\//.test(p) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(p) || /^(cypress|e2e)\//.test(p);
}
export function tokensOf(p) {
  const base = path.posix.basename(p).replace(/\.(spec|test)/, "").replace(/\.[^.]+$/, "");
  const parts = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+|\s+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 4 && !STOP_TOKENS.has(s))
    .map((s) => s.replace(/(ies)$/, "y").replace(/s$/, ""));
  return new Set(parts);
}
function normText(s) {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[.:!?]+$/, "").trim();
}
function inferDefaultName(p) {
  let base = path.posix.basename(p).replace(/\.[^.]+$/, "");
  if (/^index$/i.test(base)) base = path.posix.basename(path.posix.dirname(p));
  return base.replace(/[^\w$]/g, "");
}
function lineIndexer(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
function stripJsonComments(s) {
  // String-aware: "/*" inside JSON strings (e.g. "@/*" or "**/*.ts" globs) must survive.
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
    } else if (ch === "/" && next === "/") {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
function defaultAliases() {
  return [{ prefix: "@/", replace: "src/" }];
}
function uniq(arr) {
  return [...new Set(arr)];
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
