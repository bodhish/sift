import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as Diff from "diff";
import * as gh from "./github.mjs";
import { areaOf, tierOf, rankOf, riskOf, languageOf } from "./classify.mjs";

export const STATUSES = ["unreviewed", "reviewed", "skimmed", "flagged", "deferred"];
export const NOTE_KINDS = ["issue", "suggestion", "nitpick", "question", "praise", "thought"];
export const DONE_STATUSES = new Set(["reviewed", "skimmed", "flagged"]);

const MAX_EVENTS = 5000;

/** Starter note templates (0–9 in the composer). Edited copies live in <dataRoot>/templates.json, shared by all PRs. */
export const DEFAULT_TEMPLATES = [
  { text: "Needs a secondary review from someone who knows this area.", kind: "thought" },
  { text: "Must be removed before merging.", kind: "issue" },
  { text: "No test covers this change — please add one.", kind: "issue" },
  { text: "Hard-coded user-facing text — use i18n.", kind: "issue" },
  { text: "Consider extracting this into a shared helper; it's duplicated elsewhere in the PR.", kind: "suggestion" },
  { text: "Naming is unclear here — what does this represent?", kind: "nitpick" },
  { text: "Please add a comment explaining why, not what.", kind: "nitpick" },
  { text: "Possible performance concern on large inputs — have you measured?", kind: "question" },
  { text: "Is this intentional?", kind: "question" },
  { text: "Nice — clean and easy to follow.", kind: "praise" },
];

export class Store {
  constructor({ dataDir, ref }) {
    this.ref = ref;
    this.dir = dataDir;
    this.statePath = path.join(dataDir, "state.json");
    this.filesPath = path.join(dataDir, "files.json");
    this.blobDir = path.join(dataDir, "blobs");
    this.state = null; // { ref, pr, review, events, history, mergeBase, commits, lastSyncAt, dropped }
    this.files = {}; // path -> file (with patch)
    this.saving = Promise.resolve();
  }

  // ---------- persistence ----------

  async load({ lock = true, port = null } = {}) {
    await fs.mkdir(this.blobDir, { recursive: true });
    this.state = (await readJson(this.statePath)) || {
      ref: this.ref,
      pr: null,
      review: {},
      events: [],
      history: [],
      mergeBase: null,
      commits: [],
      lastSyncAt: null,
      dropped: {},
    };
    this.diskStamp = await stampOf(this.statePath);
    const filesDoc = await readJson(this.filesPath);
    this.files = filesDoc?.files || {};
    await this.backup({ reason: "startup" }).catch(() => {});
    this.recovery = await this.detectLoss().catch(() => null);
    await this.loadTemplates();
    if (lock) await this.acquireLock(port).catch(() => {});
    return this;
  }

  get hasData() {
    return Boolean(this.state?.pr && Object.keys(this.files).length);
  }

  /**
   * Save = reconcile with whatever is on disk, write, back up. Another Sift process (or a stray edit)
   * writing the same state.json can therefore never erase this one's records: external changes are
   * merged in by union before every write, and a rolling backup set sits next to the file.
   */
  async save({ files = false } = {}) {
    // Serialize writes so concurrent API calls can't interleave partial files.
    this.saving = this.saving.then(async () => {
      await this.reconcileDisk();
      await this.preserveShrink().catch(() => {});
      await writeJsonAtomic(this.statePath, this.state);
      this.diskStamp = await stampOf(this.statePath);
      if (files) await writeJsonAtomic(this.filesPath, { headSha: this.state.pr?.headSha, files: this.files });
      await this.backup().catch(() => {});
    });
    return this.saving;
  }

  /** If state.json changed since we last read/wrote it, merge the on-disk version into memory (union). */
  async reconcileDisk() {
    const stamp = await stampOf(this.statePath);
    if (sameStamp(stamp, this.diskStamp)) return false;
    const theirs = await readJson(this.statePath).catch(() => null);
    if (!theirs || typeof theirs !== "object") return false;
    const before = Object.keys(this.state.review).length;
    mergeState(this.state, theirs);
    this.merged = { at: new Date().toISOString(), added: Object.keys(this.state.review).length - before };
    return true;
  }

  // ---------- backups ----------

  get backupDir() {
    return path.join(this.dir, "backups");
  }

