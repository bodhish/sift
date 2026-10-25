// Local clone integration: exact git data (first-parent history, per-commit files, grep, churn)
// when a checkout of the repository exists on this machine.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export class LocalGit {
  constructor(dir, ref) {
    this.dir = dir;
    this.ref = ref; // { owner, repo }
    this.remote = null;
    this.fetched = new Set();
  }

  async git(args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
    const { stdout } = await execFileP("git", ["-C", this.dir, ...args], { maxBuffer });
    return stdout;
  }

  /** Name of the remote that points at owner/repo (origin, upstream, …). */
  async findRemote() {
    if (this.remote) return this.remote;
    const out = await this.git(["remote", "-v"]);
    const want = `${this.ref.owner}/${this.ref.repo}`.toLowerCase();
    for (const line of out.split("\n")) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
      if (m && m[2].toLowerCase().replace(/\.git$/, "").endsWith(want)) {
        this.remote = m[1];
        return m[1];
      }
    }
    return null;
  }

  async hasCommit(sha) {
    try {
      await this.git(["cat-file", "-e", `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Make sure the PR head (and its history) is available locally. */
  async ensurePr(number, headSha) {
    if (await this.hasCommit(headSha)) return true;
    const remote = await this.findRemote();
    if (!remote) return false;
    const key = `${number}:${headSha}`;
    if (this.fetched.has(key)) return this.hasCommit(headSha);
    this.fetched.add(key);
    try {
      await this.git(["fetch", "-q", remote, `pull/${number}/head`]);
    } catch {}
    return this.hasCommit(headSha);
  }

  async ensureRef(refName) {
    const remote = await this.findRemote();
    if (!remote) return false;
    try {
      await this.git(["fetch", "-q", remote, refName]);
      return true;
    } catch {
      return false;
    }
  }

  async mergeBase(a, b) {
    return (await this.git(["merge-base", a, b])).trim();
  }

  /** First-parent commits in range (oldest last), with parents and subject. */
  async firstParentLog(from, to) {
    const out = await this.git(["log", "--first-parent", "--format=%H%x1f%P%x1f%s%x1f%an%x1f%aI", `${from}..${to}`]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, parents, subject, author, date] = l.split("\x1f");
        return { sha, parents: parents.split(" ").filter(Boolean), subject, author, date };
      });
  }

  /** Files changed by one commit (its own diff vs first parent), with numstat. */
  async commitFiles(sha) {
    const out = await this.git(["diff-tree", "--no-commit-id", "--numstat", "-r", "-M", "--root", sha]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [add, del, file] = l.split("\t");
        const renamed = file?.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
        const p = renamed ? `${renamed[1]}${renamed[3]}${renamed[4]}` : file?.includes(" => ") ? file.split(" => ").pop() : file;
        return { path: p, additions: add === "-" ? 0 : Number(add), deletions: del === "-" ? 0 : Number(del) };
      });
  }

  async show(sha, filePath) {
    try {
      return await this.git(["show", `${sha}:${filePath}`]);
    } catch {
      return null;
    }
  }

  /** Repo-wide word search at a commit; returns [{ path, line, text }]. */
  async grep(sha, word, { max = 200, pathspecs = [] } = {}) {
    try {
      const out = await this.git(["grep", "-n", "-w", "-I", "--", word, sha, ...(pathspecs.length ? ["--", ...pathspecs] : [])].filter(Boolean), { maxBuffer: 16 * 1024 * 1024 });
      return out
        .split("\n")
        .filter(Boolean)
        .slice(0, max)
        .map((l) => {
          const m = l.match(/^[^:]+:([^:]+):(\d+):(.*)$/);
          return m ? { path: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 160) } : null;
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Churn/age per path on the base branch: commits in the last `months`, last touched, authors. */
  async churn(baseRef, paths, { months = 6 } = {}) {
    const result = new Map();
    if (!paths.length) return result;
    const out = await this.git(["log", `--since=${months} months ago`, "--format=%x1e%H%x1f%an%x1f%aI", "--name-only", baseRef, "--", ...paths], { maxBuffer: 128 * 1024 * 1024 }).catch(() => "");
    for (const chunk of out.split("\x1e")) {
      if (!chunk.trim()) continue;
      const [head, ...files] = chunk.trim().split("\n");
      const [, author, date] = head.split("\x1f");
      for (const f of files) {
        if (!f) continue;
        const r = result.get(f) || { commits: 0, authors: new Set(), last: null };
        r.commits++;
        r.authors.add(author);
        if (!r.last || date > r.last) r.last = date;
        result.set(f, r);
      }
    }
    for (const [k, v] of result) result.set(k, { commits: v.commits, authors: [...v.authors], last: v.last });
    return result;
  }
}

/** Locate a local clone of owner/repo: explicit path, config, or common folders. */
export async function findLocalClone(ref, { explicit = null, configured = null } = {}) {
  const home = os.homedir();
  const names = [ref.repo, `${ref.owner}-${ref.repo}`, `${ref.owner}__${ref.repo}`];
  const roots = [home, ...["code", "src", "dev", "projects", "project", "work", "github", "repos", "git", "Developer", "Documents", "workspace", "workspaces"].map((d) => path.join(home, d))];
  const candidates = [explicit, configured].filter(Boolean).map((p) => p.replace(/^~/, home));
  for (const r of roots) for (const n of names) candidates.push(path.join(r, n), path.join(r, ref.owner, n));
  for (const dir of candidates) {
    try {
      await fs.access(path.join(dir, ".git"));
    } catch {
      continue;
    }
    const g = new LocalGit(dir, ref);
    if (await g.findRemote()) return g;
  }
  return null;
}
