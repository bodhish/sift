// Stories: decompose an umbrella PR into the sub-PRs that were merged into it (stacked PRs included),
// attribute files to the PR whose own commits touched them, and enrich with GitHub metadata.
import fs from "node:fs/promises";
import path from "node:path";
import * as gh from "./github.mjs";

const MERGE_RE = /^Merge pull request #(\d+) from (\S+)/;

export class Stories {
  constructor(ctx) {
    this.ctx = ctx;
    this.file = path.join(ctx.store.dir, "stories.json");
    this.data = null;
    this.building = null;
  }

  invalidate() {
    if (this.data && this.data.headSha !== this.ctx.store.state.pr?.headSha) this.data = null;
  }

  async load() {
    try {
      const d = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (d.headSha === this.ctx.store.state.pr?.headSha && d.version === 3) this.data = d;
    } catch {}
    return this;
  }

  async get() {
    this.invalidate();
    if (this.data) return this.data;
    if (!this.building) this.building = this.build().finally(() => (this.building = null));
    return this.building;
  }

  async build() {
    const { store, git } = this.ctx;
    const pr = store.state.pr;
    const base = await store.mergeBase();
    const head = pr.headSha;
    const stories = [];
    const direct = { commits: [], files: new Map() };
    let source = "api";

    const useGit = git && (await git.ensurePr(pr.number, head)) && (await git.hasCommit(base));
    if (useGit) {
      source = "git";
      await this.walkGit(git, base, head, null, stories, direct);
    } else {
      await this.walkApi(base, head, stories, direct);
    }

    // file attribution: primary story = the one whose own commits changed the most lines of the file
    const fileStories = {};
    const consider = (p, storyNumber, lines) => {
      (fileStories[p] ||= []).push({ story: storyNumber, lines });
    };
    for (const s of stories) for (const [p, n] of s.files) consider(p, s.number, n);
    for (const [p, n] of direct.files) consider(p, 0, n);
    const primary = {};
    for (const [p, arr] of Object.entries(fileStories)) {
      arr.sort((a, b) => b.lines - a.lines);
      primary[p] = arr[0].story;
    }
    // unattributed PR files (e.g. attribution failed) → story 0 (direct)
    for (const p of Object.keys(store.files)) if (!(p in primary)) primary[p] = 0;

    // enrich from GitHub (titles, bodies, issues, review counts)
    const { owner, repo } = store.ref;
    const enriched = [];
    for (const s of stories) {
      let meta = {};
      try {
        const d = await gh.api(`repos/${owner}/${repo}/pulls/${s.number}`);
        meta = {
          title: d.title,
          body: d.body || "",
          author: d.user?.login,
          mergedAt: d.merged_at,
          createdAt: d.created_at,
          url: d.html_url,
          reviewComments: d.review_comments,
          comments: d.comments,
          commitCount: d.commits,
          additions: d.additions,
          deletions: d.deletions,
          changedFiles: d.changed_files,
          baseRef: d.base?.ref,
          headRef: d.head?.ref,
          labels: (d.labels || []).map((l) => l.name),
          issues: linkedIssues(d.body || ""),
        };
      } catch (err) {
        meta = { title: `#${s.number} (${s.branch})`, body: "", error: err.message, issues: [] };
      }
      enriched.push({
        number: s.number,
        branch: s.branch,
        mergeSha: s.mergeSha,
        parent: s.parent,
        depth: s.depth,
        commitShas: s.commits.map((c) => c.sha),
        commits: s.commits.map((c) => ({ sha: c.sha, subject: c.subject, author: c.author, date: c.date })),
        files: [...s.files.keys()].filter((p) => store.files[p]),
        ownFileCount: s.files.size,
        ...meta,
      });
    }
    // linked issue titles (best effort, de-duplicated)
    const issueNums = [...new Set(enriched.flatMap((s) => s.issues))].slice(0, 40);
    const issues = {};
    await Promise.all(
      issueNums.map(async (n) => {
        try {
          const i = await gh.api(`repos/${owner}/${repo}/issues/${n}`);
          issues[n] = { number: n, title: i.title, state: i.state, url: i.html_url, labels: (i.labels || []).map((l) => l.name) };
        } catch {}
      }),
    );
    // order: reading order = parents before children (stack order), siblings by merge time
    const byParent = new Map();
    for (const st of enriched) {
      const k = st.parent == null ? "root" : st.parent;
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(st);
    }
    for (const arr of byParent.values()) arr.sort((a, b) => (a.mergedAt || "").localeCompare(b.mergedAt || "") || a.number - b.number);
    const ordered = [];
    const visit = (k) => {
      for (const st of byParent.get(k) || []) {
        ordered.push(st);
        visit(st.number);
      }
    };
    visit("root");
    for (const st of enriched) if (!ordered.includes(st)) ordered.push(st);
    enriched.length = 0;
    enriched.push(...ordered);
    const directStory = {
      number: 0,
      title: "Direct commits on the PR branch",
      branch: pr.headRef,
      commits: direct.commits.map((c) => ({ sha: c.sha, subject: c.subject, author: c.author, date: c.date })),
      files: [...direct.files.keys()].filter((p) => store.files[p]),
      ownFileCount: direct.files.size,
      issues: [],
      body: "",
    };
    this.data = { version: 3, headSha: head, source, stories: enriched, direct: directStory, primary, issues, builtAt: new Date().toISOString() };
    await fs.writeFile(this.file, JSON.stringify(this.data));
    return this.data;
  }