  /**
   * Rolling backups of state.json: at most one per 2 minutes, except immediately when the number of
   * records or notes went *down* (that's what you want to be able to undo). Keeps every backup from
   * the last 24 h (≤ 80) plus one per day for 60 days.
   */
  /** About to write fewer records/notes than the file holds? Keep the file as it is first. */
  async preserveShrink() {
    const disk = await readJson(this.statePath).catch(() => null);
    if (!disk) return null;
    const was = countRecords(disk);
    const now = countRecords(this.state);
    if (now.records >= was.records && now.notes >= was.notes) return null;
    await fs.mkdir(this.backupDir, { recursive: true });
    const name = `state-${localStamp(new Date())}-before-shrink.json`;
    await fs.copyFile(this.statePath, path.join(this.backupDir, name));
    return name;
  }

  async backup({ reason = "save", force = false } = {}) {
    const counts = countRecords(this.state);
    if (!counts.records && !counts.notes && !counts.events) return null; // nothing worth keeping
    const last = await this.latestBackupMeta(); // from disk, so two instances don't both write one
    const unchanged = last && counts.records === last.records && counts.notes === last.notes && counts.events === last.events;
    const recent = last && Date.now() - new Date(last.at).getTime() < 60 * 1000;
    if (!force && reason !== "startup" && (unchanged || recent)) return null;
    if (!force && reason === "startup" && last && Date.now() - new Date(last.at).getTime() < 60 * 60 * 1000) return null;
    await fs.mkdir(this.backupDir, { recursive: true });
    const at = new Date();
    const name = `state-${localStamp(at)}${reason === "reset" ? "-before-reset" : ""}.json`;
    await writeJsonAtomic(path.join(this.backupDir, name), this.state);
    this.lastBackup = { name, at: at.toISOString(), ...counts };
    await this.pruneBackups().catch(() => {});
    return this.lastBackup;
  }

  async latestBackupMeta() {
    const list = await this.listBackups({ limit: 1 });
    return list[0] || null;
  }

