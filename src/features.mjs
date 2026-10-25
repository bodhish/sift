// Feature modules that add API routes (stories, threads, moves, lint, …) register themselves here.
// Imported for its side effects by bin/sift.mjs.
import { extraRoutes } from "./server.mjs";
import { Stories } from "./stories.mjs";

extraRoutes.push(async (ctx, route, req, res, url, h) => {
  if (route === "GET /api/stories") {
    ctx.stories ||= await new Stories(ctx).load();
    const d = await ctx.stories.get();
    h.sendJson(res, 200, d);
    return true;
  }
  return false;
});

import { Threads } from "./threads.mjs";
extraRoutes.push(async (ctx, route, req, res, url, h) => {
  if (route === "GET /api/threads") {
    ctx.stories ||= await new Stories(ctx).load();
    ctx.threads ||= await new Threads(ctx).load();
    const d = await ctx.threads.get({ refresh: h.q("refresh") === "1" });
    h.sendJson(res, 200, d);
    return true;
  }
  return false;
});

import { Moves } from "./moves.mjs";
extraRoutes.push(async (ctx, route, req, res, url, h) => {
  if (route === "GET /api/moves") {
    ctx.moves ||= await new Moves(ctx).load();
    const d = await ctx.moves.get();
    const p = h.q("path");
    if (p) return h.sendJson(res, 200, { path: p, summary: d.summary[p] || null, lines: d.lineMaps[p] || {} }), true;
    h.sendJson(res, 200, { headSha: d.headSha, summary: d.summary });
    return true;
  }
  return false;
});

import { Lint } from "./lint.mjs";
extraRoutes.push(async (ctx, route, req, res, url, h) => {
  if (route === "GET /api/lint") {
    ctx.lint ||= await new Lint(ctx).load();
    const d = await ctx.lint.get({ refresh: h.q("refresh") === "1" });
    const p = h.q("path");
    if (p) return h.sendJson(res, 200, { path: p, findings: d.findings.filter((x) => x.path === p) }), true;
    h.sendJson(res, 200, { headSha: d.headSha, byFile: d.byFile, byRule: d.byRule, i18n: d.i18n, rules: d.rules, total: d.findings.length, findings: d.findings });
    return true;
  }
  return false;
});

import { computeRisk } from "./risk.mjs";
extraRoutes.push(async (ctx, route, req, res, url, h) => {
  if (route !== "GET /api/risk") return false;
  const { xref } = ctx;
  if (!xref) return h.sendJson(res, 200, { ready: false, reason: "unavailable" }), true;
  if (!xref.ready) {
    h.buildIndex(ctx);
    return h.sendJson(res, 200, { ready: false, reason: "building", ...xref.status() }), true;
  }
  const head = ctx.store.state.pr?.headSha;
  if (!ctx.caches.risk || ctx.caches.risk.headSha !== head) ctx.caches.risk = { headSha: head, data: computeRisk(ctx) };
  h.sendJson(res, 200, ctx.caches.risk.data);
  return true;
});

