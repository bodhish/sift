// A workspace holds one context per pull request (store, index, CI, git…) and lets the UI switch
// between PRs without restarting the server.
import fs from "node:fs/promises";
import path from "node:path";
import * as gh from "./github.mjs";
import { Store, dataDirFor, defaultDataRoot } from "./store.mjs";
import { Xref } from "./xref.mjs";
import { CI } from "./ci.mjs";
import { findLocalClone } from "./git.mjs";

export function prKey(ref) {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}
export function prSlug(ref) {
  return `${ref.owner}~${ref.repo}~${ref.number}`;
}
export function parsePrParam(s) {
  if (!s) return null;
  const m = String(s).match(/^([^/#~]+)[/~]([^/#~]+)[#/~](\d+)$/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

export class Workspace {
  constructor({ root, config, log = () => {}, options = {}, dataRoot = null }) {
    this.root = root;
    this.dataRoot = dataRoot || defaultDataRoot(root);
    this.config = config;
    this.log = log;
    this.options = options; // { repoPath, pwResults, port }
    this.contexts = new Map();
    this.lastKey = null;
  }

  async open(ref, { sync = false } = {}) {
    const key = prKey(ref);
    let ctx = this.contexts.get(key);
    if (ctx) {
      this.lastKey = key;
      if (ctx.initializing) await ctx.initializing;
      if (sync && ctx.store.hasData) await ctx.store.sync({ onProgress: (m) => this.log(`  ${m}`) });
      return ctx;
    }
    // Concurrent opens of the same PR share one initialization.
    this._opening ||= new Map();
    if (this._opening.has(key)) return this._opening.get(key);
    const p = this._open(ref, key, { sync }).finally(() => this._opening.delete(key));
    this._opening.set(key, p);
    return p;
  }

  async _open(ref, key, { sync }) {
    let ctx;
    const repoConfig = this.config.forRepo(ref.owner, ref.repo);
    const dataDir = dataDirFor(this.dataRoot, ref);
    const store = await new Store({ dataDir, ref }).load({ port: this.options.port || null });
    if (store.otherInstanceInfo) this.log(`! Another Sift (pid ${store.otherInstanceInfo.pid}${store.otherInstanceInfo.port ? `, port ${store.otherInstanceInfo.port}` : ""}) has ${key} open — writes are merged, but prefer one instance.`);
    if (store.recovery) this.log(`! ${key}: review state has ${store.recovery.now.records} records but backup ${store.recovery.backup} has ${store.recovery.records} — restore from the Map banner or \`sift ${ref.owner}/${ref.repo}#${ref.number} --restore latest\`.`);
    ctx = {
      key,
      ref,
      slug: prSlug(ref),
      store,
      repoConfig,
      xref: null,
      ci: null,
      git: null,
      syncing: null,
      caches: { outline: new Map(), surface: new Map() },
      stories: null,
      threads: null,
      moves: null,
      lint: null,
      initializing: null,
    };
    this.contexts.set(key, ctx);
    this.lastKey = key;
    ctx.initializing = (async () => {
      if (!store.hasData || sync) {
        this.log(`→ ${store.hasData ? "Syncing" : "Fetching"} ${key} from GitHub…`);
        const s = await store.sync({ onProgress: (m) => this.log(`  ${m}`) });
        this.log(`✓ ${Object.keys(store.files).length} files @ ${s.headSha.slice(0, 7)}`);
      }
      ctx.xref = await new Xref(store).load();
      ctx.ci = new CI(store, { localDirs: this.options.pwResults || [], urlPrefix: `/ci/${ctx.slug}` });
      ctx.git = await findLocalClone(ref, { explicit: this.options.repoPath || null, configured: repoConfig.repoPath }).catch(() => null);
      if (ctx.git) this.log(`  local clone: ${ctx.git.dir}`);
      ctx.initializing = null;
    })();
    await ctx.initializing;
    return ctx;
  }

  async ctxFor(param) {
    const ref = parsePrParam(param);
    if (ref) return this.open(ref);
    if (this.lastKey) return this.contexts.get(this.lastKey);
    throw Object.assign(new Error("No pull request selected"), { status: 400 });
  }

  /** PRs known locally (have a data dir), with a cheap progress summary. */
  async known() {
    const dir = this.dataRoot;
    let entries = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of entries) {
      const m = name.match(/^(.+)__(.+)__(\d+)$/);
      if (!m) continue;
      try {
        const st = JSON.parse(await fs.readFile(path.join(dir, name, "state.json"), "utf8"));
        if (!st.pr) continue;
        const review = st.review || {};
        const done = Object.values(review).filter((r) => ["reviewed", "skimmed", "flagged"].includes(r.status)).length;
        const flagged = Object.values(review).filter((r) => r.status === "flagged").length;
        const stat = await fs.stat(path.join(dir, name, "state.json"));
        out.push({
          owner: m[1],
          repo: m[2],
          number: Number(m[3]),
          title: st.pr.title,
          author: st.pr.author,
          state: st.pr.state,
          url: st.pr.url,
          headSha: st.pr.headSha,
          changedFiles: st.pr.changedFiles,
          additions: st.pr.additions,
          deletions: st.pr.deletions,
          done,
          flagged,
          lastSyncAt: st.lastSyncAt,
          lastActivity: stat.mtime.toISOString(),
          open: this.contexts.has(`${m[1]}/${m[2]}#${m[3]}`),
        });
      } catch {}
    }
    return out.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  /**
   * Cached discovery (stale-while-revalidate): returns the last result immediately and refreshes in the
   * background when it is older than `ttlMs`. Persisted so the first picker render after a restart is instant.
   */
  async discoverCached(repo, { ttlMs = 5 * 60 * 1000, force = false } = {}) {
    const key = repo || "(none)";
    this._discoverCache ||= new Map();
    this._discoverInflight ||= new Map();
    const file = path.join(this.dataRoot, "prs-cache.json");
    if (!this._discoverCache.size) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(await fs.readFile(file, "utf8")))) this._discoverCache.set(k, v);
      } catch {}
    }
    const cached = this._discoverCache.get(key);
    const age = cached ? Date.now() - new Date(cached.cachedAt).getTime() : Infinity;
    const refresh = () => {
      if (this._discoverInflight.has(key)) return this._discoverInflight.get(key);
      const p = this.discover(repo)
        .then(async (d) => {
          const entry = { ...d, cachedAt: new Date().toISOString() };
          this._discoverCache.set(key, entry);
          await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
          await fs.writeFile(file, JSON.stringify(Object.fromEntries(this._discoverCache))).catch(() => {});
          return entry;
        })
        .finally(() => this._discoverInflight.delete(key));
      this._discoverInflight.set(key, p);
      return p;
    };
    if (cached && !force) {
      if (age > ttlMs) refresh().catch(() => {});
      return { ...cached, stale: age > ttlMs, refreshing: age > ttlMs };
    }
    const fresh = await refresh();
    return { ...fresh, stale: false, refreshing: false };
  }

  /** Open PRs on GitHub for a repo, plus ones where the user is requested as reviewer. */
  async discover(repo) {
    const out = { repo, open: [], requested: [] };
    if (repo) {
      const [owner, name] = repo.split("/");
      const prs = await gh.api(`repos/${owner}/${name}/pulls?state=open&per_page=40&sort=updated&direction=desc`).catch(() => []);
      out.open = prs.map(brief);
    }
    const viewer = await gh.fetchViewer().catch(() => null);
    if (viewer) {
      const res = await gh.api(`search/issues?q=${encodeURIComponent(`is:pr is:open review-requested:${viewer}`)}&per_page=30&sort=updated`).catch(() => null);
      out.requested = (res?.items || []).map((i) => {
        const m = i.repository_url.match(/repos\/([^/]+)\/([^/]+)$/);
        return { owner: m?.[1], repo: m?.[2], number: i.number, title: i.title, author: i.user?.login, url: i.html_url, updatedAt: i.updated_at, draft: i.draft, labels: (i.labels || []).map((l) => l.name) };
      });
    }
    return out;
  }
}

function brief(pr) {
  return {
    owner: pr.base?.repo?.owner?.login,
    repo: pr.base?.repo?.name,
    number: pr.number,
    title: pr.title,
    author: pr.user?.login,
    url: pr.html_url,
    updatedAt: pr.updated_at,
    draft: pr.draft,
    baseRef: pr.base?.ref,
    headRef: pr.head?.ref,
    labels: (pr.labels || []).map((l) => l.name),
    requestedReviewers: (pr.requested_reviewers || []).map((u) => u.login),
  };
}