  async listBackups({ limit = 200 } = {}) {
    let names = [];
    try {
      names = (await fs.readdir(this.backupDir)).filter((n) => /^state-.*\.json$/.test(n)).sort().reverse();
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.slice(0, limit)) {
      const file = path.join(this.backupDir, name);
      try {
        const st = await fs.stat(file);
        const data = JSON.parse(await fs.readFile(file, "utf8"));
        out.push({ name, at: st.mtime.toISOString(), size: st.size, ...countRecords(data), headSha: data.pr?.headSha || null });
      } catch {}
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)); // newest first, by time taken rather than name
  }

  async pruneBackups() {
    const list = await this.listBackups({ limit: 1000 });
    const now = Date.now();
    const keep = new Set();
    const byDay = new Map();
    let recentKept = 0;
    for (const b of list) {
      const age = now - new Date(b.at).getTime();
      if (age < 24 * 60 * 60 * 1000 && recentKept < 80) {
        keep.add(b.name);
        recentKept++;
        continue;
      }
      const day = b.at.slice(0, 10);
      if (!byDay.has(day) && age < 60 * 24 * 60 * 60 * 1000) {
        byDay.set(day, b.name);
        keep.add(b.name);
      }
    }
    for (const b of list) if (!keep.has(b.name)) await fs.unlink(path.join(this.backupDir, b.name)).catch(() => {});
  }

  /** Merge a backup into the live state (union — never removes anything), then save. */
  async restoreBackup(name) {
    const file = path.join(this.backupDir, path.basename(name));
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    const before = { records: Object.keys(this.state.review).length, notes: countRecords(this.state).notes };
    this.state.resetAt = null; // an explicit restore outranks an earlier "start fresh"
    delete data.resetAt;
    const updated = mergeState(this.state, data);
    const after = { records: Object.keys(this.state.review).length, notes: countRecords(this.state).notes };
    this.recovery = null;
    await this.save();
    return { added: after.records - before.records, updated, notesAdded: after.notes - before.notes };
  }

  /** "State looks wiped": few records now, many in a backup — surfaced as a banner with one-click restore. */
  async detectLoss() {
    const now = countRecords(this.state);
    const resetAt = this.state.resetAt || "";
    const list = (await this.listBackups({ limit: 60 })).filter((b) => b.at > resetAt); // a fresh start is not a loss
    const best = list.filter((b) => b.records > now.records + 2 || b.notes > now.notes).sort((a, b) => b.records - a.records || b.notes - a.notes)[0];
    if (!best) return null;
    return { backup: best.name, at: best.at, records: best.records, notes: best.notes, now };
  }

  /**
   * Start a fresh review: back up, then clear statuses, coverage, dismissals and the event log
   * (and notes unless keepNotes). The reset time is recorded so merges from other instances and
   * loss detection don't resurrect the old records.
   */
  async reset({ keepNotes = false } = {}) {
    const backup = await this.backup({ reason: "reset", force: true });
    const before = countRecords(this.state);
    const now = new Date().toISOString();
    const review = {};
    if (keepNotes) {
      for (const [p, r] of Object.entries(this.state.review)) {
        if ((r.notes || []).length) review[p] = { status: "unreviewed", notes: r.notes, history: [], timeMs: 0 };
      }
    }
    this.state.review = review;
    this.state.events = [];
    this.state.dismissed = {};
    this.state.resetAt = now;
    this.state.resets = [...(this.state.resets || []), { at: now, keepNotes, before, backup: backup?.name || null }].slice(-20);
    this.recovery = null;
    this.lastBackup = null;
    await this.save();
    return { before, backup: backup?.name || null, keptNotes: keepNotes ? countRecords(this.state).notes : 0 };
  }

  // ---------- note templates (shared across PRs) ----------

  get templatesPath() {
    return path.join(path.dirname(this.dir), "templates.json");
  }

  async loadTemplates() {
    const d = await readJson(this.templatesPath).catch(() => null);
    this._templates = Array.isArray(d?.templates) ? d.templates : null;
  }

  templates() {
    return this._templates || DEFAULT_TEMPLATES;
  }

  async resetTemplates() {
    this._templates = null;
    await fs.unlink(this.templatesPath).catch(() => {});
  }

  async saveTemplates(list) {
    const clean = (Array.isArray(list) ? list : [])
      .map((t) => ({ text: String(t?.text || "").trim().slice(0, 500), kind: NOTE_KINDS.includes(t?.kind) ? t.kind : null }))
      .filter((t) => t.text)
      .slice(0, 30);
    this._templates = clean;
    await writeJsonAtomic(this.templatesPath, { version: 1, templates: clean });
    return clean;
  }

  // ---------- instance locks (two Sift processes on one data dir) ----------

  get lockDir() {
    return path.join(this.dir, ".locks");
  }

  /** One heartbeat file per process; others are detected by scanning for live pids with fresh heartbeats. */
  async acquireLock(port) {
    await fs.mkdir(this.lockDir, { recursive: true });
    this.lockInfo = { pid: process.pid, port, startedAt: new Date().toISOString() };
    this.lockFile = path.join(this.lockDir, `${process.pid}.json`);
    const beat = () => writeJsonAtomic(this.lockFile, { ...this.lockInfo, at: new Date().toISOString() }).catch(() => {});
    await beat();
    this.otherInstanceInfo = await this.otherInstance();
    this.lockTimer = setInterval(async () => {
      await beat();
      this.otherInstanceInfo = await this.otherInstance().catch(() => null);
    }, 30_000);
    this.lockTimer.unref?.();
    const release = () => {
      clearInterval(this.lockTimer);
      try {
        // last chance: a synchronous backup of anything written since the previous one
        const counts = countRecords(this.state);
        const lb = this.lastBackup;
        if ((counts.records || counts.notes) && (!lb || counts.records !== lb.records || counts.notes !== lb.notes || counts.events !== lb.events)) {
          fsSync.mkdirSync(this.backupDir, { recursive: true });
          fsSync.writeFileSync(path.join(this.backupDir, `state-${localStamp(new Date())}-exit.json`), JSON.stringify(this.state));
        }
      } catch {}
      try {
        fsSync.unlinkSync(this.lockFile);
      } catch {}
    };
    if (!Store._exitHooked) {
      Store._exitHooked = true;
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => { for (const r of Store._releases) r(); process.exit(0); });
      process.once("exit", () => { for (const r of Store._releases) r(); });
    }
    (Store._releases ||= []).push(release);
  }

  /** Another live Sift holding this PR's data dir (pid alive, heartbeat < 2 min old), or null. Stale files are swept. */
  async otherInstance() {
    let names = [];
    try {
      names = await fs.readdir(this.lockDir);
    } catch {
      return null;
    }
    let found = null;
    for (const n of names) {
      const file = path.join(this.lockDir, n);
      const cur = await readJson(file).catch(() => null);
      if (!cur || cur.pid === process.pid) continue;
      let alive = false;
      try {
        process.kill(cur.pid, 0);
        alive = true;
      } catch {}
      const fresh = Date.now() - new Date(cur.at || cur.startedAt).getTime() < 120_000;
      if (alive && fresh) found ||= cur;
      else await fs.unlink(file).catch(() => {});
    }
    return found;
  }

  // ---------- sync ----------

  async sync({ onProgress = () => {} } = {}) {
    const prev = { pr: this.state.pr, files: this.files };
    onProgress("Fetching pull request…");
    const pr = await gh.fetchPullRequest(this.ref);
    onProgress(`Fetching ${pr.changedFiles} changed files…`);
    const list = await gh.fetchFiles(this.ref);
    onProgress("Fetching commits…");
    const commits = await gh.fetchCommits(this.ref).catch(() => this.state.commits || []);

    const nextFiles = {};
    for (const f of list) {
      const old = prev.files[f.path];
      // Keep a previously computed patch if the blob is unchanged (saves re-diffing oversized files).
      const patch = f.patch ?? (old && old.sha === f.sha && old.status === f.status ? old.patch : null);
      nextFiles[f.path] = {
        ...f,
        patch,
        patchSource: f.patch ? "github" : old?.patchSource === "computed" && patch ? "computed" : null,
      };
    }

    const summary = {
      at: new Date().toISOString(),
      prevHeadSha: prev.pr?.headSha || null,
      headSha: pr.headSha,
      added: [],
      changed: [],
      removed: [],
      staleNow: [],
      newCommits: [],
      first: !prev.pr,
    };

    for (const [p, f] of Object.entries(nextFiles)) {
      const old = prev.files[p];
      if (!old) {
        if (prev.pr) summary.added.push(p);
      } else if (old.sha !== f.sha || old.status !== f.status) {
        summary.changed.push(p);
      }
    }
    for (const p of Object.keys(prev.files)) {
      if (!nextFiles[p]) {
        summary.removed.push(p);
        this.state.dropped[p] = { ...prev.files[p], patch: undefined, droppedAt: summary.at };
      } else {
        delete this.state.dropped[p];
      }
    }
    if (prev.pr) {
      const known = new Set((this.state.commits || []).map((c) => c.sha));
      summary.newCommits = commits.filter((c) => !known.has(c.sha)).map((c) => ({ sha: c.sha, message: c.message.split("\n")[0] }));
    }

    this.files = nextFiles;
    this.state.pr = pr;
    this.state.commits = commits;
    this.state.lastSyncAt = summary.at;
    if (this.state.mergeBase?.headSha !== pr.headSha) this.state.mergeBase = null;

    for (const p of [...summary.changed, ...summary.removed]) {
      const r = this.state.review[p];
      if (r && DONE_STATUSES.has(r.status) && this.isStale(p)) summary.staleNow.push(p);
    }

    this.state.history.push({
      at: summary.at,
      headSha: pr.headSha,
      added: summary.added.length,
      changed: summary.changed.length,
      removed: summary.removed.length,
      staleNow: summary.staleNow.length,
      newCommits: summary.newCommits.length,
    });
    if (this.state.history.length > 200) this.state.history = this.state.history.slice(-200);

    await this.save({ files: true });
    return summary;
  }

  // ---------- derived views ----------

  isStale(p) {
    const r = this.state.review[p];
    if (!r || !DONE_STATUSES.has(r.status)) return false;
    const f = this.files[p];
    if (!f) return true; // reviewed, but no longer part of the PR
    return r.sha !== f.sha || r.fileStatus !== f.status;
  }

  fileSummary(p) {
    const f = this.files[p];
    const r = this.state.review[p] || null;
    return {
      path: f.path,
      previousPath: f.previousPath,
      status: f.status,
      sha: f.sha,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      ...classify(f),
      hasPatch: Boolean(f.patch) || f.patchSource === "computed",
      review: r
        ? {
            status: r.status,
            at: r.at,
            sha: r.sha,
            headSha: r.headSha,
            fileStatus: r.fileStatus,
            timeMs: r.timeMs || 0,
            noteCount: (r.notes || []).length,
            notes: r.notes || [],
            seen: r.seen && r.seen.sha === f.sha ? r.seen : null,
          }
        : null,
      stale: this.isStale(p),
    };
  }

  snapshot() {
    const files = Object.keys(this.files).map((p) => this.fileSummary(p));
    const dropped = Object.entries(this.state.dropped).map(([p, f]) => ({
      path: p,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...classify({ ...f, path: p }),
      droppedAt: f.droppedAt,
      review: this.state.review[p] || null,
    }));
    return {
      ref: this.ref,
      pr: this.state.pr,
      lastSyncAt: this.state.lastSyncAt,
      files,
      dropped,
      commits: this.state.commits || [],
      history: this.state.history,
      events: this.state.events.slice(-400),
      dismissed: this.state.dismissed || {},
      sittings: this.sittings(),
      templates: this.templates(),
      recovery: this.recovery || null,
      otherInstance: this.otherInstanceInfo || null,
      lastBackup: this.lastBackup || null,
      stats: this.stats(files),
    };
  }

  /**
   * Review "sittings": runs of status events with no gap longer than 30 minutes. Powers the resume
   * card ("last time: 14 files in 38 min, stopped at X") and the sitting planner.
   */
  sittings({ gapMs = 30 * 60 * 1000, max = 12 } = {}) {
    const ev = this.state.events;
    if (!ev.length) return [];
    const out = [];
    let cur = null;
    for (const e of ev) {
      const t = new Date(e.at).getTime();
      if (!cur || t - cur.endMs > gapMs) {
        cur = { start: e.at, end: e.at, startMs: t, endMs: t, files: new Set(), lines: 0, last: e.path };
        out.push(cur);
      }
      cur.end = e.at;
      cur.endMs = t;
      cur.last = e.path;
      if (DONE_STATUSES.has(e.to)) {
        cur.files.add(e.path);
        cur.lines += e.changes || 0;
      }
    }
    return out.slice(-max).map((s) => ({ start: s.start, end: s.end, durationMs: s.endMs - s.startMs, files: s.files.size, lines: s.lines, last: s.last }));
  }

  stats(files = Object.keys(this.files).map((p) => this.fileSummary(p))) {
    const byStatus = { unreviewed: 0, reviewed: 0, skimmed: 0, flagged: 0, deferred: 0 };
    let stale = 0;
    let linesDone = 0;
    let linesTotal = 0;
    let notes = 0;
    for (const f of files) {
      const s = f.review?.status || "unreviewed";
      byStatus[s] = (byStatus[s] || 0) + 1;
      linesTotal += f.changes || 0;
      if (DONE_STATUSES.has(s) && !f.stale) linesDone += f.changes || 0;
      if (f.stale) stale++;
      notes += f.review?.noteCount || 0;
    }
    const done = byStatus.reviewed + byStatus.skimmed + byStatus.flagged - stale;
    return { total: files.length, byStatus, stale, done, pending: files.length - done, linesDone, linesTotal, notes, pace: this.pace() };
  }

  /** Lines-per-active-minute over recent events, used for an honest ETA. */
  pace() {
    const ev = this.state.events.filter((e) => DONE_STATUSES.has(e.to) && e.changes > 0);
    if (ev.length < 8) return null;
    const GAP = 10 * 60 * 1000;
    let active = 0;
    let lines = 0;
    for (let i = 1; i < ev.length; i++) {
      const dt = new Date(ev[i].at) - new Date(ev[i - 1].at);
      if (dt > 0 && dt < GAP) {
        active += dt;
        lines += ev[i].changes || 0;
      }
    }
    if (active < 5 * 60 * 1000) return null;
    return { linesPerMinute: lines / (active / 60000), filesPerHour: (ev.length / (active / 3600000)), activeMs: active, sample: ev.length };
  }

  // ---------- mutations ----------

  setStatus(p, status) {
    if (!STATUSES.includes(status)) throw new Error(`Unknown status ${status}`);
    const f = this.files[p];
    if (!f && !this.state.dropped[p]) throw new Error(`Unknown file ${p}`);
    const now = new Date().toISOString();
    const prev = this.state.review[p] || { notes: [], history: [], timeMs: 0 };
    this.state.events.push({ at: now, path: p, from: prev.status || "unreviewed", to: status, changes: f?.changes || 0 });
    if (this.state.events.length > MAX_EVENTS) this.state.events = this.state.events.slice(-MAX_EVENTS);
    const rec = {
      ...prev,
      status,
      at: now,
      sha: f?.sha || prev.sha || null,
      headSha: this.state.pr?.headSha || null,
      fileStatus: f?.status || prev.fileStatus || null,
      history: [...(prev.history || []), { status, at: now, sha: f?.sha || null }].slice(-50),
    };
    if (status === "unreviewed" && !(rec.notes || []).length) delete this.state.review[p];
    else this.state.review[p] = rec;
    return this.fileSummary(p);
  }

  /** Restore full review records (undo); `review` null removes the record. */
  restoreReview(items) {
    const out = [];
    for (const { path: p, review } of items) {
      if (!this.files[p] && !this.state.dropped[p]) continue;
      if (!review) {
        // "no record before": drop the status but never lose notes or time that accrued meanwhile
        const cur = this.state.review[p];
        if (cur && ((cur.notes || []).length || cur.timeMs || cur.seen)) {
          this.state.review[p] = { ...cur, status: "unreviewed", at: undefined, sha: undefined, headSha: undefined, fileStatus: undefined };
        } else delete this.state.review[p];
      } else {
        const prev = this.state.review[p] || {};
        this.state.review[p] = { ...prev, status: review.status, at: review.at, sha: review.sha, headSha: review.headSha, fileStatus: review.fileStatus, notes: review.notes || prev.notes || [], history: prev.history || [], timeMs: prev.timeMs || 0 };
        if (this.state.review[p].status === "unreviewed" && !this.state.review[p].notes.length) delete this.state.review[p];
      }
      if (this.files[p]) out.push(this.fileSummary(p));
    }
    return out;
  }

  addTime(p, ms) {
    if (!this.files[p] || !(ms > 0)) return;
    const rec = (this.state.review[p] ||= { status: "unreviewed", notes: [], history: [], timeMs: 0 });
    rec.timeMs = (rec.timeMs || 0) + Math.min(ms, 60 * 60 * 1000);
  }

  /** Hunk coverage: which hunks of the file (at blob `sha`) have actually been scrolled into view. */
  markSeen(p, { sha, hunks, total }) {
    const f = this.files[p];
    if (!f || f.sha !== sha) return null;
    const rec = (this.state.review[p] ||= { status: "unreviewed", notes: [], history: [], timeMs: 0 });
    const prev = rec.seen && rec.seen.sha === sha ? new Set(rec.seen.hunks) : new Set();
    for (const h of hunks || []) if (Number.isInteger(h) && h >= 0) prev.add(h);
    rec.seen = { sha, hunks: [...prev].sort((a, b) => a - b), total: Math.max(Number(total) || 0, prev.size) };
    return rec.seen;
  }

  /** Reviewer dispositions on findings/threads: "I looked, it's fine" — keyed by a stable id. */
  dismiss(key, reason) {
    if (!key) throw new Error("Missing key");
    this.state.dismissed ||= {};
    this.state.dismissed[key] = { at: new Date().toISOString(), reason: String(reason || "").trim().slice(0, 300) };
    return this.state.dismissed[key];
  }

  undismiss(key) {
    if (this.state.dismissed) delete this.state.dismissed[key];
  }

  addNote(p, { text, line = null, side = null, endLine = null, kind = null }) {
    const f = this.files[p];
    if (!f) throw new Error(`Unknown file ${p}`);
    const rec = (this.state.review[p] ||= { status: "unreviewed", notes: [], history: [], timeMs: 0 });
    const note = {
      id: crypto.randomBytes(5).toString("hex"),
      text: String(text || "").trim(),
      line: line == null ? null : Number(line),
      endLine: endLine == null ? null : Number(endLine),
      side: side === "LEFT" ? "LEFT" : line == null ? null : "RIGHT",
      kind: NOTE_KINDS.includes(kind) ? kind : null,
      at: new Date().toISOString(),
      sha: f.sha,
      publishedAt: null,
    };
    if (!note.text) throw new Error("Note text is empty");
    rec.notes.push(note);
    return note;
  }

  editNote(p, id, text, kind) {
    const rec = this.state.review[p];
    const n = rec?.notes?.find((x) => x.id === id);
    if (!n) throw new Error("Note not found");
    if (text != null) n.text = String(text || "").trim();
    if (kind !== undefined) n.kind = NOTE_KINDS.includes(kind) ? kind : null;
    n.editedAt = new Date().toISOString();
    return n;
  }

  deleteNote(p, id) {
    const rec = this.state.review[p];
    if (!rec) return;
    rec.notes = (rec.notes || []).filter((x) => x.id !== id);
    if (rec.status === "unreviewed" && !rec.notes.length) delete this.state.review[p];
  }

  // ---------- content & diffs ----------

  async blob(sha) {
    if (!sha) return "";
    const file = path.join(this.blobDir, sha);
    try {
      return await fs.readFile(file, "utf8");
    } catch {}
    const content = await gh.fetchBlob(this.ref, sha);
    await fs.writeFile(file, content);
    return content;
  }

  async mergeBase() {
    const pr = this.state.pr;
    if (!this.state.mergeBase || this.state.mergeBase.headSha !== pr.headSha) {
      const sha = await gh.fetchMergeBase(this.ref, pr.baseRef, pr.headSha);
      this.state.mergeBase = { headSha: pr.headSha, sha: sha || pr.baseSha };
      await this.save();
    }
    return this.state.mergeBase.sha;
  }

  async baseContent(f) {
    if (f.status === "added") return "";
    // For removed files GitHub reports the pre-deletion blob as `sha`.
    if (f.status === "removed") return this.blob(f.sha);
    const key = `base-${f.sha}-${hashString((f.previousPath || f.path) + ":" + (this.state.pr?.headSha || ""))}`;
    const cached = path.join(this.blobDir, key);
    try {
      return await fs.readFile(cached, "utf8");
    } catch {}
    const base = await this.mergeBase();
    const content = (await gh.fetchContentAtRef(this.ref, f.previousPath || f.path, base)) ?? "";
    await fs.writeFile(cached, content);
    return content;
  }

  async headContent(f) {
    if (f.status === "removed") return "";
    return this.blob(f.sha);
  }

  async content(p, side) {
    const f = this.files[p];
    if (!f) throw new Error(`Unknown file ${p}`);
    return side === "base" ? this.baseContent(f) : this.headContent(f);
  }

  /** Unified patch body (hunks only). Computes one locally when GitHub omitted it. */
  async patchFor(p) {
    const f = this.files[p];
    if (!f) throw new Error(`Unknown file ${p}`);
    if (f.patch) return f.patch;
    const [before, after] = await Promise.all([this.baseContent(f), this.headContent(f)]);
    f.patch = unifiedHunks(before, after, 3);
    f.patchSource = "computed";
    await this.save({ files: true });
    return f.patch;
  }

  /** What changed in this file between the version you reviewed and the current one. */
  async interdiff(p) {
    const f = this.files[p];
    const r = this.state.review[p];
    if (!r || !r.sha) return { kind: "none" };
    if (!f) return { kind: "dropped" };
    if (r.sha === f.sha && r.fileStatus === f.status) return { kind: "same" };
    if (f.status === "removed") return { kind: "removed-now", from: r.fileStatus };
    if (r.fileStatus === "removed") return { kind: "restored", to: f.status };
    const [before, after] = await Promise.all([this.blob(r.sha), this.blob(f.sha)]);
    const patch = unifiedHunks(before, after, 3);
    return { kind: "diff", patch, fromSha: r.sha, toSha: f.sha, reviewedAt: r.at, reviewedHeadSha: r.headSha };
  }

  async fileDetail(p) {
    const f = this.files[p];
    if (!f) throw new Error(`Unknown file ${p}`);
    const patch = await this.patchFor(p);
    const summary = this.fileSummary(p);
    return { ...summary, patch, patchSource: f.patchSource || "github" };
  }
}