import { parseSurface } from "./surface.mjs";
import { parsePatch as patchLinesForKeys } from "./patchlines.mjs";
extraRoutes.push(async (ctx, route, req, res, url, h) => {
  const { store, xref } = ctx;
  if (route === "GET /api/surface") {
    const p = h.need(h.q("path"), "path");
    const f = store.files[p];
    if (!f) return h.sendJson(res, 404, { error: `Unknown file ${p}` }), true;
    const key = `${p}:${f.sha}`;
    if (!ctx.caches.surface.has(key)) {
      const content = f.status === "removed" ? await store.baseContent(f) : xref ? await xref.newContent(f) : await store.headContent(f);
      const surface = parseSurface(content, p);
      if (surface.ok && f.status !== "added" && f.status !== "removed") {
        const added = new Set(patchLinesForKeys(await store.patchFor(p)).addedLines);
        for (const fn of surface.functions) fn.change = classify(fn.line, fn.endLine, added);
        for (const e of surface.exports) e.change = added.has(e.line) ? "new" : e.endLine ? classify(e.line, e.endLine, added) : "unchanged";
      }
      ctx.caches.surface.set(key, surface);
      if (ctx.caches.surface.size > 100) ctx.caches.surface.delete(ctx.caches.surface.keys().next().value);
    }
    h.sendJson(res, 200, { path: p, ...ctx.caches.surface.get(key) });
    return true;
  }
  if (route === "GET /api/def") {
    const p = h.need(h.q("path"), "path");
    const name = h.need(h.q("name"), "name");
    const g = xref?.graph;
    const out = { name, from: p, results: [] };
    const exportLine = (target) => {
      const ex = g?.files?.[target]?.exports || [];
      const hit = ex.find((e) => e.name === name) || ex.find((e) => e.kind === "default");
      return hit?.line || 1;
    };
    // 1. imported into this file?
    for (const imp of g?.files?.[p]?.imports || []) {
      const n = imp.names.find((x) => x.local === name || x.imported === name);
      if (n && imp.target?.path) out.results.push({ kind: "import", path: imp.target.path, line: imp.target.kind === "pr" || imp.target.kind === "repo" ? exportLine(imp.target.path) : 1, inPr: imp.target.kind === "pr", spec: imp.spec, viaDefault: n.imported === "default" });
    }
    // 2. declared locally?
    const f = store.files[p];
    if (f) {
      const content = f.status === "removed" ? await store.baseContent(f) : xref ? await xref.newContent(f) : await store.headContent(f);
      const re = new RegExp(`^[ \\t]*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let|var|type|interface|enum)\\s+${name.replace(/[$]/g, "\\\\$")}\\b`, "m");
      const m = content.match(re);
      if (m) out.results.push({ kind: "local", path: p, line: content.slice(0, m.index).split("\n").length, inPr: true });
    }
    // 3. exported by any PR file?
    if (!out.results.length && g) {
      for (const [q, node] of Object.entries(g.files)) {
        const e = node.exports.find((x) => x.name === name);
        if (e) out.results.push({ kind: "export", path: q, line: e.line, inPr: true });
        if (out.results.length >= 8) break;
      }
    }
    h.sendJson(res, 200, out);
    return true;
  }
  if (route === "GET /api/i18n") {
    const p = h.need(h.q("path"), "path");
    const f = store.files[p];
    if (!f) return h.sendJson(res, 404, { error: `Unknown file ${p}` }), true;
    const patch = f.patch || (await store.patchFor(p));
    const added = new Map();
    const removed = new Map();
    for (const line of patch.split("\n")) {
      const m = line.match(/^([+-])\s*"([^"]+)"\s*:\s*(.*?),?\s*$/);
      if (!m) continue;
      (m[1] === "+" ? added : removed).set(m[2], m[3].replace(/^"|"$/g, ""));
    }
    const entries = [];
    for (const [k, v] of added) entries.push({ key: k, status: removed.has(k) ? "changed" : "new", value: v, old: removed.get(k) ?? null });
    for (const [k, v] of removed) if (!added.has(k)) entries.push({ key: k, status: "removed", value: null, old: v });
    // usages across changed source files
    const uses = {};
    if (xref) {
      await xref.ensureContents();
      const bases = entries.map((e) => e.key.replace(/_(one|other|zero|two|few|many|plural)$/, ""));
      const set = new Set(bases);
      for (const [q, text] of xref.contents) {
        if (!/\.(tsx?|jsx?)$/.test(q)) continue;
        const lines = text.split("\n");
        lines.forEach((line, i) => {
          for (const m of line.matchAll(/["'`]([a-zA-Z0-9_.:-]+)["'`]/g)) if (set.has(m[1])) (uses[m[1]] ||= []).push({ path: q, line: i + 1 });
        });
      }
    }
    for (const e of entries) e.uses = uses[e.key.replace(/_(one|other|zero|two|few|many|plural)$/, "")] || [];
    h.sendJson(res, 200, { path: p, entries });
    return true;
  }
  return false;
});
function classify(start, end, added) {
  let hit = 0;
  let total = 0;
  for (let l = start; l <= end; l++) {
    total++;
    if (added.has(l)) hit++;
  }
  if (!hit) return "unchanged";
  return hit >= total * 0.9 ? "new" : "modified";
}

// ---- local git extras: churn/age and repo-wide impact (callers outside the PR)
extraRoutes.push(async (ctx, route, req, res, url, h) => {
  const { store, xref, git } = ctx;
  if (route === "GET /api/gitx") {
    if (!git) return h.sendJson(res, 200, { available: false }), true;
    const pr = store.state.pr;
    if (!ctx.caches.churn || ctx.caches.churn.headSha !== pr.headSha) {
      const remote = (await git.findRemote()) || "origin";
      const baseRef = `${remote}/${pr.baseRef}`;
      let churn = new Map();
      try {
        await git.ensureRef(pr.baseRef).catch(() => {});
        churn = await git.churn(baseRef, Object.keys(store.files).filter((p) => store.files[p].status !== "added"), { months: 6 });
      } catch {}
      ctx.caches.churn = { headSha: pr.headSha, byFile: Object.fromEntries(churn) };
    }
    const p = h.q("path");
    if (!p) return h.sendJson(res, 200, { available: true, byFile: ctx.caches.churn.byFile }), true;
    const f = store.files[p];
    if (!f) return h.sendJson(res, 404, { error: `Unknown file ${p}` }), true;
    const out = { available: true, path: p, churn: ctx.caches.churn.byFile[p] || null, impact: [] };
    // repo-wide impact: for exports of a modified file, who else (outside the PR) references them at head?
    if (f.status === "modified" || f.status === "renamed") {
      await git.ensurePr(pr.number, pr.headSha).catch(() => {});
      const names = (xref?.graph?.files?.[p]?.exports || []).map((e) => e.name).filter((n) => n && n !== "*" && n.length > 2).slice(0, 12);
      const seen = new Set();
      for (const name of names) {
        const hits = await git.grep(pr.headSha, name, { max: 300, pathspecs: ["src", "tests"] });
        const outside = hits.filter((x) => x.path !== p && !store.files[x.path] && !seen.has(`${x.path}:${x.line}`));
        for (const x of outside) seen.add(`${x.path}:${x.line}`);
        if (outside.length) out.impact.push({ name, count: outside.length, files: [...new Set(outside.map((x) => x.path))].length, hits: outside.slice(0, 20) });
      }
      out.impact.sort((a, b) => b.count - a.count);
    }
    h.sendJson(res, 200, out);
    return true;
  }
  return false;
});

// ---- full-text search across the PR diff (added/removed lines), cached patches only → fast
extraRoutes.push(async (ctx, route, req, res, url, h) => {
  if (route !== "GET /api/search") return false;
  const { store } = ctx;
  const q = h.need(h.q("q"), "q");
  const mode = h.q("mode") || "changed"; // changed | added | removed | all
  const useRe = h.q("re") === "1";
  const cs = h.q("cs") === "1";
  let re;
  try {
    re = new RegExp(useRe ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), cs ? "" : "i");
  } catch (err) {
    return h.sendJson(res, 400, { error: `Bad regex: ${err.message}` }), true;
  }
  const results = [];
  let total = 0;
  const MAX = 400;
  for (const f of Object.values(store.files)) {
    if (!f.patch) continue;
    let oldNo = 0;
    let newNo = 0;
    const hits = [];
    for (const raw of f.patch.split("\n")) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
        continue;
      }
      if (raw.startsWith("\\")) continue;
      const c = raw[0];
      const text = raw.slice(1);
      const kind = c === "+" ? "added" : c === "-" ? "removed" : "context";
      const line = kind === "removed" ? oldNo : newNo;
      if (c !== "+") oldNo++;
      if (c !== "-") newNo++;
      const wanted = mode === "all" || (mode === "changed" && kind !== "context") || mode === kind;
      if (!wanted || !re.test(text)) continue;
      total++;
      if (hits.length < 40 && results.length + hits.length < MAX) hits.push({ line, side: kind === "removed" ? "LEFT" : "RIGHT", kind, text: text.trim().slice(0, 200) });
    }
    if (hits.length) results.push({ path: f.path, hits, count: hits.length });
    if (results.length >= MAX) break;
  }
  results.sort((a, b) => b.count - a.count);
  h.sendJson(res, 200, { q, mode, total, files: results.length, results });
  return true;
});
