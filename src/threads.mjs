// Review threads: what humans and bots already said on this PR and on the sub-PRs merged into it,
// re-anchored to current line numbers so they show up inline while reviewing.
import fs from "node:fs/promises";
import path from "node:path";
import * as gh from "./github.mjs";

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine startLine diffSide
          comments(first: 50) {
            nodes { databaseId url body createdAt outdated diffHunk author { login __typename } }
          }
        }
      }
    }
  }
}`;
const SUMMARY_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(first: 60) { nodes { url body state submittedAt author { login __typename } } }
      comments(first: 60) { nodes { url body createdAt author { login __typename } } }
    }
  }
}`;

export class Threads {
  constructor(ctx) {
    this.ctx = ctx;
    this.file = path.join(ctx.store.dir, "threads.json");
    this.data = null;
    this.loading = null;
  }

  invalidate() {
    this.data = null;
  }

  async load() {
    try {
      const d = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (d.version === 1) this.data = d;
    } catch {}
    return this;
  }

  async get({ refresh = false } = {}) {
    if (this.data && !refresh && this.data.headSha === this.ctx.store.state.pr?.headSha) return this.data;
    if (!this.loading) this.loading = this.fetchAll().finally(() => (this.loading = null));
    return this.loading;
  }

  async fetchAll() {
    const { store, repoConfig } = this.ctx;
    const { owner, repo, number } = store.ref;
    const prs = [{ number, kind: "pr" }];
    if (this.ctx.stories) {
      const s = await this.ctx.stories.get().catch(() => null);
      for (const st of s?.stories || []) prs.push({ number: st.number, kind: "story", title: st.title });
    }
    const bots = new Set((repoConfig.bots || []).map((b) => b.toLowerCase()));
    const isBot = (a) => !a || a.__typename === "Bot" || bots.has((a.login || "").toLowerCase()) || /\[bot\]$/.test(a.login || "");
    const threads = [];
    const prLevel = [];
    for (const p of prs) {
      let after = null;
      do {
        const data = await gh.graphql(THREADS_QUERY, { owner, repo, number: p.number, after });
        const conn = data?.repository?.pullRequest?.reviewThreads;
        for (const t of conn?.nodes || []) {
          const comments = (t.comments?.nodes || []).map((c) => ({ id: c.databaseId, url: c.url, body: c.body, at: c.createdAt, author: c.author?.login || "ghost", bot: isBot(c.author), outdated: c.outdated }));
          if (!comments.length) continue;
          threads.push({
            id: t.id,
            pr: p.number === number ? 0 : p.number,
            prTitle: p.title || null,
            path: t.path,
            ghLine: t.line,
            originalLine: t.originalLine,
            startLine: t.startLine,
            side: t.diffSide || "RIGHT",
            resolved: Boolean(t.isResolved),
            outdated: Boolean(t.isOutdated),
            diffHunk: comments[0] && (t.comments.nodes[0].diffHunk || ""),
            comments,
            bot: comments.every((c) => c.bot),
            url: comments[0].url,
          });
        }
        after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
      } while (after);
      try {
        const d = await gh.graphql(SUMMARY_QUERY, { owner, repo, number: p.number });
        const prq = d?.repository?.pullRequest;
        for (const r of prq?.reviews?.nodes || []) if (r.body?.trim()) prLevel.push({ pr: p.number === number ? 0 : p.number, kind: "review", state: r.state, author: r.author?.login || "ghost", bot: isBot(r.author), body: r.body, at: r.submittedAt, url: r.url });
        for (const c of prq?.comments?.nodes || []) if (c.body?.trim()) prLevel.push({ pr: p.number === number ? 0 : p.number, kind: "comment", author: c.author?.login || "ghost", bot: isBot(c.author), body: c.body, at: c.createdAt, url: c.url });
      } catch {}
    }
    await this.anchor(threads);
    for (const t of threads) {
      t.summary = firstLine(t.comments[0]?.body);
      delete t.diffHunk;
    }
    const byFile = {};
    for (const t of threads) {
      const f = (byFile[t.path] ||= { total: 0, open: 0, resolved: 0, bot: 0, human: 0 });
      f.total++;
      if (t.resolved) f.resolved++;
      else f.open++;
      if (t.bot) f.bot++;
      else f.human++;
    }
    this.data = { version: 1, headSha: store.state.pr.headSha, fetchedAt: new Date().toISOString(), prs: prs.map((p) => p.number), threads, prLevel, byFile };
    await fs.writeFile(this.file, JSON.stringify(this.data));
    return this.data;
  }

  /** Map each thread to a line in the current head version of its file. */
  async anchor(threads) {
    const { store, xref } = this.ctx;
    const contentCache = new Map();
    const contentOf = async (p) => {
      if (!contentCache.has(p)) {
        const f = store.files[p];
        let text = null;
        if (f && f.status !== "removed") text = xref ? await xref.newContent(f).catch(() => null) : await store.headContent(f).catch(() => null);
        contentCache.set(p, text ? text.split("\n") : null);
      }
      return contentCache.get(p);
    };
    for (const t of threads) {
      const inPr = Boolean(store.files[t.path]);
      t.inPr = inPr;
      t.line = null;
      t.approx = false;
      if (!inPr) continue;
      const lines = await contentOf(t.path);
      if (!lines) {
        t.line = t.ghLine || t.originalLine || null;
        t.approx = true;
        continue;
      }
      const candidate = t.ghLine || t.originalLine;
      const hunkLast = lastHunkLine(t.diffHunk);
      // Exact when the hunk's last line still sits at the recorded line number.
      if (candidate && hunkLast != null && norm(lines[candidate - 1]) === hunkLast) {
        t.line = candidate;
        continue;
      }
      if (hunkLast != null) {
        const hits = [];
        for (let i = 0; i < lines.length && hits.length < 3; i++) if (norm(lines[i]) === hunkLast) hits.push(i + 1);
        if (hits.length === 1) {
          t.line = hits[0];
          t.approx = true;
          continue;
        }
        if (hits.length > 1 && candidate) {
          t.line = hits.reduce((best, h) => (Math.abs(h - candidate) < Math.abs(best - candidate) ? h : best), hits[0]);
          t.approx = true;
          continue;
        }
      }
      if (candidate && candidate <= lines.length) {
        t.line = candidate;
        t.approx = true;
      }
    }
  }

  forFile(p) {
    return (this.data?.threads || []).filter((t) => t.path === p);
  }
}

function lastHunkLine(hunk) {
  if (!hunk) return null;
  const lines = hunk.split("\n").filter((l) => !l.startsWith("@@") && !l.startsWith("-"));
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/^[+ ]/, "");
    if (l.trim()) return norm(l);
  }
  return null;
}
function norm(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function firstLine(body) {
  const text = String(body || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`#>]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 2);
  return (text || "").slice(0, 160);
}
