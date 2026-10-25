// Thin wrapper around the `gh` CLI so Sift reuses the user's existing GitHub auth.
import { spawn } from "node:child_process";

const MAX_BUFFER = 256 * 1024 * 1024;

export class GitHubError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.body = body;
  }
}

async function gh(args, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await ghOnce(args, opts);
    } catch (err) {
      lastErr = err;
      const transient = !err.status && /dial tcp|no route|timeout|EOF|connection reset|TLS handshake|temporarily/i.test(err.message);
      if (!transient || attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function ghOnce(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { env: { ...process.env, GH_PAGER: "", GH_PROMPT_DISABLED: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let size = 0;
    child.stdout.on("data", (c) => {
      size += c.length;
      if (size > MAX_BUFFER) child.kill();
      out.push(c);
    });
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => reject(new GitHubError(e.message)));
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      if (code === 0) return resolve(stdout);
      const stderr = Buffer.concat(err).toString("utf8").trim();
      const match = stderr.match(/HTTP (\d{3})/);
      reject(new GitHubError(stderr || stdout.slice(0, 500) || `gh exited with ${code}`, { status: match ? Number(match[1]) : undefined, body: stderr }));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** JSON API call. `paginate` concatenates array pages into one array. */
export async function api(path, { paginate = false, accept, method = "GET", body, raw = false } = {}) {
  const args = ["api", path, "-X", method];
  if (paginate) args.push("--paginate", "--slurp");
  if (accept) args.push("-H", `Accept: ${accept}`);
  let input;
  if (body !== undefined) {
    args.push("--input", "-");
    input = JSON.stringify(body);
  }
  const out = await gh(args, { input });
  if (raw) return out;
  if (!out.trim()) return null;
  const parsed = JSON.parse(out);
  if (paginate) return parsed.flat();
  return parsed;
}

/**
 * Accepts: full PR URL, "owner/repo#123", "owner/repo/pull/123", or "123" with an explicit repo.
 */
export function parsePrRef(input, fallbackRepo) {
  const s = String(input || "").trim();
  let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number: Number(m[3]) };
  m = s.match(/^([^/\s]+)\/([^/#\s]+)[#/](?:pull\/)?(\d+)$/);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) };
  m = s.match(/^#?(\d+)$/);
  if (m && fallbackRepo) {
    const [owner, repo] = fallbackRepo.split("/");
    if (owner && repo) return { owner, repo, number: Number(m[1]) };
  }
  throw new Error(
    `Could not parse PR reference "${input}". Use a URL like https://github.com/owner/repo/pull/123, owner/repo#123, or a number with --repo owner/repo.`,
  );
}

export async function fetchPullRequest({ owner, repo, number }) {
  const pr = await api(`repos/${owner}/${repo}/pulls/${number}`);
  return {
    owner,
    repo,
    number,
    title: pr.title,
    body: pr.body || "",
    state: pr.state,
    draft: pr.draft,
    url: pr.html_url,
    author: pr.user?.login,
    baseRef: pr.base?.ref,
    baseSha: pr.base?.sha,
    headRef: pr.head?.ref,
    headSha: pr.head?.sha,
    headRepo: pr.head?.repo?.full_name,
    changedFiles: pr.changed_files,
    additions: pr.additions,
    deletions: pr.deletions,
    commitCount: pr.commits,
    updatedAt: pr.updated_at,
    mergeable: pr.mergeable,
    reviewComments: pr.review_comments,
    labels: (pr.labels || []).map((l) => l.name),
  };
}

export async function fetchFiles({ owner, repo, number }) {
  const files = await api(`repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, { paginate: true });
  return files.map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename || null,
    status: f.status, // added | modified | removed | renamed | copied | changed | unchanged
    sha: f.sha,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    patch: f.patch ?? null, // null when GitHub considers the diff too large
    blobUrl: f.blob_url,
  }));
}

export async function fetchCommits({ owner, repo, number }) {
  const commits = await api(`repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`, { paginate: true });
  return commits.map((c) => ({
    sha: c.sha,
    message: c.commit?.message || "",
    author: c.author?.login || c.commit?.author?.name || "",
    date: c.commit?.author?.date || c.commit?.committer?.date || null,
  }));
}

/** Raw blob content by blob SHA. Works even after force-pushes as long as the blob exists. */
export async function fetchBlob({ owner, repo }, sha) {
  const blob = await api(`repos/${owner}/${repo}/git/blobs/${sha}`);
  if (blob.encoding === "base64") return Buffer.from(blob.content, "base64").toString("utf8");
  return blob.content ?? "";
}

/** Raw file content at a ref (commit SHA / branch). Returns null on 404. */
export async function fetchContentAtRef({ owner, repo }, path, ref) {
  try {
    return await api(`repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, {
      accept: "application/vnd.github.raw",
      raw: true,
    });
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Merge base of the PR (what GitHub diffs against). Requests a far page to keep the payload small. */
export async function fetchMergeBase({ owner, repo }, baseRef, headSha) {
  const res = await api(
    `repos/${owner}/${repo}/compare/${encodeURIComponent(baseRef)}...${headSha}?per_page=1&page=9999`,
  );
  return res?.merge_base_commit?.sha || null;
}

export async function createPendingReview({ owner, repo, number }, { commitId, body, comments, event }) {
  // Omitting `event` leaves the review in PENDING state so it can be finished on github.com;
  // COMMENT / APPROVE / REQUEST_CHANGES submit it immediately.
  return api(`repos/${owner}/${repo}/pulls/${number}/reviews`, {
    method: "POST",
    body: { commit_id: commitId, body, comments, ...(event ? { event } : {}) },
  });
}

/** Inline comments belonging to one review (works for the author's own pending review too). */
export async function fetchReviewComments({ owner, repo, number }, reviewId) {
  return api(`repos/${owner}/${repo}/pulls/${number}/reviews/${reviewId}/comments?per_page=100`, { paginate: true });
}

export async function updateReviewComment({ owner, repo }, commentId, body) {
  return api(`repos/${owner}/${repo}/pulls/comments/${commentId}`, { method: "PATCH", body: { body } });
}

export async function deleteReviewComment({ owner, repo }, commentId) {
  return api(`repos/${owner}/${repo}/pulls/comments/${commentId}`, { method: "DELETE" });
}

/** Replace the summary body of a review (pending or submitted). */
export async function updateReviewBody({ owner, repo, number }, reviewId, body) {
  return api(`repos/${owner}/${repo}/pulls/${number}/reviews/${reviewId}`, { method: "PUT", body: { body } });
}

export async function fetchViewer() {
  try {
    const u = await api("user");
    return u?.login || null;
  } catch {
    return null;
  }
}

function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** GraphQL query via `gh api graphql`. */
export async function graphql(query, variables = {}) {
  const out = await api("graphql", { method: "POST", body: { query, variables } });
  if (out?.errors?.length && !out.data) throw new GitHubError(out.errors.map((e) => e.message).join("; "));
  return out.data;
}
