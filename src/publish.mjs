import * as gh from "./github.mjs";

const STATUS_LABEL = { reviewed: "Reviewed", skimmed: "Skimmed", flagged: "Flagged", deferred: "Deferred", unreviewed: "Unreviewed" };

export function markdownReport(store) {
  const snap = store.snapshot();
  const { pr, stats } = snap;
  const lines = [];
  lines.push(`# Review notes — ${snap.ref.owner}/${snap.ref.repo} #${snap.ref.number}: ${pr.title}`);
  lines.push("");
  lines.push(`- PR: ${pr.url}`);
  lines.push(`- Head: \`${pr.headSha.slice(0, 10)}\` · synced ${snap.lastSyncAt}`);
  lines.push(
    `- Progress: **${stats.done}/${stats.total}** files covered (${stats.byStatus.reviewed} reviewed · ${stats.byStatus.skimmed} skimmed · ${stats.byStatus.flagged} flagged · ${stats.byStatus.deferred} deferred · ${stats.stale} stale)`,
  );
  lines.push("");

  const droppedWithNotes = (snap.dropped || []).filter((d) => d.review?.notes?.length).map((d) => ({ ...d, additions: d.additions || 0, deletions: d.deletions || 0, dropped: true }));
  const withNotes = [...snap.files.filter((f) => f.review?.notes?.length), ...droppedWithNotes];
  const flagged = snap.files.filter((f) => f.review?.status === "flagged");
  const deferred = snap.files.filter((f) => f.review?.status === "deferred");
  const stale = snap.files.filter((f) => f.stale);

  lines.push(`## Findings (${withNotes.length} files with notes)`);
  lines.push("");
  if (!withNotes.length) lines.push("_No notes yet._");
  for (const f of withNotes.sort((a, b) => a.path.localeCompare(b.path))) {
    const flag = f.review.status === "flagged" ? " ⚑" : "";
    lines.push(`### \`${f.path}\`${flag}  (+${f.additions} −${f.deletions})${f.dropped ? "  _(no longer in the PR)_" : ""}`);
    lines.push("");
    for (const n of f.review.notes) {
      const anchor = n.line != null ? `L${n.line}${n.endLine && n.endLine !== n.line ? `–${n.endLine}` : ""}${n.side === "LEFT" ? " (old)" : ""}: ` : "";
      lines.push(`- ${anchor}${n.kind ? `**${n.kind}:** ` : ""}${n.text.replace(/\n/g, "\n  ")}`);
    }
    lines.push("");
  }

  if (flagged.some((f) => !f.review.notes?.length)) {
    lines.push("## Flagged without notes");
    lines.push("");
    for (const f of flagged.filter((f) => !f.review.notes?.length)) lines.push(`- \`${f.path}\``);
    lines.push("");
  }
  if (deferred.length) {
    lines.push(`## Deferred (${deferred.length})`);
    lines.push("");
    for (const f of deferred) lines.push(`- \`${f.path}\` (+${f.additions} −${f.deletions})`);
    lines.push("");
  }
  if (stale.length) {
    lines.push(`## Changed since review (${stale.length})`);
    lines.push("");
    for (const f of stale) lines.push(`- \`${f.path}\` — ${STATUS_LABEL[f.review.status]} at \`${(f.review.sha || "").slice(0, 7)}\`, now \`${f.sha.slice(0, 7)}\``);
    lines.push("");
  }
  return lines.join("\n");
}