  /** Recursive first-parent walk using the local clone. */
  async walkGit(git, from, to, parent, stories, direct, depth = 0) {
    const log = await git.firstParentLog(from, to);
    for (const c of log) {
      const m = c.subject.match(MERGE_RE);
      if (c.parents.length > 1 && m) {
        const story = { number: Number(m[1]), branch: m[2].replace(/^[^/]+\//, ""), mergeSha: c.sha, parent, depth, commits: [], files: new Map() };
        stories.push(story);
        const mb = await git.mergeBase(c.parents[0], c.parents[1]).catch(() => from);
        await this.walkGit(git, mb, c.parents[1], story.number, stories, direct, depth + 1);
        continue;
      }
      if (c.parents.length > 1) continue; // sync merge (e.g. develop into branch): not PR work
      const target = parent == null ? direct : stories.find((s) => s.number === parent);
      target.commits.push(c);
      for (const f of await git.commitFiles(c.sha)) {
        const lines = f.additions + f.deletions;
        target.files.set(f.path, (target.files.get(f.path) || 0) + lines);
      }
    }
  }

  /** API fallback: same idea with repos/{o}/{r}/commits/{sha} (parents + files). */
  async walkApi(from, to, stories, direct, parent = null, depth = 0, budget = { calls: 0 }) {
    const { owner, repo } = this.ctx.store.ref;
    let cur = to;
    const seen = new Set();
    while (cur && cur !== from && !seen.has(cur) && budget.calls < 400) {
      seen.add(cur);
      budget.calls++;
      let c;
      try {
        c = await gh.api(`repos/${owner}/${repo}/commits/${cur}`);
      } catch {
        break;
      }
      const subject = (c.commit?.message || "").split("\n")[0];
      const parents = (c.parents || []).map((p) => p.sha);
      const m = subject.match(MERGE_RE);
      if (parents.length > 1 && m) {
        const story = { number: Number(m[1]), branch: m[2].replace(/^[^/]+\//, ""), mergeSha: cur, parent, depth, commits: [], files: new Map() };
        stories.push(story);
        let mb = from;
        try {
          mb = (await gh.api(`repos/${owner}/${repo}/compare/${parents[0]}...${parents[1]}?per_page=1&page=9999`)).merge_base_commit?.sha || from;
          budget.calls++;
        } catch {}
        await this.walkApi(mb, parents[1], stories, direct, story.number, depth + 1, budget);
      } else if (parents.length <= 1) {
        const target = parent == null ? direct : stories.find((s) => s.number === parent);
        target.commits.push({ sha: cur, subject, author: c.author?.login || c.commit?.author?.name, date: c.commit?.author?.date });
        for (const f of c.files || []) target.files.set(f.filename, (target.files.get(f.filename) || 0) + (f.changes || 0));
      }
      cur = parents[0];
    }
  }
}

export function linkedIssues(body) {
  const out = new Set();
  for (const m of body.matchAll(/\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s*(?:https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/)?#?(\d+)/gi)) out.add(Number(m[1]));
  return [...out];
}
