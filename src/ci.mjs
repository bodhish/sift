// Playwright CI results for a PR: find the latest run on one of the PR's commits, read only the JSON
// reports out of the (large) artifacts via HTTP range requests, and stream videos/traces on demand.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as gh from "./github.mjs";
import { ZipReader, httpSource, fileSource } from "./zip.mjs";

const execFileP = promisify(execFile);
const ANSI = /\x1b\[[0-9;]*m/g;

export class CI {
  constructor(store, { localDirs = [], urlPrefix = "/ci" } = {}) {
    this.store = store;
    this.urlPrefix = urlPrefix;
    this.dir = path.join(store.dir, "ci");
    this.localDirs = localDirs.map((d) => path.resolve(d));
    this.state = "idle"; // idle | discovering | loading | ready | none | error
    this.error = null;
    this.progress = "";
    this.candidates = [];
    this.run = null;
    this.tests = [];
    this.artifacts = new Map(); // artifactId -> { id, name, size, reader }
    this.token = null;
    this.loading = null;
  }

  status() {
    return { state: this.state, error: this.error, progress: this.progress, run: this.run, newer: this.newer || null, candidates: this.candidates.slice(0, 10), localDirs: this.localDirs, sourceNote: this.sourceNote || null };
  }

  // ---------- discovery ----------

  async discover() {
    this.state = "discovering";
    this.progress = "Looking for Playwright workflow runs…";
    const { owner, repo } = this.store.ref;
    const commits = this.store.state.commits || [];
    const shaIndex = new Map(commits.map((c, i) => [c.sha, i]));
    const workflows = (await gh.api(`repos/${owner}/${repo}/actions/workflows?per_page=100`)).workflows || [];
    const pw = workflows.filter((w) => /playwright|e2e|end-to-end/i.test(`${w.name} ${w.path}`) && !/comment|docker|image|improver|unit/i.test(`${w.name} ${w.path}`));
    const found = [];
    for (const w of pw) {
      for (const page of [1, 2]) {
        const res = await gh.api(`repos/${owner}/${repo}/actions/workflows/${w.id}/runs?per_page=100&page=${page}`);
        for (const r of res.workflow_runs || []) {
          if (!shaIndex.has(r.head_sha)) continue;
          found.push({
            id: r.id,
            number: r.run_number,
            workflow: w.name,
            headSha: r.head_sha,
            branch: r.head_branch,
            status: r.status,
            conclusion: r.conclusion,
            createdAt: r.created_at,
            url: r.html_url,
            behind: commits.length - 1 - shaIndex.get(r.head_sha),
          });
        }
        if ((res.workflow_runs || []).length < 100) break;
      }
    }
    found.sort((a, b) => a.behind - b.behind || b.createdAt.localeCompare(a.createdAt));
    this.candidates = found;
    return found;
  }

  // ---------- loading ----------

  async ensureLoaded() {
    if (this.loading) return this.loading;
    if (this.state === "ready") return;
    this.loading = this._load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async loadRun(runId) {
    if (this.loading) await this.loading.catch(() => {});
    this.state = "idle";
    this.loading = this._load(runId).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async _load(runId = null) {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      if (this.localDirs.length) {
        this.state = "loading";
        this.progress = "Reading local Playwright results…";
        await this.loadLocal();
        this.state = "ready";
        return;
      }
      // Fast path: reuse the last loaded run from disk, then look for newer runs in the background.
      const latest = runId ? null : await readJson(path.join(this.dir, "latest.json"));
      if (latest?.run && (await readJson(path.join(this.dir, `${latest.run.id}.json`)))?.tests?.length) {
        const cached = await readJson(path.join(this.dir, `${latest.run.id}.json`));
        this.run = latest.run;
        this.tests = this.migrateUrls(cached.tests);
        this.artifactMeta = cached.artifacts;
        this.state = "ready";
        this.progress = "";
        this.discover()
          .then((found) => {
            const best = found.filter((c) => c.status === "completed")[0];
            if (best && best.id !== this.run.id && best.behind <= this.run.behind) this.newer = best;
            this.state = "ready";
          })
          .catch(() => {
            this.state = "ready";
          });
        return;
      }
      if (!this.candidates.length) await this.discover();
      const completed = this.candidates.filter((c) => c.status === "completed");
      const run = runId ? this.candidates.find((c) => c.id === Number(runId)) : completed[0] || this.candidates[0];
      if (!run) {
        this.state = "none";
        this.progress = "";
        this.run = null;
        return;
      }
      this.state = "loading";
      this.run = run;
      const cacheFile = path.join(this.dir, `${run.id}.json`);
      const cached = await readJson(cacheFile);
      if (cached && cached.tests?.length) {
        this.tests = this.migrateUrls(cached.tests);
        this.artifactMeta = cached.artifacts;
        this.newer = null;
        await fs.writeFile(path.join(this.dir, "latest.json"), JSON.stringify({ run }));
        this.state = "ready";
        this.progress = "";
        return;
      }
      this.progress = `Listing artifacts of run #${run.number}…`;
      const { owner, repo } = this.store.ref;
      const res = await gh.api(`repos/${owner}/${repo}/actions/runs/${run.id}/artifacts?per_page=100`);
      const arts = (res.artifacts || []).filter((a) => !a.expired && /playwright|results|report|e2e/i.test(a.name) && !/^pr-|comment|number/i.test(a.name));
      if (!arts.length) throw new Error(`Run #${run.number} has no (unexpired) Playwright result artifacts`);
      // Prefer per-shard artifacts (each has test-results.json); fall back to a merged report artifact.
      const shards = arts.filter((a) => /shard|results/i.test(a.name));
      const pick = shards.length ? shards : arts;
      const tests = [];
      const metas = [];
      let i = 0;
      for (const a of pick) {
        i++;
        this.progress = `Reading report ${i}/${pick.length} (${a.name}, ${(a.size_in_bytes / 1048576).toFixed(0)} MB — only the JSON is fetched)…`;
        const reader = this.readerFor(a.id);
        const entry = (await reader.list()).find((e) => /(^|\/)(test-results|results|report)\.json$/.test(e.name));
        if (!entry) continue;
        const json = JSON.parse((await reader.readEntry(entry)).toString("utf8"));
        const names = new Set((await reader.list()).map((e) => e.name));
        tests.push(...this.normalize(json, { artifactId: a.id, entryNames: names }));
        metas.push({ id: a.id, name: a.name, size: a.size_in_bytes, expiresAt: a.expires_at, entry: entry.name });
      }
      if (!tests.length) throw new Error(`No JSON reporter output (test-results.json) found in the artifacts of run #${run.number}. The HTML report alone isn't enough — add ["json", { outputFile: "test-results.json" }] to the reporter config.`);
      this.tests = tests;
      this.artifactMeta = metas;
      this.newer = null;
      await fs.writeFile(cacheFile, JSON.stringify({ run, artifacts: metas, tests }));
      await fs.writeFile(path.join(this.dir, "latest.json"), JSON.stringify({ run }));
      this.state = "ready";
      this.progress = "";
    } catch (err) {
      this.state = "error";
      this.error = err.message;
      this.progress = "";
    }
  }

  async loadLocal() {
    const tests = [];
    for (let i = 0; i < this.localDirs.length; i++) {
      const dir = this.localDirs[i];
      let jsonPath = null;
      for (const cand of ["test-results.json", "results.json", "report.json", "playwright-report/results.json"]) {
        try {
          await fs.access(path.join(dir, cand));
          jsonPath = path.join(dir, cand);
          break;
        } catch {}
      }
      if (!jsonPath) throw new Error(`No test-results.json in ${dir}`);
      const json = JSON.parse(await fs.readFile(jsonPath, "utf8"));
      tests.push(...this.normalize(json, { localIndex: i, localDir: dir }));
    }
    this.tests = tests;
    this.run = { id: "local", number: "local", branch: "local run", headSha: this.store.state.pr?.headSha || "", behind: 0, url: null, createdAt: new Date().toISOString(), conclusion: null, status: "completed", local: true };
    this.sourceNote = `Local results from ${this.localDirs.join(", ")}`;
  }

  /** Older caches stored presentation URLs without the PR slug; rewrite them for this context. */
  migrateUrls(tests) {
    for (const t of tests) for (const a of t.attempts) for (const x of a.attachments) {
      if (x.url && !x.url.startsWith(this.urlPrefix + "/")) x.url = x.url.replace(/^\/ci(?:\/[^/]+)?\/(a|local)\//, `${this.urlPrefix}/$1/`);
    }
    return tests;
  }

  /** Flatten Playwright's JSON reporter output into one row per test. */
  normalize(json, { artifactId = null, entryNames = null, localIndex = null, localDir = null }) {
    const rootDir = json.config?.rootDir || "";
    const prPaths = Object.keys(this.store.files);
    const resolveFile = (file) => {
      const rel = file.replace(/\\/g, "/");
      const candidates = [rel, `tests/${rel}`, `test/${rel}`, `e2e/${rel}`, `cypress/${rel}`];
      const rootBase = rootDir.split(/[\\/]/).filter(Boolean).pop();
      if (rootBase) candidates.push(`${rootBase}/${rel}`);
      for (const c of candidates) if (this.store.files[c]) return c;
      const hit = prPaths.find((p) => p.endsWith(`/${rel}`));
      return hit || (rootBase ? `${rootBase}/${rel}` : rel);
    };
    const out = [];
    const walk = (suite, titles) => {
      const t = suite.title && suite.title !== suite.file ? [...titles, suite.title] : titles;
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          const attempts = (test.results || []).map((r) => ({
            retry: r.retry,
            status: r.status,
            duration: r.duration,
            startTime: r.startTime,
            workerIndex: r.workerIndex,
            error: r.error ? normalizeError(r.error) : (r.errors || [])[0] ? normalizeError(r.errors[0]) : null,
            attachments: (r.attachments || [])
              .map((a) => this.attachmentRef(a, { artifactId, entryNames, localIndex, localDir }))
              .filter(Boolean),
          }));
          const final = attempts[attempts.length - 1];
          out.push({
            id: test.id || spec.id || `${spec.file}:${spec.line}:${spec.title}`,
            file: resolveFile(spec.file),
            line: spec.line,
            column: spec.column,
            title: spec.title,
            titlePath: t,
            project: test.projectName || test.projectId || "",
            status: test.status, // expected | unexpected | flaky | skipped
            outcome: test.status === "expected" ? "passed" : test.status === "unexpected" ? "failed" : test.status === "flaky" ? "flaky" : "skipped",
            expectedStatus: test.expectedStatus,
            duration: attempts.reduce((n, a) => n + (a.duration || 0), 0),
            lastDuration: final?.duration || 0,
            annotations: (test.annotations || []).map((a) => a.type + (a.description ? `: ${a.description}` : "")),
            attempts,
            source: artifactId != null ? { artifactId } : { localIndex },
          });
        }
      }
      for (const child of suite.suites || []) walk(child, t);
    };
    for (const s of json.suites || []) walk(s, []);
    return out;
  }

  attachmentRef(a, { artifactId, entryNames, localIndex, localDir }) {
    if (!a.path && a.body) return { name: a.name, contentType: a.contentType, inline: a.body.slice(0, 2000) };
    if (!a.path) return null;
    const p = a.path.replace(/\\/g, "/");
    if (artifactId != null) {
      // Artifact entries are rooted at the uploaded folder (e.g. test-results/…/video.webm).
      const idx = p.indexOf("/test-results/");
      let entry = idx >= 0 ? p.slice(idx + 1) : p.replace(/^.*?(playwright-report\/)/, "$1");
      if (entryNames && !entryNames.has(entry)) {
        const base = p.split("/").slice(-2).join("/");
        entry = [...entryNames].find((n) => n.endsWith(base)) || entry;
      }
      if (entryNames && !entryNames.has(entry)) return { name: a.name, contentType: a.contentType, missing: true };
      return { name: a.name, contentType: a.contentType, url: `${this.urlPrefix}/a/${artifactId}/${entry.split("/").map(encodeURIComponent).join("/")}` };
    }
    const idx = p.indexOf("/test-results/");
    const rel = idx >= 0 ? p.slice(idx + 1) : path.basename(p);
    const local = path.join(localDir, rel);
    return { name: a.name, contentType: a.contentType, url: `${this.urlPrefix}/local/${localIndex}/${rel.split("/").map(encodeURIComponent).join("/")}`, localPath: local, absolute: p };
  }

  // ---------- queries ----------

  summary() {
    const byFile = {};
    const stats = { passed: 0, failed: 0, flaky: 0, skipped: 0, total: 0, durationMs: 0 };
    for (const t of this.tests) {
      const f = (byFile[t.file] ||= { passed: 0, failed: 0, flaky: 0, skipped: 0, total: 0, durationMs: 0, media: 0 });
      f[t.outcome]++;
      f.total++;
      f.durationMs += t.lastDuration;
      stats[t.outcome]++;
      stats.total++;
      stats.durationMs += t.lastDuration;
      if (t.attempts.some((a) => a.attachments.some((x) => /video|trace/.test(x.name) && x.url))) f.media++;
    }
    const clusters = new Map();
    for (const t of this.tests) {
      if (t.outcome !== "failed" && t.outcome !== "flaky") continue;
      const err = t.attempts.find((a) => a.error)?.error;
      if (!err) continue;
      const key = signature(err.message);
      const c = clusters.get(key) || { signature: key, tests: [], failed: 0, flaky: 0 };
      c.tests.push({ file: t.file, line: t.line, title: t.title, outcome: t.outcome });
      c[t.outcome]++;
      clusters.set(key, c);
    }
    const slowest = [...this.tests].filter((t) => t.outcome !== "skipped").sort((a, b) => b.lastDuration - a.lastDuration).slice(0, 10).map((t) => ({ file: t.file, line: t.line, title: t.title, duration: t.lastDuration, outcome: t.outcome }));
    return {
      ...this.status(),
      stats,
      byFile,
      clusters: [...clusters.values()].sort((a, b) => b.tests.length - a.tests.length).slice(0, 20),
      slowest,
      artifacts: this.artifactMeta || [],
      note: this.localDirs.length ? null : "Videos and traces exist only for retried attempts (playwright.config: video/trace = on-first-retry).",
      clustersLabel: "error signature",
    };
  }

  fileResults(p) {
    return this.tests.filter((t) => t.file === p).sort((a, b) => a.line - b.line);
  }

  // ---------- history across runs ----------

  static testKey(t) {
    return `${t.file}::${t.title}::${t.project || ""}`;
  }

  historyStatus() {
    const h = this.hist;
    if (!h) return { state: "idle" };
    return { state: h.state, progress: h.progress, error: h.error || null, runs: (h.runs || []).map((r) => ({ id: r.id, number: r.number, headSha: r.headSha, createdAt: r.createdAt, behind: r.behind, conclusion: r.conclusion, skipped: r.skipped || null })) };
  }

  /** Load compact per-test outcomes for the last few completed runs (newest first → stored chronological). */
  async ensureHistory({ max = 6, refresh = false } = {}) {
    if (this.hist?.loading) return this.hist.loading;
    if (this.hist?.state === "ready" && !refresh) return;
    if (this.run?.local) {
      this.hist = { state: "ready", runs: [], outcomes: {}, progress: "" };
      return;
    }
    const hist = { state: "loading", progress: "Finding earlier runs…", runs: [], outcomes: {} };
    this.hist = hist;
    hist.loading = (async () => {
      try {
        if (!this.candidates.length) await this.discover();
        const completed = this.candidates.filter((c) => c.status === "completed").slice(0, max);
        // oldest first so sparklines read left → right in time
        const runs = [...completed].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const perRun = [];
        let i = 0;
        for (const run of runs) {
          i++;
          hist.progress = `Run #${run.number} (${i}/${runs.length})…`;
          try {
            perRun.push({ run, outcomes: await this.runOutcomes(run) });
          } catch (err) {
            perRun.push({ run: { ...run, skipped: err.message.split("\n")[0].slice(0, 120) }, outcomes: null });
          }
        }
        const keys = new Set();
        for (const r of perRun) if (r.outcomes) for (const k of Object.keys(r.outcomes)) keys.add(k);
        const outcomes = {};
        for (const k of keys) outcomes[k] = perRun.map((r) => (r.outcomes ? r.outcomes[k] || null : null));
        hist.runs = perRun.map((r) => r.run);
        hist.outcomes = outcomes;
        hist.state = "ready";
        hist.progress = "";
      } catch (err) {
        hist.state = "error";
        hist.error = err.message;
        hist.progress = "";
      }
    })().finally(() => {
      hist.loading = null;
    });
    return hist.loading;
  }

  /** Outcome per test for one run, from the full cache if we have it, else a compact cache fetched now. */
  async runOutcomes(run) {
    if (this.run && run.id === this.run.id && this.tests.length) return Object.fromEntries(this.tests.map((t) => [CI.testKey(t), t.outcome]));
    const full = await readJson(path.join(this.dir, `${run.id}.json`));
    if (full?.tests?.length) return Object.fromEntries(full.tests.map((t) => [CI.testKey(t), t.outcome]));
    const compactFile = path.join(this.dir, `hist-${run.id}.json`);
    const compact = await readJson(compactFile);
    if (compact?.outcomes) return compact.outcomes;
    const { owner, repo } = this.store.ref;
    const res = await gh.api(`repos/${owner}/${repo}/actions/runs/${run.id}/artifacts?per_page=100`);
    const arts = (res.artifacts || []).filter((a) => !a.expired && /playwright|results|report|e2e/i.test(a.name) && !/^pr-|comment|number/i.test(a.name));
    if (!arts.length) throw new Error("artifacts expired");
    const shards = arts.filter((a) => /shard|results/i.test(a.name));
    const outcomes = {};
    for (const a of shards.length ? shards : arts) {
      const reader = this.readerFor(a.id);
      const entry = (await reader.list()).find((e) => /(^|\/)(test-results|results|report)\.json$/.test(e.name));
      if (!entry) continue;
      const json = JSON.parse((await reader.readEntry(entry)).toString("utf8"));
      for (const t of this.normalize(json, { artifactId: a.id, entryNames: new Set() })) outcomes[CI.testKey(t)] = t.outcome;
    }
    if (!Object.keys(outcomes).length) throw new Error("no JSON report in artifacts");
    await fs.writeFile(compactFile, JSON.stringify({ run: { id: run.id, number: run.number, headSha: run.headSha, createdAt: run.createdAt }, outcomes }));
    return outcomes;
  }

  /** History summary: per test the outcome sequence, plus a classification relative to the loaded run. */
  history() {
    const h = this.hist;
    if (!h || h.state !== "ready") return this.historyStatus();
    const runs = h.runs;
    const curIdx = runs.findIndex((r) => this.run && r.id === this.run.id);
    const bad = (o) => o === "failed" || o === "flaky";
    const classify = (seq) => {
      const upto = curIdx >= 0 ? seq.slice(0, curIdx + 1) : seq;
      const vals = upto.map((o, i) => ({ o, i })).filter((x) => x.o);
      if (!vals.length) return { cls: "stable" };
      const cur = vals[vals.length - 1].o;
      const before = vals.slice(0, -1);
      let transitions = 0;
      for (let i = 1; i < vals.length; i++) if (bad(vals[i].o) !== bad(vals[i - 1].o)) transitions++;
      if (bad(cur)) {
        if (!before.length) return { cls: "failing" };
        if (before.every((x) => bad(x.o))) return { cls: "always-failing", streak: vals.length };
        let streak = 0;
        for (let i = vals.length - 1; i >= 0 && bad(vals[i].o); i--) streak++;
        if (transitions >= 3) return { cls: "intermittent", streak };
        return { cls: streak === 1 ? "newly-broken" : "broken-since", streak, since: vals[vals.length - streak].i };
      }
      if (!before.length) return { cls: "stable" };
      if (bad(before[before.length - 1].o)) return { cls: transitions >= 3 ? "intermittent" : "recovered" };
      if (transitions >= 3) return { cls: "intermittent" };
      return { cls: "stable" };
    };
    const tests = {};
    const counts = { "newly-broken": 0, "broken-since": 0, "always-failing": 0, intermittent: 0, recovered: 0, stable: 0, failing: 0 };
    for (const [k, seq] of Object.entries(h.outcomes)) {
      const c = classify(seq);
      counts[c.cls]++;
      if (c.cls !== "stable") tests[k] = { seq, ...c };
    }
    return { ...this.historyStatus(), currentRunIndex: curIdx, counts, tests };
  }

  // ---------- attachments ----------

  readerFor(artifactId) {
    let a = this.artifacts.get(artifactId);
    if (!a) {
      const { owner, repo } = this.store.ref;
      const getUrl = async () => {
        const token = await this.ghToken();
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          redirect: "manual",
        });
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`Artifact ${artifactId} download failed (${res.status}) — it may have expired`);
        return loc;
      };
      a = { id: artifactId, reader: new ZipReader(httpSource(getUrl)) };
      this.artifacts.set(artifactId, a);
    }
    return a.reader;
  }

  async ghToken() {
    if (!this.token) {
      const { stdout } = await execFileP("gh", ["auth", "token"]);
      this.token = stdout.trim();
    }
    return this.token;
  }

  /** Resolve an attachment URL path to a local file (extracting from the artifact zip on first use). */
  async attachmentFile(kind, idOrIndex, entryPath) {
    if (kind === "local") {
      const dir = this.localDirs[Number(idOrIndex)];
      if (!dir) throw notFound("Unknown local results dir");
      const base = await fs.realpath(dir);
      let file;
      try {
        file = await fs.realpath(path.resolve(base, entryPath));
      } catch {
        throw notFound("No such attachment");
      }
      if (file !== base && !file.startsWith(base + path.sep)) throw notFound("Bad path");
      return file;
    }
    const artifactId = Number(idOrIndex);
    const cacheDir = path.join(this.dir, "attachments", String(artifactId));
    await fs.mkdir(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, `${crypto.createHash("sha1").update(entryPath).digest("hex")}${path.extname(entryPath)}`);
    try {
      await fs.access(cached);
      return cached;
    } catch {}
    const reader = this.readerFor(artifactId);
    const entry = (await reader.list()).find((e) => e.name === entryPath);
    if (!entry) throw notFound(`No ${entryPath} in artifact ${artifactId}`);
    const tmp = `${cached}.part`;
    if (entry.usize <= 64 * 1024 * 1024) {
      await fs.writeFile(tmp, await reader.readEntry(entry));
    } else {
      const { pipeline } = await import("node:stream/promises");
      const { createWriteStream } = await import("node:fs");
      await pipeline(await reader.streamEntry(entry), createWriteStream(tmp));
    }
    await fs.rename(tmp, cached);
    return cached;
  }
}