/** Build the payload for a pending GitHub review from unpublished notes. */
const KIND_LABEL = { issue: "issue", suggestion: "suggestion", nitpick: "nitpick", question: "question", praise: "praise", thought: "thought" };
function decorate(n) {
  const label = n.kind ? `**${KIND_LABEL[n.kind] || n.kind}:** ` : "";
  // Conventional Comments prefix; suggestion fences must stay at line start to render.
  if (/^```suggestion/.test(n.text)) return label ? `${label}\n\n${n.text}` : n.text;
  return label + n.text;
}

/** New-side (RIGHT) and old-side (LEFT) line numbers GitHub accepts inline comments on: lines inside hunks. */
function commentableLines(patch) {
  const right = new Set();
  const left = new Set();
  let oldNo = 0;
  let newNo = 0;
  for (const raw of (patch || "").split("\n")) {
    const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      continue;
    }
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) right.add(newNo++);
    else if (raw.startsWith("-")) left.add(oldNo++);
    else {
      right.add(newNo++);
      left.add(oldNo++);
    }
  }
  return { right, left };
}

/** Build the review payload from unpublished notes, preflighted so GitHub won't reject the whole batch. */
export async function buildReviewPayload(store, { onlyUnpublished = true, skipChanged = false } = {}) {
  const snap = store.snapshot();
  const comments = [];
  const bodyParts = [];
  const published = [];
  const inline = [];
  const demoted = [];
  const changed = [];
  for (const f of snap.files) {
    let notes = (f.review?.notes || []).filter((n) => !onlyUnpublished || !n.publishedAt);
    if (!notes.length) continue;
    const moved = notes.filter((n) => n.line != null && n.sha && n.sha !== f.sha);
    for (const n of moved) changed.push({ path: f.path, id: n.id, line: n.line });
    if (skipChanged) notes = notes.filter((n) => !moved.includes(n));
    if (!notes.length) continue;
    const lines = commentableLines(await store.patchFor(f.path).catch(() => f.patch || ""));
    const fileLevel = [];
    for (const n of notes) {
      // GitHub only accepts inline comments on lines that exist on the chosen side *inside the diff hunks*.
      let side = n.side || "RIGHT";
      if (f.status === "removed") side = "LEFT";
      const set = side === "LEFT" ? lines.left : lines.right;
      const inHunk = n.line != null && set.has(n.line) && (!n.endLine || set.has(n.endLine));
      const canInline = inHunk && !(f.status === "added" && side === "LEFT");
      if (n.line != null && !canInline) demoted.push({ path: f.path, id: n.id, line: n.line });
      if (canInline) {
        const c = { path: f.path, body: decorate(n), line: n.line, side };
        if (n.endLine && n.endLine > n.line) {
          c.start_line = n.line;
          c.start_side = c.side;
          c.line = n.endLine;
        }
        comments.push(c);
        inline.push({ path: f.path, id: n.id, line: c.line, side: c.side, body: c.body });
      } else {
        fileLevel.push(n);
      }
      published.push({ path: f.path, id: n.id });
    }
    if (fileLevel.length) {
      bodyParts.push(fileSection(f.path, fileLevel));
    }
  }
  const body = bodyParts.length ? bodyParts.join("\n\n") : "";
  return { comments, body, published, inline, demoted, changed, counts: { inline: comments.length, fileLevel: bodyParts.length, demoted: demoted.length, changed: changed.length } };
}
function fileSection(path, notes) {
  return `**\`${path}\`**\n${notes.map((n) => `- ${n.line != null ? `L${n.line}: ` : ""}${decorate(n)}`).join("\n")}`;
}

export async function publishPendingReview(store, { event = "PENDING", summary = "", ...opts } = {}) {
  const payload = await buildReviewPayload(store, opts);
  const body = [summary?.trim(), payload.body].filter(Boolean).join("\n\n");
  if (!payload.comments.length && !body) throw new Error("Nothing to publish — add some notes first.");
  const pr = store.state.pr;
  const res = await gh.createPendingReview(store.ref, {
    commitId: pr.headSha,
    body: body || undefined,
    comments: payload.comments,
    event: event && event !== "PENDING" ? event : undefined,
  });
  const now = new Date().toISOString();
  const inlineIds = new Set(payload.inline.map((x) => x.id));
  for (const { path, id } of payload.published) {
    const n = store.state.review[path]?.notes?.find((x) => x.id === id);
    if (!n) continue;
    n.publishedAt = now;
    // remember where it went so later edits/deletes can follow it to GitHub
    n.remote = { reviewId: res.id, kind: inlineIds.has(id) ? "comment" : "body" };
  }
  const url = res.html_url || `${pr.url}#pullrequestreview-${res.id}`;
  store.state.reviews = [...(store.state.reviews || []), { id: res.id, at: now, summary: summary?.trim() || "", event: event || "PENDING", url, inline: payload.counts.inline, fileLevel: payload.counts.fileLevel }].slice(-50);
  let linked = 0;
  try {
    linked = await linkRemoteComments(store, res.id, payload.inline);
  } catch {}
  await store.save();
  return { reviewId: res.id, url, state: res.state, counts: { ...payload.counts, linked } };
}

/** Pair GitHub review comments with the inline notes we just sent: same path, anchor line, side and body. */
export function matchRemote(remote, inline) {
  const out = new Map();
  const used = new Set();
  const same = (r, x, strict) => r.path === x.path && (r.line ?? r.original_line) === x.line && (r.body || "").trim() === x.body.trim() && (!strict || (r.side || "RIGHT") === x.side);
  for (const x of inline) {
    const c = remote.find((r) => !used.has(r.id) && same(r, x, true)) || remote.find((r) => !used.has(r.id) && same(r, x, false));
    if (!c) continue;
    used.add(c.id);
    out.set(x.id, c);
  }
  return out;
}

/** Match GitHub's comment ids back to our notes so edits and deletes can follow them. */
async function linkRemoteComments(store, reviewId, inline) {
  const remote = await gh.fetchReviewComments(store.ref, reviewId);
  if (!Array.isArray(remote)) return 0;
  let linked = 0;
  for (const [noteId, c] of matchRemote(remote, inline)) {
    const x = inline.find((y) => y.id === noteId);
    const n = store.state.review[x.path]?.notes?.find((y) => y.id === noteId);
    if (!n) continue;
    n.remote = { ...n.remote, id: c.id, url: c.html_url };
    linked++;
  }
  return linked;
}

/** Push a local edit of a published note to GitHub. Returns "updated" | "unlinked". */
export async function syncRemoteNote(store, path, note) {
  if (!note?.remote) return "unlinked";
  if (note.remote.kind === "comment") {
    if (!note.remote.id) return "unlinked";
    await gh.updateReviewComment(store.ref, note.remote.id, decorate(note));
    note.remoteSyncedAt = new Date().toISOString();
    return "updated";
  }
  await syncReviewBody(store, note.remote.reviewId);
  note.remoteSyncedAt = new Date().toISOString();
  return "updated";
}

/** Delete a published note's GitHub side. Returns "deleted" | "unlinked". */
export async function deleteRemoteNote(store, note) {
  if (!note?.remote) return "unlinked";
  if (note.remote.kind === "comment") {
    if (!note.remote.id) return "unlinked";
    await gh.deleteReviewComment(store.ref, note.remote.id);
    return "deleted";
  }
  await syncReviewBody(store, note.remote.reviewId); // the note is already gone locally; rebuild the body without it
  return "deleted";
}

/** Rebuild one review's summary body from the file-level notes that still belong to it. */
async function syncReviewBody(store, reviewId) {
  const rev = (store.state.reviews || []).find((r) => r.id === reviewId);
  const parts = [];
  for (const [path, rec] of Object.entries(store.state.review)) {
    const notes = (rec.notes || []).filter((n) => n.remote?.reviewId === reviewId && n.remote.kind === "body");
    if (notes.length) parts.push(fileSection(path, notes));
  }
  const body = [rev?.summary, parts.join("\n\n")].filter(Boolean).join("\n\n");
  await gh.updateReviewBody(store.ref, reviewId, body || "_(review notes removed in Sift)_");
}