// ---------- helpers ----------

// Derived at read time so classifier tweaks apply without a re-sync.
const classifyCache = new Map();
function classify(f) {
  const key = `${f.path}|${f.status}|${f.additions}|${f.deletions}`;
  let c = classifyCache.get(key);
  if (!c) {
    c = { area: areaOf(f.path), tier: tierOf(f.path), rank: rankOf(f.path), risks: riskOf(f), language: languageOf(f.path) };
    classifyCache.set(key, c);
  }
  return c;
}

export function unifiedHunks(before, after, context = 3) {
  const sp = Diff.structuredPatch("a", "b", before, after, "", "", { context });
  const out = [];
  for (const h of sp.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) out.push(l);
  }
  return out.join("\n");
}

function hashString(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

/** Local-time file stamp, sortable: 2026-10-25_14-51-12 */
function localStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
async function stampOf(file) {
  try {
    const st = await fs.stat(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}
function sameStamp(a, b) {
  if (!a && !b) return true;
  return Boolean(a && b && a.mtimeMs === b.mtimeMs && a.size === b.size);
}

export function countRecords(state) {
  let notes = 0;
  for (const r of Object.values(state?.review || {})) notes += (r.notes || []).length;
  return { records: Object.keys(state?.review || {}).length, notes, events: (state?.events || []).length };
}

/**
 * Union-merge `theirs` into `mine` (mutates mine). Nothing is ever dropped: records are kept from both
 * sides (the newer status wins, notes are unioned by id), events/history/dismissals/reviews are unioned.
 * PR/commit/sync metadata stays `mine` — it belongs to this process's files.json.
 * Returns how many existing records were touched.
 */
export function mergeState(mine, theirs) {
  let updated = 0;
  mine.review ||= {};
  // The newer "start fresh" wins: anything from before it is history on both sides.
  const resetAt = [mine.resetAt, theirs.resetAt].filter(Boolean).sort().pop() || null;
  if (resetAt) {
    const stamp = (r) => r.at || (r.notes || []).map((n) => n.editedAt || n.at || "").sort().pop() || "";
    for (const side of [mine, theirs]) {
      for (const [p, r] of Object.entries(side.review || {})) if (stamp(r) && stamp(r) < resetAt) delete side.review[p];
      side.events = (side.events || []).filter((e) => e.at >= resetAt);
      for (const [k, d] of Object.entries(side.dismissed || {})) if ((d.at || "") < resetAt) delete side.dismissed[k];
    }
    mine.resetAt = resetAt;
    const resets = new Map([...(mine.resets || []), ...(theirs.resets || [])].map((r) => [r.at, r]));
    mine.resets = [...resets.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-20);
  }
  for (const [p, t] of Object.entries(theirs.review || {})) {
    const m = mine.review[p];
    if (!m) {
      mine.review[p] = t;
      continue;
    }
    const newer = (t.at || "") > (m.at || "") ? t : m;
    const older = newer === t ? m : t;
    const notes = new Map((older.notes || []).map((n) => [n.id, n]));
    for (const n of newer.notes || []) {
      const prev = notes.get(n.id);
      notes.set(n.id, !prev || (n.editedAt || n.at || "") >= (prev.editedAt || prev.at || "") ? { ...prev, ...n } : { ...n, ...prev });
    }
    const hist = new Map([...(m.history || []), ...(t.history || [])].map((h) => [h.at, h]));
    const seen = m.seen && t.seen && m.seen.sha === t.seen.sha ? { sha: m.seen.sha, hunks: [...new Set([...(m.seen.hunks || []), ...(t.seen.hunks || [])])].sort((a, b) => a - b), total: Math.max(m.seen.total || 0, t.seen.total || 0) } : newer.seen || older.seen || undefined;
    const mergedRec = {
      ...older,
      ...newer,
      notes: [...notes.values()].sort((a, b) => (a.at || "").localeCompare(b.at || "")),
      history: [...hist.values()].sort((a, b) => (a.at || "").localeCompare(b.at || "")).slice(-50),
      timeMs: Math.max(m.timeMs || 0, t.timeMs || 0),
    };
    if (seen) mergedRec.seen = seen;
    if (JSON.stringify(mergedRec) !== JSON.stringify(m)) updated++;
    mine.review[p] = mergedRec;
  }
  const evKey = (e) => `${e.at}|${e.path}|${e.to}`;
  const evs = new Map((mine.events || []).map((e) => [evKey(e), e]));
  for (const e of theirs.events || []) if (!evs.has(evKey(e))) evs.set(evKey(e), e);
  mine.events = [...evs.values()].sort((a, b) => (a.at || "").localeCompare(b.at || "")).slice(-MAX_EVENTS);
  const hist = new Map((mine.history || []).map((h) => [h.at, h]));
  for (const h of theirs.history || []) if (!hist.has(h.at)) hist.set(h.at, h);
  mine.history = [...hist.values()].sort((a, b) => (a.at || "").localeCompare(b.at || "")).slice(-200);
  mine.dismissed = { ...(theirs.dismissed || {}), ...(mine.dismissed || {}) };
  const revs = new Map((mine.reviews || []).map((r) => [r.id, r]));
  for (const r of theirs.reviews || []) if (!revs.has(r.id)) revs.set(r.id, r);
  if (revs.size) mine.reviews = [...revs.values()].sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  mine.dropped = { ...(theirs.dropped || {}), ...(mine.dropped || {}) };
  if (theirs.templates && !mine.templates) mine.templates = theirs.templates;
  return updated;
}

/** Per-PR state directory under the data root (default `<tool>/.review-data`, or --data-dir / SIFT_DATA_DIR). */
export function dataDirFor(dataRoot, ref) {
  return path.join(dataRoot, `${ref.owner}__${ref.repo}__${ref.number}`);
}
export function defaultDataRoot(toolRoot) {
  return process.env.SIFT_DATA_DIR ? path.resolve(process.env.SIFT_DATA_DIR) : path.join(toolRoot, ".review-data");
}
