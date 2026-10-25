import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdownReport, buildReviewPayload, publishPendingReview, syncRemoteNote, deleteRemoteNote } from "./publish.mjs";
import { parseSpec } from "./tests.mjs";
import { serveFile } from "./ci.mjs";
import { parsePatch as patchLines } from "./patchlines.mjs";
import { parsePrParam, prKey } from "./workspace.mjs";
import { countRecords } from "./store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "web");
const VENDOR = {
  "/vendor/hljs/": path.join(ROOT, "node_modules/@highlightjs/cdn-assets/"),
  "/vendor/diff.js": path.join(ROOT, "node_modules/diff/dist/diff.js"),
};
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
};

/** Feature modules register extra routes here: async (ctx, route, req, res, url, helpers) => handled? */
export const extraRoutes = [];

export function createServer(workspace, { log = console.log } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      if (url.pathname.startsWith("/ci/")) return await serveAttachment(req, res, url);
      return await serveStatic(url.pathname, res);
    } catch (err) {
      log(`! ${req.method} ${url.pathname}: ${err.message}`);
      sendJson(res, err.status && err.status >= 400 && err.status < 600 ? err.status : 500, { error: err.message, status: err.status });
    }
  });

  function buildIndex(ctx) {
    const { xref } = ctx;
    if (!xref || xref.ready || xref.building) return;
    log(`  [${ctx.key}] building cross-reference index…`);
    xref
      .build({ onProgress: () => {} })
      .then((st) => log(`✓ [${ctx.key}] cross-reference index ready (${st.files} files)`))
      .catch((err) => log(`! [${ctx.key}] cross-reference index failed: ${err.message}`));
  }

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    const q = (k) => url.searchParams.get(k);

    // ---- workspace-level routes (no PR context needed)
    switch (route) {
      case "GET /api/prs": {
        const known = await workspace.known();
        const repo = q("repo") || workspace.config.defaultRepo || (known[0] ? `${known[0].owner}/${known[0].repo}` : null);
        const discovered = q("discover") === "0" ? { repo, open: [], requested: [] } : await workspace.discoverCached(repo, { force: q("refresh") === "1" }).catch((err) => ({ repo, open: [], requested: [], error: err.message }));
        return sendJson(res, 200, { known, ...discovered, current: workspace.lastKey });
      }
      case "POST /api/prs/open": {
        const body = await readJson(req);
        const ref = parsePrParam(body.pr) || (body.url && parseUrl(body.url));
        if (!ref) return sendJson(res, 400, { error: "Could not parse pull request reference" });
        const ctx = await workspace.open(ref);
        return sendJson(res, 200, { key: ctx.key, ref, path: `/pr/${ref.owner}/${ref.repo}/${ref.number}/` });
      }
      default:
        break;
    }

    const ctx = await workspace.ctxFor(q("pr"));
    if (ctx.initializing) await ctx.initializing;
    const { store, xref, ci } = ctx;
    if (xref && !xref.ready && !xref.building) buildIndex(ctx);

    for (const handler of extraRoutes) {
      const handled = await handler(ctx, route, req, res, url, { q, need, sendJson, readJson, log, buildIndex });
      if (handled) return;
    }

    switch (route) {
      case "GET /api/snapshot":
        store.otherInstance?.().then((o) => (store.otherInstanceInfo = o)).catch(() => {}); // refresh for the next call
        return sendJson(res, 200, { ...store.snapshot(), key: ctx.key, hasGit: Boolean(ctx.git), gitDir: ctx.git?.dir || null });
      case "GET /api/file":
        return sendJson(res, 200, await store.fileDetail(need(q("path"), "path")));
      case "GET /api/content": {
        const text = await store.content(need(q("path"), "path"), q("side") === "base" ? "base" : "head");
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(text);
      }
      case "GET /api/interdiff":
        return sendJson(res, 200, await store.interdiff(need(q("path"), "path")));
      case "POST /api/status": {
        const { path: p, status } = await readJson(req);
        const out = store.setStatus(need(p, "path"), need(status, "status"));
        await store.save();
        return sendJson(res, 200, { file: out, stats: store.stats() });
      }
      case "POST /api/review/restore": {
        const { items } = await readJson(req);
        const files = store.restoreReview(items || []);
        await store.save();
        return sendJson(res, 200, { files, stats: store.stats() });
      }
      case "POST /api/bulk": {
        const { paths, status } = await readJson(req);
        const files = (paths || []).map((p) => store.setStatus(p, status));
        await store.save();
        return sendJson(res, 200, { files, stats: store.stats() });
      }
      case "POST /api/note": {
        const body = await readJson(req);
        const note = store.addNote(need(body.path, "path"), body);
        await store.save();
        return sendJson(res, 200, { note, file: store.fileSummary(body.path), stats: store.stats() });
      }
      case "PUT /api/note": {
        const body = await readJson(req);
        const note = store.editNote(need(body.path, "path"), need(body.id, "id"), body.text, body.kind);
        // Published notes follow their edit to GitHub (inline comment PATCH, or the review body is rebuilt).
        let remote = null;
        if (note.publishedAt && body.remote !== false) {
          try {
            remote = await syncRemoteNote(store, body.path, note);
          } catch (err) {
            remote = `failed: ${err.message.split("\n")[0].slice(0, 160)}`;
          }
        }
        await store.save();
        return sendJson(res, 200, { note, file: store.fileSummary(body.path), remote });
      }
      case "DELETE /api/note": {
        const body = await readJson(req);
        const p = need(body.path, "path");
        const note = store.state.review[p]?.notes?.find((x) => x.id === body.id);
        store.deleteNote(p, need(body.id, "id"));
        let remote = null;
        if (note?.publishedAt && body.remote) {
          try {
            remote = await deleteRemoteNote(store, note);
          } catch (err) {
            remote = `failed: ${err.message.split("\n")[0].slice(0, 160)}`;
          }
        }
        await store.save();
        return sendJson(res, 200, { file: store.fileSummary(p), stats: store.stats(), remote });
      }
      case "POST /api/time": {
        const { path: p, ms } = await readJson(req);
        store.addTime(p, Number(ms));
        await store.save();
        return sendJson(res, 200, { ok: true });
      }
      case "POST /api/seen": {
        const { path: p, sha, hunks, total } = await readJson(req);
        const seen = store.markSeen(need(p, "path"), { sha, hunks, total });
        if (seen) await store.save();
        return sendJson(res, 200, { seen, file: store.files[p] ? store.fileSummary(p) : null });
      }
      case "GET /api/templates":
        return sendJson(res, 200, { templates: store.templates(), custom: Boolean(store._templates) });
      case "PUT /api/templates": {
        const { templates } = await readJson(req);
        return sendJson(res, 200, { templates: await store.saveTemplates(templates) });
      }
      case "DELETE /api/templates": {
        await store.resetTemplates();
        return sendJson(res, 200, { templates: store.templates() });
      }
      case "GET /api/backups":
        return sendJson(res, 200, { backups: await store.listBackups(), recovery: store.recovery || null, now: countRecords(store.state) });
      case "POST /api/backups/restore": {
        const { name } = await readJson(req);
        const r = await store.restoreBackup(need(name, "name"));
        return sendJson(res, 200, { ...r, snapshot: store.snapshot() });
      }
      case "POST /api/reset": {
        const { keepNotes, confirm } = await readJson(req);
        if (String(confirm) !== String(store.ref.number)) return sendJson(res, 400, { error: `Type the PR number (${store.ref.number}) to confirm` });
        const r = await store.reset({ keepNotes: Boolean(keepNotes) });
        log(`↺ ${ctx.key}: fresh review started (${r.before.records} records → backup ${r.backup})`);
        return sendJson(res, 200, { ...r, snapshot: store.snapshot() });
      }
      case "POST /api/backups/dismiss-warning": {
        store.recovery = null;
        return sendJson(res, 200, { ok: true });
      }
      case "POST /api/dismiss": {
        const { key, reason } = await readJson(req);
        const d = store.dismiss(need(key, "key"), reason);
        await store.save();
        return sendJson(res, 200, { key, dismissed: d });
      }
      case "DELETE /api/dismiss": {
        const { key } = await readJson(req);
        store.undismiss(need(key, "key"));
        await store.save();
        return sendJson(res, 200, { key });
      }
      case "POST /api/sync": {
        if (!ctx.syncing) {
          ctx.syncing = store
            .sync({ onProgress: (m) => log(`  ${m}`) })
            .finally(() => {
              ctx.syncing = null;
            });
        }
        const summary = await ctx.syncing;
        ctx.caches.outline.clear();
        ctx.caches.surface.clear();
        for (const k of ["stories", "threads", "moves", "lint"]) if (ctx[k]?.invalidate) ctx[k].invalidate();
        if (xref && !xref.ready) buildIndex(ctx);
        log(`✓ synced ${ctx.key} @ ${summary.headSha.slice(0, 7)} (+${summary.added.length} ~${summary.changed.length} −${summary.removed.length}, ${summary.staleNow.length} stale)`);
        return sendJson(res, 200, { summary, snapshot: store.snapshot() });
      }
      case "GET /api/related": {
        const p = need(q("path"), "path");
        if (!xref) return sendJson(res, 200, { status: "unavailable" });
        if (!xref.ready) {
          buildIndex(ctx);
          return sendJson(res, 200, { status: "building", ...xref.status() });
        }
        return sendJson(res, 200, await xref.related(p));
      }
      case "GET /api/graph/status":
        return sendJson(res, 200, xref ? xref.status() : { ready: false });
      case "POST /api/graph/build": {
        if (!xref) return sendJson(res, 200, { ready: false });
        xref.graph = null;
        buildIndex(ctx);
        return sendJson(res, 200, xref.status());
      }
      case "GET /api/repo-file": {
        const p = need(q("path"), "path");
        if (!xref) return sendJson(res, 404, { error: "index unavailable" });
        const content = await xref.repoFile(p);
        if (content == null) return sendJson(res, 404, { error: `No such file at head: ${p}` });
        return sendJson(res, 200, { path: p, content, inPr: Boolean(store.files[p]) });
      }
      case "GET /api/outline": {
        const p = need(q("path"), "path");
        const f = store.files[p];
        if (!f) return sendJson(res, 404, { error: `Unknown file ${p}` });
        const key = `${p}:${f.sha}`;
        if (!ctx.caches.outline.has(key)) {
          const content = f.status === "removed" ? await store.baseContent(f) : xref ? await xref.newContent(f) : await store.headContent(f);
          const added = new Set();
          if (f.status === "modified" || f.status === "renamed") for (const n of patchLines(await store.patchFor(p)).addedLines) added.add(n);
          ctx.caches.outline.set(key, parseSpec(content, { addedLines: f.status === "added" ? null : added }));
          if (ctx.caches.outline.size > 100) ctx.caches.outline.delete(ctx.caches.outline.keys().next().value);
        }
        return sendJson(res, 200, { path: p, ...ctx.caches.outline.get(key) });
      }
      case "GET /api/ci": {
        if (!ci) return sendJson(res, 200, { state: "unavailable" });
        if (ci.state === "idle") ci.ensureLoaded().catch(() => {});
        return sendJson(res, 200, ci.state === "ready" ? ci.summary() : ci.status());
      }
      case "GET /api/ci/file": {
        if (!ci || ci.state !== "ready") return sendJson(res, 200, { state: ci?.state || "unavailable", tests: [] });
        return sendJson(res, 200, { state: "ready", run: ci.run, tests: ci.fileResults(need(q("path"), "path")) });
      }
      case "GET /api/ci/history": {
        if (!ci || ci.state !== "ready") return sendJson(res, 200, { state: "waiting" });
        ci.ensureHistory({ refresh: q("refresh") === "1" }).catch(() => {});
        return sendJson(res, 200, ci.history());
      }
      case "POST /api/ci/load": {
        if (!ci) return sendJson(res, 200, { state: "unavailable" });
        const { runId } = await readJson(req);
        ci.loadRun(runId).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        return sendJson(res, 200, ci.status());
      }
      case "POST /api/ci/discover": {
        if (!ci) return sendJson(res, 200, { state: "unavailable" });
        await ci.discover();
        return sendJson(res, 200, ci.status());
      }
      case "GET /api/export.md": {
        const md = markdownReport(store);
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="review-${store.ref.repo}-${store.ref.number}.md"`,
        });
        return res.end(md);
      }
      case "GET /api/publish/preview": {
        const payload = await buildReviewPayload(store, { skipChanged: q("skipChanged") === "1" });
        return sendJson(res, 200, { counts: payload.counts, comments: payload.comments, body: payload.body, demoted: payload.demoted, changed: payload.changed });
      }
      case "POST /api/publish": {
        const body = await readJson(req);
        return sendJson(res, 200, await publishPendingReview(store, { event: body.event, summary: body.summary, skipChanged: Boolean(body.skipChanged) }));
      }
      default:
        return sendJson(res, 404, { error: `No route ${route}` });
    }
  }

  async function serveAttachment(req, res, url) {
    const m = url.pathname.match(/^\/ci\/([^/]+)\/(a|local)\/([^/]+)\/(.+)$/);
    if (!m) return sendJson(res, 404, { error: "not found" });
    const ctx = await workspace.ctxFor(m[1]);
    if (ctx.initializing) await ctx.initializing;
    if (!ctx.ci) return sendJson(res, 404, { error: "CI results unavailable" });
    const entry = m[4].split("/").map(decodeURIComponent).join("/");
    const file = await ctx.ci.attachmentFile(m[2], m[3], entry);
    return serveFile(req, res, file);
  }

  async function serveStatic(pathname, res) {
    let file = null;
    if (pathname === "/" || pathname === "/index.html" || /^\/pr\/[^/]+\/[^/]+\/\d+\/?$/.test(pathname)) file = path.join(WEB, "index.html");
    else {
      for (const [prefix, target] of Object.entries(VENDOR)) {
        if (pathname === prefix) file = target;
        else if (prefix.endsWith("/") && pathname.startsWith(prefix)) file = path.join(target, pathname.slice(prefix.length));
      }
      if (!file) file = path.join(WEB, pathname);
    }
    const resolved = path.resolve(file);
    if (!resolved.startsWith(ROOT)) return sendJson(res, 403, { error: "forbidden" });
    try {
      const data = await fs.readFile(resolved);
      res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "EISDIR") return sendJson(res, 404, { error: "not found" });
      throw err;
    }
  }

  return server;
}

function parseUrl(u) {
  const m = String(u).match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, ""), number: Number(m[3]) } : null;
}

export function need(v, name) {
  if (v == null || v === "") {
    const e = new Error(`Missing ${name}`);
    e.status = 400;
    throw e;
  }
  return v;
}

export function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (err) {
        err.status = 400;
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export { prKey };