// ---------- helpers ----------

function normalizeError(e) {
  const message = String(e.message || e.value || "").replace(ANSI, "");
  const lines = message.split("\n");
  return {
    message,
    headline: lines[0].slice(0, 300),
    location: e.location || null,
    snippet: e.snippet ? String(e.snippet).replace(ANSI, "") : null,
  };
}
function signature(message) {
  return String(message || "")
    .replace(ANSI, "")
    .split("\n")[0]
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
    .replace(/\d+(\.\d+)?\s*(ms|s)\b/g, "<t>")
    .replace(/\b\d{3,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
function notFound(msg) {
  const e = new Error(msg);
  e.status = 404;
  return e;
}
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export const MIME_BY_EXT = {
  ".webm": "video/webm", ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".zip": "application/zip", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8",
};

/** Serve a file with HTTP range support (videos seek, trace viewer fetches). */
const CORS_ALLOWED_ORIGINS = new Set(["https://trace.playwright.dev"]);

export async function serveFile(req, res, file, extraHeaders = {}) {
  const stat = await fs.stat(file);
  const type = MIME_BY_EXT[path.extname(file).toLowerCase()] || "application/octet-stream";
  const origin = req.headers.origin;
  const cors = origin && CORS_ALLOWED_ORIGINS.has(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
  const headers = { "content-type": type, "accept-ranges": "bytes", ...cors, "cache-control": "private, max-age=3600", ...extraHeaders };
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size) {
      res.writeHead(416, { "content-range": `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${stat.size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-length": stat.size });
  createReadStream(file).pipe(res);
}

export { fileSource };
