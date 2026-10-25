// Reviewer lint: cheap, high-signal checks over the lines this PR adds — the things a human reviewer
// would otherwise have to notice by eye. Generic rules + repository-specific ones (i18n, permissions).
import fs from "node:fs/promises";
import path from "node:path";
import { parsePatch as patchLines } from "./patchlines.mjs";

const SRC_RE = /\.(tsx?|jsx?|mjs|cjs)$/;
const UI_ATTR_RE = /\b(placeholder|title|aria-label|label|alt|description|helperText|tooltip|heading|subtitle)=["']([^"'{}]{3,})["']/;
const JSX_TEXT_RE = />\s*([A-Z][A-Za-z][^<>{}]{1,80}?)\s*<\//;
const PLURAL_SUFFIXES = ["", "_one", "_other", "_zero", "_two", "_few", "_many", "_plural"];
const SECRET_RE = /\b(api[_-]?key|secret|password|token|access[_-]?key)\b\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{16,}["']/i;

export class Lint {
  constructor(ctx) {
    this.ctx = ctx;
    this.file = path.join(ctx.store.dir, "lint.json");
    this.data = null;
    this.building = null;
  }

  invalidate() {
    if (this.data && this.data.headSha !== this.ctx.store.state.pr?.headSha) this.data = null;
  }

  async load() {
    try {
      const d = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (d.version === 1 && d.headSha === this.ctx.store.state.pr?.headSha) this.data = d;
    } catch {}
    return this;
  }

  async get({ refresh = false } = {}) {
    this.invalidate();
    if (this.data && !refresh) return this.data;
    if (!this.building) this.building = this.build().finally(() => (this.building = null));
    return this.building;
  }

  async build() {
    const { store, xref, repoConfig } = this.ctx;
    const disabled = new Set(repoConfig.lint?.disable || []);
    const files = Object.values(store.files).filter((f) => f.status !== "removed");
    const findings = [];
    const add = (f) => {
      if (!disabled.has(f.rule)) findings.push(f);
    };

    // contents + added-line sets
    const contents = new Map();
    const addedSets = new Map();
    for (const f of files) {
      let text = "";
      try {
        text = xref ? await xref.newContent(f) : await store.headContent(f);
      } catch {}
      contents.set(f.path, text);
      if (f.status === "added") addedSets.set(f.path, null); // all lines
      else {
        const patch = f.patch || (await store.patchFor(f.path).catch(() => ""));
        addedSets.set(f.path, new Set(patchLines(patch).addedLines));
      }
    }
    const isAdded = (p, n) => {
      const s = addedSets.get(p);
      return s === null || (s && s.has(n));
    };
    const isTest = (p) => (repoConfig.testDirs || []).some((d) => p.startsWith(d + "/")) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(p);
    const isSrc = (p) => SRC_RE.test(p) && !isTest(p);

    // ---- i18n catalog (head) + keys added by this PR
    const i18nPath = (repoConfig.i18n || []).find((p) => store.files[p] || xref?.tree?.has(p));
    let catalog = null;
    let addedKeys = new Set();
    let removedKeys = new Set();
    if (i18nPath) {
      try {
        const text = contents.get(i18nPath) ?? (await xref?.repoFile(i18nPath));
        catalog = new Set();
        const walk = (obj, prefix) => {
          for (const [k, v] of Object.entries(obj || {})) {
            const key = prefix ? `${prefix}.${k}` : k;
            if (v && typeof v === "object") walk(v, key);
            else catalog.add(key);
          }
        };
        walk(JSON.parse(text), "");
        const f = store.files[i18nPath];
        if (f) {
          const patch = f.patch || (await store.patchFor(i18nPath));
          for (const line of patch.split("\n")) {
            const m = line.match(/^([+-])\s*"([^"]+)"\s*:/);
            if (!m) continue;
            if (m[1] === "+") addedKeys.add(m[2]);
            else removedKeys.add(m[2]);
          }
          // a key that is both removed and added = value changed, not a new key
          for (const k of [...addedKeys]) if (removedKeys.has(k)) {
            addedKeys.delete(k);
            removedKeys.delete(k);
          }
        }
      } catch {
        catalog = null;
      }
    }
    const keyUses = new Map(); // key -> [{path,line}]
    const permDefs = new Set();
    const permUses = new Map();
    const permFile = files.find((f) => repoConfig.permissionsFile?.test?.(f.path))?.path;
    if (permFile) for (const m of (contents.get(permFile) || "").matchAll(/\bPERMISSION_[A-Z0-9_]+\b/g)) permDefs.add(m[0]);
    else if (xref?.tree) {
      const candidate = [...xref.tree].find((p) => repoConfig.permissionsFile?.test?.(p));
      if (candidate) for (const m of ((await xref.repoFile(candidate)) || "").matchAll(/\bPERMISSION_[A-Z0-9_]+\b/g)) permDefs.add(m[0]);
    }

    // ---- per-line rules
    for (const f of files) {
      const p = f.path;
      const text = contents.get(p) || "";
      if (!text || /\.(json|md|lock|svg|png|jpg)$/.test(p) && p !== i18nPath) {
        if (f.status === "added" && /\.(json)$/.test(p) && text.length > 200_000) add({ path: p, line: 1, rule: "large-generated", level: "info", message: "Very large JSON added — generated or fixture? Skim rather than read." });
        continue;
      }
      const lines = text.split("\n");
      const test = isTest(p);
      const src = isSrc(p);
      if (f.status === "added" && lines.length > 600 && src) add({ path: p, line: 1, rule: "large-file", level: "info", message: `New file with ${lines.length} lines — consider whether it should be split.` });
      let inBlockComment = false;
      for (let i = 0; i < lines.length; i++) {
        const n = i + 1;
        const raw = lines[i];
        const line = raw.trim();
        // track block comments crudely so JSX-text rules skip them
        if (inBlockComment) {
          if (line.includes("*/")) inBlockComment = false;
          continue;
        }
        if (line.startsWith("/*")) {
          if (!line.includes("*/")) inBlockComment = true;
          continue;
        }
        if (!isAdded(p, n)) continue;
        const comment = line.startsWith("//") || line.startsWith("*");
        if (/\bdebugger\b/.test(line) && !comment) add({ path: p, line: n, rule: "debugger", level: "error", message: "debugger statement left in." });
        if (/\bconsole\.(log|debug|info|table|trace)\(/.test(line) && !comment && !test) add({ path: p, line: n, rule: "console-log", level: "warn", message: `console.${line.match(/console\.(\w+)/)[1]}() left in.` });
        if (/\b(TODO|FIXME|XXX|HACK)\b/.test(line)) add({ path: p, line: n, rule: "todo", level: "info", message: `${line.match(/\b(TODO|FIXME|XXX|HACK)\b/)[1]}: ${line.replace(/^.*?\b(TODO|FIXME|XXX|HACK)\b[:\s-]*/, "").slice(0, 100)}` });
        if (/(:\s*any\b|\bas\s+any\b|<any>)/.test(line) && !comment && SRC_RE.test(p)) add({ path: p, line: n, rule: "any-type", level: "warn", message: "Uses `any` — is a precise type available?" });
        if (/@ts-ignore/.test(line)) add({ path: p, line: n, rule: "ts-ignore", level: "warn", message: "@ts-ignore hides a type error." });
        if (/@ts-nocheck/.test(line)) add({ path: p, line: n, rule: "ts-nocheck", level: "error", message: "@ts-nocheck disables type checking for the whole file." });
        if (/@ts-expect-error/.test(line)) add({ path: p, line: n, rule: "ts-expect-error", level: "info", message: "@ts-expect-error — make sure the reason is documented." });
        if (/eslint-disable/.test(line)) add({ path: p, line: n, rule: "eslint-disable", level: "warn", message: `Lint rule disabled: ${(line.match(/eslint-disable(?:-next-line|-line)?\s*([\w\s,@/-]*)/) || [])[1]?.trim() || "(all)"}` });
        if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) add({ path: p, line: n, rule: "empty-catch", level: "warn", message: "Empty catch block swallows errors." });
        if (/key=\{\s*(index|i|idx)\s*\}/.test(line)) add({ path: p, line: n, rule: "key-index", level: "warn", message: "Array index used as React key." });
        if (/dangerouslySetInnerHTML/.test(line)) add({ path: p, line: n, rule: "dangerous-html", level: "warn", message: "dangerouslySetInnerHTML — is the content sanitized?" });
        if (SECRET_RE.test(line)) add({ path: p, line: n, rule: "secret", level: "error", message: "Looks like a hard-coded credential." });
        if (/window\.location\.(href|assign|replace)\s*(=|\()/.test(line) && src) add({ path: p, line: n, rule: "hard-navigation", level: "info", message: "Full-page navigation via window.location — intended (vs. router navigate)?" });
        if (test) {
          if (/\b(test|it|describe)\.only\(/.test(line)) add({ path: p, line: n, rule: "test-only", level: "error", message: ".only would make CI run just this test." });
          if (/\b(test|it|describe)\.(skip|fixme)\(/.test(line)) add({ path: p, line: n, rule: "test-skip", level: "info", message: "Skipped/fixme test." });
          if (/waitForTimeout\(/.test(line)) add({ path: p, line: n, rule: "hard-wait", level: "warn", message: "Hard wait — prefer waiting for a condition." });
          if (/page\.pause\(\)/.test(line)) add({ path: p, line: n, rule: "page-pause", level: "error", message: "page.pause() left in." });
        }
        if (src && /\.tsx$/.test(p) && !comment) {
          const jsx = line.match(JSX_TEXT_RE);
          if (jsx && !/\bt\(/.test(line) && !/^(https?:|\/|\{)/.test(jsx[1]) && /[a-z]/.test(jsx[1]) && !/^\s*[A-Z0-9_]+\s*$/.test(jsx[1])) add({ path: p, line: n, rule: "i18n-hardcoded-text", level: "warn", message: `Hard-coded UI text: "${jsx[1].trim().slice(0, 60)}" — should this go through t()?` });
          // a line that is only prose between tags: <p>\n  Some text here\n</p>
          const prevLine = (lines[i - 1] || "").trim();
          if (/^[A-Z][a-z].*[a-z.!?)]$/.test(line) && /\s/.test(line) && !/[<>{}();=:`"'[\]]/.test(line) && /(>|^)$/.test(prevLine) && prevLine.endsWith(">") && !/^(import|export|return)\b/.test(line)) add({ path: p, line: n, rule: "i18n-hardcoded-text", level: "warn", message: `Hard-coded UI text: "${line.slice(0, 60)}" — should this go through t()?` });
          const attr = line.match(UI_ATTR_RE);
          if (attr && !/\bt\(/.test(line) && /[a-z]/.test(attr[2]) && /\s/.test(attr[2]) && !/^(https?:|\/)/.test(attr[2])) add({ path: p, line: n, rule: "i18n-hardcoded-text", level: "warn", message: `Hard-coded ${attr[1]}="${attr[2].slice(0, 50)}" — should this go through t()?` });
        }
        if (catalog && SRC_RE.test(p)) {
          for (const m of line.matchAll(/\bt\(\s*["']([a-zA-Z0-9_.:-]+)["']\s*[,)]/g)) {
            const key = m[1];
            (keyUses.get(key) || keyUses.set(key, []).get(key)).push({ path: p, line: n });
            const bare = key.split(":").pop();
            const known = PLURAL_SUFFIXES.some((suf) => catalog.has(key + suf) || catalog.has(bare + suf)) || [...catalog].some((k) => k.startsWith(bare + "_") && /_(one|other|zero|two|few|many|male|female)$/.test(k));
            if (!known) add({ path: p, line: n, rule: "i18n-missing-key", level: "error", message: `t("${key}") — key is not in ${i18nPath}.` });
          }
        }
        if (permDefs.size && SRC_RE.test(p) && p !== permFile) {
          for (const m of line.matchAll(/\bPERMISSION_[A-Z0-9_]+\b/g)) {
            (permUses.get(m[0]) || permUses.set(m[0], []).get(m[0])).push({ path: p, line: n });
            if (!permDefs.has(m[0])) add({ path: p, line: n, rule: "permission-undefined", level: "error", message: `${m[0]} is not defined in the permissions file.` });
          }
        }
      }
    }

    // ---- cross-file: unused new i18n keys, unused new permissions, new components without tests
    const i18nInfo = { path: i18nPath, catalogSize: catalog?.size || 0, added: addedKeys.size, removed: removedKeys.size, unusedNew: [], removedButUsed: [] };
    if (catalog && i18nPath) {
      const allText = [...contents.entries()].filter(([p]) => SRC_RE.test(p)).map(([, t]) => t).join("\n");
      const dynamicPrefixes = new Set();
      for (const m of allText.matchAll(/[`"']([A-Za-z0-9_.:-]{4,}?)(?:\$\{|["'`]\s*\+)/g)) dynamicPrefixes.add(m[1]);
      const usedAnywhere = (k) => {
        const base = k.replace(/_(one|other|zero|two|few|many|plural|male|female)$/, "");
        if (keyUses.has(k) || keyUses.has(base)) return true;
        if (new RegExp(`\\bt\\(\\s*["'\`]${escapeRe(base)}["'\`]`).test(allText) || new RegExp(`["'\`]${escapeRe(base)}["'\`]\\s*[,)]`).test(allText)) return true;
        // dynamically built keys: t(`BLOOD_GROUP__${x}`) covers BLOOD_GROUP__A_positive
        for (const pre of dynamicPrefixes) if (base.startsWith(pre)) return true;
        return false;
      };
      for (const k of addedKeys) if (!usedAnywhere(k)) i18nInfo.unusedNew.push(k);
      for (const k of removedKeys) if (keyUses.has(k) || new RegExp(`\\bt\\(\\s*["'\`]${escapeRe(k)}["'\`]`).test(allText)) i18nInfo.removedButUsed.push(k);
      const f = store.files[i18nPath];
      if (f) {
        if (i18nInfo.unusedNew.length) add({ path: i18nPath, line: 1, rule: "i18n-unused-new-key", level: "info", message: `${i18nInfo.unusedNew.length} new key${i18nInfo.unusedNew.length > 1 ? "s" : ""} not referenced via t() in any changed source file (dynamic keys can't be checked): ${i18nInfo.unusedNew.slice(0, 8).join(", ")}${i18nInfo.unusedNew.length > 8 ? "…" : ""}` });
        if (i18nInfo.removedButUsed.length) add({ path: i18nPath, line: 1, rule: "i18n-removed-key-used", level: "error", message: `Removed key${i18nInfo.removedButUsed.length > 1 ? "s" : ""} still referenced: ${i18nInfo.removedButUsed.slice(0, 8).join(", ")}` });
      }
    }
    if (permFile) {
      const pf = store.files[permFile];
      const patch = pf?.patch || "";
      const newPerms = [...patch.matchAll(/^\+.*?\b(PERMISSION_[A-Z0-9_]+)\b/gm)].map((m) => m[1]);
      const unused = [...new Set(newPerms)].filter((k) => !permUses.has(k));
      if (unused.length) add({ path: permFile, line: 1, rule: "permission-unused-new", level: "info", message: `New permission constant${unused.length > 1 ? "s" : ""} not referenced by changed files: ${unused.slice(0, 8).join(", ")}${unused.length > 8 ? "…" : ""}` });
    }
    if (xref?.graph?.tests) {
      for (const f of files) {
        if (f.status !== "added" || !/\.tsx$/.test(f.path) || isTest(f.path)) continue;
        const text = contents.get(f.path) || "";
        const isComponent = /export\s+(default\s+)?(function|const)\s+[A-Z]/.test(text) && /return\s*\(?\s*</.test(text);
        if (isComponent && !(xref.graph.tests[f.path] || []).length) add({ path: f.path, line: 1, rule: "no-related-test", level: "info", message: "New component with no related Playwright spec found (by test id, UI text or name)." });
      }
    }

    const byFile = {};
    const byRule = {};
    for (const x of findings) {
      const b = (byFile[x.path] ||= { error: 0, warn: 0, info: 0 });
      b[x.level]++;
      byRule[x.rule] = (byRule[x.rule] || 0) + 1;
    }
    this.data = { version: 1, headSha: store.state.pr.headSha, builtAt: new Date().toISOString(), findings, byFile, byRule, i18n: i18nInfo, rules: RULES };
    await fs.writeFile(this.file, JSON.stringify(this.data));
    return this.data;
  }

  forFile(p) {
    return (this.data?.findings || []).filter((x) => x.path === p);
  }
}

export const RULES = {
  debugger: "debugger statement", "console-log": "console output left in", todo: "TODO / FIXME", "any-type": "`any` type", "ts-ignore": "@ts-ignore", "ts-nocheck": "@ts-nocheck", "ts-expect-error": "@ts-expect-error",
  "eslint-disable": "eslint rule disabled", "empty-catch": "empty catch block", "key-index": "array index as React key", "dangerous-html": "dangerouslySetInnerHTML", secret: "possible hard-coded credential", "hard-navigation": "window.location navigation",
  "test-only": ".only in tests", "test-skip": "skipped tests", "hard-wait": "hard waits in tests", "page-pause": "page.pause() left in", "i18n-hardcoded-text": "hard-coded UI text", "i18n-missing-key": "i18n key missing from catalog",
  "i18n-unused-new-key": "new i18n keys not used", "i18n-removed-key-used": "removed i18n key still used", "permission-undefined": "undefined permission constant", "permission-unused-new": "new permission constants unused", "no-related-test": "new component without related test", "large-file": "very large new file", "large-generated": "very large JSON",
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
