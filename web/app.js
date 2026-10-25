import { parsePatch, renderDiff, escapeHtml, highlightToLines } from "./diff.js";

// ============================================================================
// constants
// ============================================================================

const TIERS = ["Config & infra", "Types & schemas", "Utils, hooks & state", "Components", "Pages", "Routing & wiring", "Docs & locale", "Tests"];
const STATUS_LABEL = { unreviewed: "Unreviewed", reviewed: "Reviewed", skimmed: "Skimmed", flagged: "Flagged", deferred: "Deferred" };
const DONE = new Set(["reviewed", "skimmed", "flagged"]);
const ORDERS = [
  ["foundations", "Foundations first"],
  ["path", "Path"],
  ["largest", "Largest first"],
  ["smallest", "Smallest first"],
  ["risk", "Risk first"],
  ["stale", "Stale first"],
  ["recent", "Recently touched"],
  ["story", "By story (sub-PR)"],
  ["novel", "Most new code first"],
];
const STATUS_FILTERS = [
  ["all", "All"],
  ["pending", "Pending"],
  ["unreviewed", "Unreviewed"],
  ["reviewed", "Reviewed"],
  ["skimmed", "Skimmed"],
  ["flagged", "Flagged"],
  ["deferred", "Deferred"],
  ["stale", "Stale"],
  ["noted", "Has notes"],
  ["cifail", "CI failing"],
  ["threads", "Has threads"],
  ["findings", "Has findings"],
];

// ============================================================================
// which PR? (path-scoped: /pr/owner/repo/123/ — hash routes stay per-PR)
// ============================================================================

const PR = (() => {
  const m = location.pathname.match(/^\/pr\/([^/]+)\/([^/]+)\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
})();
const PR_PARAM = PR ? `${PR.owner}/${PR.repo}/${PR.number}` : null;
function withPr(url) {
  if (!PR_PARAM) return url;
  return url + (url.includes("?") ? "&" : "?") + "pr=" + encodeURIComponent(PR_PARAM);
}

// ============================================================================
// state
// ============================================================================

const prefs = loadPrefs();
const S = {
  snap: null,
  byPath: new Map(),
  lens: "deck",
  current: null,
  detail: null,
  detailCache: new Map(), // path -> { sha, detail }
  contentCache: new Map(), // path -> text
  interCache: new Map(), // path:sha -> interdiff
  hunkIdx: -1,
  openedAt: null,
  lastAction: null, // { path, from } for undo
  selection: new Set(),
  ledgerHl: null,
  queueCache: null,
  pendingRange: null, // { side, start, end } for inline composer
  syncing: false,
  lastSync: null,
  relatedCache: new Map(), // path@headSha -> related data
  relatedPoll: null,
  relatedOpen: prefs.relatedOpen ?? true,
  jumpStack: [], // [{ path, scrollTop }] for B (back) after following a related link
  pendingScroll: null, // { line, side } | { scrollTop } applied after the next body render
  peek: null, // { path, line, side }
  stories: null, // /api/stories (sub-PR narratives)
  gitx: new Map(), // path -> churn/impact from the local clone
  lint: null, // /api/lint (reviewer findings)
  lintByPath: new Map(),
  moves: null, // /api/moves summary (verbatim moved code)
  moveLines: new Map(), // path -> { newNo: { from, line } }
  foldMoved: prefs.foldMoved ?? true,
  threads: null, // /api/threads (existing review conversations)
  threadsByPath: new Map(),
  showBotThreads: prefs.showBotThreads ?? true,
  ci: null, // /api/ci summary (Playwright results)
  ciPoll: null,
  ciFileCache: new Map(), // path@runId -> tests
  outlineCache: new Map(), // path:sha -> outline
  outlineMode: prefs.outlineMode ?? true, // show spec files as scenario outlines by default
  surfaceMode: prefs.surfaceMode ?? false, // show source files as their API surface instead of the diff
  surfaceCache: new Map(),
  keysCache: new Map(),
  media: new Set(), // attachment urls currently expanded inline
  view: prefs.view || { mode: "unified", wrap: false, full: false, inter: false, words: true },
  filter: prefs.filter && prefs.filter.status ? { story: null, ...prefs.filter } : { status: "all", tier: null, area: null, q: "", story: null },
  order: prefs.order || "foundations",
  autoAdvance: prefs.autoAdvance ?? true,
  rail: prefs.rail ?? true,
  side: prefs.side ?? true,
  theme: prefs.theme || "dark",
  railW: prefs.railW || null, // resizable panel widths (px); null = CSS default
  sideW: prefs.sideW || null,
  dismissed: {}, // finding/thread dispositions from the server: key -> { at, reason }
  risk: null, // /api/risk — structural risk per file (importers × exports × tests × sensitivity)
  ciHist: null, // /api/ci/history — outcomes per test across the last runs
  templates: [], // note templates (0–9 in any composer), shared across PRs
  tour: { list: null, idx: -1, key: "" }, // attention tour (⇧J / ⇧K) across findings, threads, failing tests, stale files
  seenLocal: new Map(), // path:sha -> Set(hunk index) seen in this tab (merged with the server copy on save)
  seenObserver: null,
  briefOpen: prefs.briefV2 ? (prefs.briefOpen ?? false) : false, // Map cards start collapsed; the toggle is remembered (briefV2 resets the old open-by-default)
  storiesOpen: prefs.storiesOpen ?? false,
};

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("sift:prefs") || "{}");
    p.current = PR_PARAM ? p.currents?.[PR_PARAM] || null : null;
    p.filter = PR_PARAM ? p.filters?.[PR_PARAM] || null : null;
    return p;
  } catch {
    return {};
  }
}
function savePrefs() {
  const { view, order, autoAdvance, rail, side, theme, relatedOpen, outlineMode, surfaceMode, showBotThreads, foldMoved, railW, sideW, briefOpen, storiesOpen } = S;
  let prev = {};
  try {
    prev = JSON.parse(localStorage.getItem("sift:prefs") || "{}");
  } catch {}
  const currents = { ...(prev.currents || {}) };
  const filters = { ...(prev.filters || {}) };
  if (PR_PARAM) {
    currents[PR_PARAM] = S.current;
    filters[PR_PARAM] = S.filter;
  }
  localStorage.setItem("sift:prefs", JSON.stringify({ view, order, autoAdvance, rail, side, theme, relatedOpen, outlineMode, surfaceMode, showBotThreads, foldMoved, railW, sideW, briefOpen, briefV2: true, storiesOpen, tourKinds: S.tourKinds || prev.tourKinds || null, currents, filters }));
}

// ============================================================================
// api
// ============================================================================

async function api(path, opts = {}) {
  const res = await fetch(withPr(path), {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

function applySnapshot(snap) {
  S.snap = snap;
  S.byPath = new Map(snap.files.map((f) => [f.path, f]));
  S.dismissed = snap.dismissed || {};
  S.templates = snap.templates || [];
  S.queueCache = null;
  S.tour.list = null;
  S.relatedCache.clear();
  for (const [p, c] of S.detailCache) {
    const f = S.byPath.get(p);
    if (!f || f.sha !== c.sha) S.detailCache.delete(p);
  }
}

function updateFile(file, stats) {
  const idx = S.snap.files.findIndex((f) => f.path === file.path);
  if (idx >= 0) S.snap.files[idx] = file;
  S.byPath.set(file.path, file);
  if (stats) S.snap.stats = stats;
  if (S.detail && S.detail.path === file.path) Object.assign(S.detail, file);
  S.queueCache = null;
  S.tour.list = null;
}

// ============================================================================
// queue: filter + order
// ============================================================================

function statusOf(f) {
  return f.review?.status || "unreviewed";
}
function isPending(f) {
  return statusOf(f) === "unreviewed" || f.stale;
}
function matchesFilter(f) {
  const { status, tier, area, q, story } = S.filter;
  if (story != null && !inStory(f.path, story)) return false;
  if (tier != null && f.tier !== tier) return false;
  if (area && f.area !== area) return false;
  if (q) {
    const needle = q.toLowerCase();
    if (!f.path.toLowerCase().includes(needle) && !(f.previousPath || "").toLowerCase().includes(needle)) return false;
  }
  const s = statusOf(f);
  switch (status) {
    case "all": return true;
    case "pending": return isPending(f);
    case "stale": return Boolean(f.stale);
    case "noted": return (f.review?.noteCount || 0) > 0;
    case "cifail": { const c = S.ci?.byFile?.[f.path]; return Boolean(c && (c.failed || c.flaky)); }
    case "threads": { const t = S.threads?.byFile?.[f.path]; return Boolean(t && (S.showBotThreads ? t.open : t.human)); }
    case "findings": return hasActiveFindings(f.path);
    default: return s === status;
  }
}
function riskScore(f) {
  const r = S.risk?.byPath?.[f.path];
  if (r) return r.score;
  // heuristic fallback until the cross-reference index is ready (scaled to the same 0–100-ish range)
  return (f.risks || []).reduce((n, x) => n + ({ deleted: 3, sensitive: 3, "heavy-deletion": 2, large: 2, big: 1 }[x] || 0), 0) * 8;
}
function riskPill(path, { compact = false } = {}) {
  const r = S.risk?.byPath?.[path];
  if (!r || r.score < 40) return ""; // roughly the top sixth of this PR's files
  const lvl = r.score >= 60 ? "high" : "mid";
  return `<span class="pill risk r-${lvl}" title="Structural risk ${r.score}: ${escapeHtml(r.reasons.join(" · "))}">${compact ? "" : "risk "}${r.score}</span>`;
}
async function loadRisk(attempt = 0) {
  try {
    const d = await api("/api/risk");
    if (!d.ready) {
      if (d.reason === "building" && attempt < 40) setTimeout(() => loadRisk(attempt + 1), 4000);
      return;
    }
    S.risk = d;
    S.queueCache = null;
    if (S.lens === "map") renderMap($("#lens"));
    else if (S.lens === "deck" && S.current) { if (S.order === "risk") renderRail(); renderPaneHead(); }
    else if (S.lens === "ledger" && S.order === "risk") renderLedger($("#lens"));
  } catch {}
}
function cmp(order) {
  const byPath = (a, b) => a.path.localeCompare(b.path);
  const found = (a, b) => a.tier - b.tier || a.area.localeCompare(b.area) || (a.rank ?? 2) - (b.rank ?? 2) || byPath(a, b);
  switch (order) {
    case "path": return byPath;
    case "largest": return (a, b) => b.changes - a.changes || byPath(a, b);
    case "smallest": return (a, b) => a.changes - b.changes || byPath(a, b);
    case "risk": return (a, b) => riskScore(b) - riskScore(a) || b.changes - a.changes || byPath(a, b);
    case "stale": return (a, b) => Number(Boolean(b.stale)) - Number(Boolean(a.stale)) || Number(isPending(b)) - Number(isPending(a)) || found(a, b);
    case "recent": return (a, b) => (b.review?.at || "").localeCompare(a.review?.at || "") || found(a, b);
    case "story": return (a, b) => storyRank(a.path) - storyRank(b.path) || found(a, b);
    case "novel": return (a, b) => novelLines(b) - novelLines(a) || byPath(a, b);
    default: return found;
  }
}
function queue() {
  if (!S.queueCache) S.queueCache = S.snap.files.filter(matchesFilter).sort(cmp(S.order));
  return S.queueCache;
}
function queueIndex(path) {
  return queue().findIndex((f) => f.path === path);
}
function novelLines(f) {
  const m = S.moves?.summary?.[f.path];
  return (f.additions || 0) - (m?.moved || 0);
}
function storyOf(path) {
  const p = S.stories?.primary?.[path];
  return p == null ? 0 : p;
}
function storyMembers(n) {
  if (!S.stories) return new Set();
  if (!S.stories._members) {
    S.stories._members = new Map();
    for (const st of S.stories.stories) S.stories._members.set(st.number, new Set(st.files));
    S.stories._members.set(0, new Set(S.stories.direct.files));
  }
  return S.stories._members.get(n) || new Set();
}
function inStory(path, n) {
  return storyMembers(n).has(path) || (storyMembers(n).size === 0 && storyOf(path) === n);
}
function storyMeta(n) {
  if (!S.stories) return null;
  if (n === 0) return S.stories.direct;
  return S.stories.stories.find((s) => s.number === n) || null;
}
function storyRank(path) {
  if (!S.stories) return 0;
  const n = storyOf(path);
  if (n === 0) return S.stories.stories.length + 1;
  const i = S.stories.stories.findIndex((s) => s.number === n);
  return i < 0 ? S.stories.stories.length : i;
}
function storyLabel(n, { short = false } = {}) {
  const m = storyMeta(n);
  if (!m) return n ? `#${n}` : "direct commits";
  const t = (m.title || "").replace(/^\[[^\]]*\]\s*/, "");
  return n ? `#${n} ${short && t.length > 48 ? t.slice(0, 46) + "…" : t}` : m.title;
}
function nextPending(fromPath, dir = 1) {
  const q = queue();
  if (!q.length) return null;
  const n = q.length;
  const start = fromPath ? queueIndex(fromPath) : -1;
  for (let k = 1; k <= n; k++) {
    const f = q[(((start + dir * k) % n) + n) % n];
    if (isPending(f) && f.path !== fromPath) return f;
  }
  return null;
}
function neighbor(path, dir) {
  const q = queue();
  if (!q.length) return null;
  const i = queueIndex(path);
  if (i < 0) return q[0];
  return q[(i + dir + q.length) % q.length];
}

// ============================================================================
// router
// ============================================================================

function navigate(lens, path) {
  const hash = lens === "deck" && path ? `#/deck/${encodeURIComponent(path)}` : `#/${lens}`;
  if (location.hash !== hash) history.pushState(null, "", hash);
  route();
}
function route() {
  const m = location.hash.match(/^#\/(map|deck|ledger|notes)(?:\/(.*))?$/);
  const lens = m ? m[1] : null;
  const path = m && m[2] ? decodeURIComponent(m[2]) : null;
  if (!lens) {
    const anyDone = S.snap.files.some((f) => f.review);
    const resume = S.current || prefs.current;
    if (anyDone && resume && S.byPath.has(resume)) return navigate("deck", resume);
    return navigate(anyDone ? "deck" : "map", anyDone ? nextPending(null)?.path : null);
  }
  setLens(lens, path);
}
window.addEventListener("popstate", route);

function setLens(lens, path) {
  if (S.lens === "deck" && (lens !== "deck" || (path && path !== S.current))) flushTime();
  S.lens = lens;
  document.querySelectorAll(".lenses button").forEach((b) => b.classList.toggle("on", b.dataset.lens === lens));
  if (lens === "deck") {
    const target = path && S.byPath.get(path) ? path : S.current && S.byPath.get(S.current) ? S.current : (nextPending(null) || queue()[0])?.path;
    if (target && target !== S.current) {
      S.current = target;
      S.hunkIdx = -1;
      S.openedAt = Date.now();
      S.view.inter = false;
      if (S.sideDraftPath !== target) S.sideDraft = "";
      closePeek();
      savePrefs();
    } else if (target && S.openedAt == null) S.openedAt = Date.now();
    if (location.hash !== `#/deck/${encodeURIComponent(S.current || "")}` && S.current) history.replaceState(null, "", `#/deck/${encodeURIComponent(S.current)}`);
  }
  render();
}

// ============================================================================
// rendering: header + filter bar + action bar
// ============================================================================

const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

function render() {
  renderHeader();
  renderNotices();
  renderFilterBar();
  const main = $("#lens");
  if (S.lens === "map") renderMap(main);
  else if (S.lens === "ledger") renderLedger(main);
  else if (S.lens === "notes") renderNotes(main);
  else renderDeck(main);
  renderActionBar();
}

function renderHeader() {
  const { pr, stats } = S.snap;
  const ref = $(".pr-ref");
  ref.textContent = `${S.snap.ref.owner}/${S.snap.ref.repo}#${S.snap.ref.number} · ${pr.title}`;
  ref.href = pr.url;
  document.title = `Sift · #${S.snap.ref.number} · ${stats.done}/${stats.total}`;
  const t = stats.total || 1;
  const seg = (k, n) => (n ? `<i class="s-${k}" style="width:${(100 * n) / t}%" title="${STATUS_LABEL[k] || k}: ${n}"></i>` : "");
  const by = stats.byStatus;
  const staleOverlap = stats.stale;
  const eta = etaText();
  const sig = S.lint || S.threads || S.ci?.state === "ready" ? tourList().length : 0;
  $("#progress").innerHTML =
    `<div class="pbar">${seg("reviewed", Math.max(0, by.reviewed - staleOf("reviewed")))}${seg("skimmed", Math.max(0, by.skimmed - staleOf("skimmed")))}${seg("flagged", Math.max(0, by.flagged - staleOf("flagged")))}${seg("stale", staleOverlap)}${seg("deferred", by.deferred)}</div>` +
    `<div class="ptext"><b>${stats.done}</b> / ${stats.total} covered${by.flagged ? ` · <span style="color:var(--flagged)">${by.flagged} flagged</span>` : ""}${stats.stale ? ` · <span style="color:var(--stale)">${stats.stale} stale</span>` : ""}${by.deferred ? ` · <span style="color:var(--deferred)">${by.deferred} deferred</span>` : ""}${eta ? ` · ${eta}` : ""}${sig ? ` · <button class="sig-chip" data-act="tour-list" title="Signals in the current queue: findings, open threads, failing tests, stale files. ⇧J / ⇧K walk through them.">⚡ ${sig}</button>` : ""}</div>`;
  $("#progress .sig-chip")?.addEventListener("click", showTourDialog);
  const notesBtn = document.querySelector('.lenses button[data-lens="notes"]');
  if (notesBtn) notesBtn.innerHTML = `Notes${stats.notes ? `<span class="lens-n">${stats.notes}</span>` : ""}<kbd>4</kbd>`;
  $("#btn-sync").classList.toggle("busy", S.syncing);
  $("#btn-sync").title = `Last synced ${S.snap.lastSyncAt ? ago(S.snap.lastSyncAt) : "never"} · head ${pr.headSha.slice(0, 7)} — re-fetch and detect changed files`;
}
function staleOf(status) {
  return S.snap.files.filter((f) => f.stale && statusOf(f) === status).length;
}
function etaText() {
  const p = S.snap.stats.pace;
  if (!p || !p.linesPerMinute) return "";
  const remaining = S.snap.files.filter(isPending).reduce((n, f) => n + (f.changes || 0), 0);
  const min = remaining / p.linesPerMinute;
  if (!isFinite(min)) return "";
  return `<span class="muted" title="${Math.round(p.linesPerMinute)} lines/min over your last ${p.sample} files">~${fmtDuration(min * 60000)} left</span>`;
}

function renderFilterBar() {
  const counts = {};
  for (const [k] of STATUS_FILTERS) counts[k] = 0;
  for (const f of S.snap.files) {
    const s = statusOf(f);
    counts.all++;
    counts[s]++;
    if (isPending(f)) counts.pending++;
    if (f.stale) counts.stale++;
    if (f.review?.noteCount) counts.noted++;
    const c = S.ci?.byFile?.[f.path];
    if (c && (c.failed || c.flaky)) counts.cifail++;
    const th = S.threads?.byFile?.[f.path];
    if (th && (S.showBotThreads ? th.open : th.human)) counts.threads++;
    if (hasActiveFindings(f.path)) counts.findings++;
  }
  const areas = [...new Set(S.snap.files.map((f) => f.area))].sort();
  const filtered = S.filter.status !== "all" || S.filter.tier != null || S.filter.area || S.filter.q || S.filter.story != null;
  const bar = $("#filterbar");
  bar.innerHTML =
    `<input type="search" id="f-q" placeholder="Filter paths… (/)" value="${escapeHtml(S.filter.q)}" />` +
    `<div class="chips">${STATUS_FILTERS.filter(([k]) => (k !== "cifail" || S.ci?.state === "ready") && (k !== "threads" || S.threads) && (k !== "findings" || S.lint)).map(([k, l]) => `<button class="chip ${S.filter.status === k ? "on" : ""}" data-status="${k}"><span class="dot s-${k === "all" ? "unreviewed" : k === "cifail" ? "stale" : k === "threads" ? "noted" : k === "findings" ? "flagged" : k}"></span>${l}<span class="n">${counts[k]}</span></button>`).join("")}</div>` +
    `<select id="f-tier" title="Tier"><option value="">All tiers</option>${TIERS.map((t, i) => `<option value="${i}" ${S.filter.tier === i ? "selected" : ""}>${i}. ${t}</option>`).join("")}</select>` +
    `<select id="f-area" title="Area"><option value="">All areas</option>${areas.map((a) => `<option value="${escapeHtml(a)}" ${S.filter.area === a ? "selected" : ""}>${escapeHtml(a)}</option>`).join("")}</select>` +
    `${S.stories && S.stories.stories.length ? `<select id="f-story" title="Story (sub-PR that introduced the file)"><option value="">All stories</option>${S.stories.stories.map((st) => `<option value="${st.number}" ${S.filter.story === st.number ? "selected" : ""}>#${st.number} ${escapeHtml((st.title || "").slice(0, 60))} (${st.files.filter((p) => S.byPath.has(p)).length})</option>`).join("")}<option value="0" ${S.filter.story === 0 ? "selected" : ""}>Direct commits (${S.stories.direct.files.length})</option></select>` : ""}` +
    `<select id="f-order" title="Queue order">${ORDERS.map(([k, l]) => `<option value="${k}" ${S.order === k ? "selected" : ""}>↕ ${l}</option>`).join("")}</select>` +
    `${filtered ? `<button class="chip on" id="f-clear" title="Show all files again">✕ clear filters</button>` : ""}` +
    `<span class="qcount">${queue().length} in queue${filtered ? ` <span class="muted">(filtered)</span>` : ""}</span>`;
  $("#f-clear")?.addEventListener("click", () => {
    S.filter = { status: "all", tier: null, area: null, q: "", story: null };
    onFilterChange();
  });
  $("#f-story")?.addEventListener("change", (e) => { S.filter.story = e.target.value === "" ? null : Number(e.target.value); onFilterChange(); });
  bar.querySelectorAll(".chip[data-status]").forEach((c) =>
    c.addEventListener("click", () => {
      S.filter.status = c.dataset.status;
      onFilterChange();
    }),
  );
  $("#f-q").addEventListener("input", debounce((e) => { S.filter.q = e.target.value; onFilterChange(true); }, 120));
  $("#f-q").addEventListener("keydown", (e) => { if (e.key === "Escape" || e.key === "Enter") e.target.blur(); });
  $("#f-tier").addEventListener("change", (e) => { S.filter.tier = e.target.value === "" ? null : Number(e.target.value); onFilterChange(); });
  $("#f-area").addEventListener("change", (e) => { S.filter.area = e.target.value || null; onFilterChange(); });
  $("#f-order").addEventListener("change", (e) => { S.order = e.target.value; onFilterChange(); });
}
function onFilterChange(keepFocus = false) {
  S.queueCache = null;
  S.selection.clear();
  savePrefs();
  const active = document.activeElement;
  const pos = active?.selectionStart;
  render();
  if (keepFocus && active?.id) {
    const n = document.getElementById(active.id);
    n?.focus();
    try { n.setSelectionRange(pos, pos); } catch {}
  }
}

function renderActionBar() {
  const bar = $("#actionbar");
  const k = (key, label, cls = "", act = "") => `<span class="k ${cls}" data-act="${act}"><kbd>${key}</kbd>${label}</span>`;
  const common = `<span class="toggle"><label title="After marking a file, jump to the next pending one"><input type="checkbox" id="auto-adv" ${S.autoAdvance ? "checked" : ""}/> auto-advance</label>${k("?", "help", "", "help")}</span>`;
  if (S.lens === "deck") {
    bar.innerHTML =
      `<span class="grp">${k("R", "Reviewed", "reviewed", "status:reviewed")}${k("S", "Skimmed", "skimmed", "status:skimmed")}${k("F", "Flag", "flagged", "status:flagged")}${k("D", "Defer", "deferred", "status:deferred")}${k("U", "Clear", "", "status:unreviewed")}${k("Z", "Undo", "", "undo")}</span>` +
      `<span class="sep"></span><span class="grp">${k("←/→", "file", "", "")}${k("J/K", "hunk", "", "")}${k("⇧J/⇧K", "signal", "", "tour")}${k(".", "next pending", "", "nextpending")}${k("C", "note", "", "note")}</span>` +
      `<span class="sep"></span><span class="grp">${k("V", "split", "", "view:mode")}${k("E", "full file", "", "view:full")}${k("W", "wrap", "", "view:wrap")}${k("\\", "rail", "", "rail")}${k("N", "inspector", "", "side")}</span>` +
      common;
  } else if (S.lens === "ledger") {
    bar.innerHTML =
      `<span class="grp">${k("J/K", "move")}${k("X", "select", "", "select")}${k("A", "select all visible", "", "selectall")}${k("⏎", "open", "", "open")}</span>` +
      `<span class="sep"></span><span class="grp">${k("R", "Reviewed", "reviewed", "status:reviewed")}${k("S", "Skimmed", "skimmed", "status:skimmed")}${k("F", "Flag", "flagged", "status:flagged")}${k("D", "Defer", "deferred", "status:deferred")}${k("U", "Clear", "", "status:unreviewed")} <span class="muted">apply to selection (or highlighted row)</span></span>` +
      common;
  } else if (S.lens === "notes") {
    bar.innerHTML = `<span class="grp">${k("click", "open file at the note", "", "")}${k("E", "export .md", "", "export")}${k("P", "publish to GitHub", "", "publish")}</span>` + common;
  } else {
    bar.innerHTML = `<span class="grp">${k(".", "continue at next pending", "", "resume")}${k("2", "deck (resume current file)", "", "")}${k("⌘K", "jump to file", "", "palette")}${k("↻", "sync", "", "sync")}</span>` + common;
  }
  bar.querySelectorAll(".k[data-act]").forEach((n) => n.addEventListener("click", () => runAction(n.dataset.act)));
  $("#auto-adv").addEventListener("change", (e) => { S.autoAdvance = e.target.checked; savePrefs(); });
}

// ============================================================================
// MAP lens
// ============================================================================

function renderMap(main) {
  const st = S.snap.stats;
  const files = S.snap.files;
  const next = nextPending(S.current) || nextPending(null);
  const tiers = new Map();
  for (const f of files) {
    if (!tiers.has(f.tier)) tiers.set(f.tier, new Map());
    const areas = tiers.get(f.tier);
    if (!areas.has(f.area)) areas.set(f.area, []);
    areas.get(f.area).push(f);
  }
  const lastSync = S.lastSync;
  const newShas = new Set((lastSync?.newCommits || []).map((c) => c.sha));
  const statBox = (cls, v, l) => `<div class="stat ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const pct = Math.round((100 * st.done) / Math.max(1, st.total));
  const linesPct = Math.round((100 * st.linesDone) / Math.max(1, st.linesTotal));
  main.innerHTML = `
  <section class="map">
    <div class="map-main">
      <div class="map-stats">
        ${statBox("", `${pct}%`, `${st.done} of ${st.total} files`)}
        ${statBox("", `${linesPct}%`, `${fmtNum(st.linesDone)} of ${fmtNum(st.linesTotal)} lines`)}
        ${statBox("c-reviewed", st.byStatus.reviewed, "reviewed")}
        ${statBox("c-skimmed", st.byStatus.skimmed, "skimmed")}
        ${statBox("c-flagged", st.byStatus.flagged, "flagged")}
        ${statBox("c-deferred", st.byStatus.deferred, "deferred")}
        ${statBox("c-stale", st.stale, "changed since review")}
        ${statBox("", st.notes, "notes")}
        ${S.threads ? statBox("c-threads", S.threads.counts.humanOpen, `open threads · ${S.threads.counts.botOpen} from bots`) : ""}
        ${S.lint ? (() => { const act = S.lint.findings.filter((x) => !isDismissed(x)); const dis = S.lint.findings.length - act.length; return `<div class="stat c-findings" data-act="lint" style="cursor:pointer" title="Findings by rule"><div class="v">${act.length}</div><div class="l">findings · ${act.filter((x) => x.level === "error").length} errors${dis ? ` · ${dis} dismissed` : ""}</div></div>`; })() : ""}
      </div>
      ${S.ci?.state === "ready" ? `<div class="ci-card"><div><b>Playwright</b> <span class="muted">${ciRunLabel(S.ci.run)}</span></div><div class="ci-card-counts"><span class="ci-ok">✓ ${S.ci.stats.passed}</span><span class="ci-fail">✗ ${S.ci.stats.failed}</span><span class="ci-flaky">↻ ${S.ci.stats.flaky}</span><span class="ci-skip">– ${S.ci.stats.skipped}</span>${S.ci.clusters?.length ? `<span class="muted">· top cause: ${escapeHtml(S.ci.clusters[0].signature.slice(0, 70))} (${S.ci.clusters[0].tests.length}×)</span>` : ""}</div><span class="sp"></span><button data-act="ci">Failures by error signature →</button>${S.ci.newer ? `<span class="pill" style="color:var(--flagged)">newer run available</span>` : ""}</div>` : S.ci?.state === "loading" || S.ci?.state === "discovering" ? `<div class="ci-card muted">⟳ ${escapeHtml(S.ci.progress || "Loading Playwright results…")}</div>` : ""}
      ${briefHtml()}
      ${sittingHtml()}
      <div class="map-cta">
        ${next ? `<button class="primary" data-open="${escapeHtml(next.path)}">▶ Continue · <span class="mono">${escapeHtml(shortPath(next.path))}</span></button>` : `<span class="hint">🎉 Nothing pending in the current queue.</span>`}
        ${st.stale ? `<button data-act="review-stale">⟲ Re-review ${st.stale} changed file${st.stale > 1 ? "s" : ""}</button>` : ""}
        ${tourList().length ? `<button data-act="tour-list">⚡ ${tourList().length} signals</button>` : ""}
        <button data-act="export">⇩ Export notes (.md)</button>
        <button data-act="publish">↑ Publish notes to GitHub…</button>
        <span class="hint">${etaText() || (st.pace ? "" : "ETA appears after a few reviewed files.")}</span>
      </div>
      ${S.stories && S.stories.stories.length ? (() => {
        const all = [...S.stories.stories, ...(S.stories.direct.files.length ? [S.stories.direct] : [])];
        const doneOf = (st) => st.files.filter((p) => { const f = S.byPath.get(p); return f && DONE.has(statusOf(f)) && !f.stale; }).length;
        const covered = S.stories.stories.filter((st) => { const n = st.files.filter((p) => S.byPath.has(p)).length; return n && doneOf(st) === n; }).length;
        return `<div class="stories ${S.storiesOpen ? "" : "closed"}"><h3 class="sec-toggle" data-toggle="stories"><span>Stories <span class="mini">${S.stories.stories.length} sub-PRs merged into this branch${S.stories.direct.files.length ? ` · ${S.stories.direct.files.length} files from direct commits` : ""}${covered ? ` · ${covered} fully covered` : ""}${S.storiesOpen ? ` · attribution via ${S.stories.source === "git" ? "local git" : "GitHub API"}` : ""}</span></span><span class="caret">${S.storiesOpen ? "▾" : "▸"}</span></h3>
        ${S.storiesOpen ? all.map((st) => storyCard(st)).join("") : `<div class="stories-mini">${S.stories.stories.map((st) => { const n = st.files.filter((p) => S.byPath.has(p)).length; const d = doneOf(st); return `<button class="pill story-mini ${n && d === n ? "done" : ""}" data-story-open="${st.number}" title="${escapeHtml(st.title || "")} — ${d}/${n} files covered. Click for the description; expand Stories for the cards.">#${st.number} <span class="muted">${d}/${n}</span></button>`; }).join("")}</div>`}</div>`;
      })() : ""}
      ${[...tiers.keys()].sort((a, b) => a - b).map((t) => {
        const areas = tiers.get(t);
        const all = [...areas.values()].flat();
        const done = all.filter((f) => DONE.has(statusOf(f)) && !f.stale).length;
        return `<div class="tier-block"><h3>${t}. ${TIERS[t]} <span class="mini">${done}/${all.length}</span></h3><div class="areas">${[...areas.keys()].sort().map((a) => areaCard(a, areas.get(a))).join("")}</div></div>`;
      }).join("")}
    </div>
    <aside class="map-side">
      <div class="legend">
        <span><i class="tile"></i> unreviewed</span><span><i class="tile s-reviewed"></i> reviewed</span><span><i class="tile s-skimmed"></i> skimmed</span>
        <span><i class="tile s-flagged"></i> flagged</span><span><i class="tile s-deferred"></i> deferred</span><span><i class="tile stale"></i> changed since review</span>
        <span class="muted">tile size ∝ lines changed · white dot = has notes</span>
      </div>
      ${S.risk ? (() => { const top = [...S.snap.files].filter((f) => (S.risk.byPath[f.path]?.score || 0) >= 40).sort((a, b) => riskScore(b) - riskScore(a)).slice(0, 10); return top.length ? `<h3>Riskiest files <span class="muted" title="Structural risk: importers × exports × missing specs × sensitive paths — not just size">by structure</span></h3><ul class="risk-list">${top.map((f) => `<li data-open="${escapeHtml(f.path)}" title="${escapeHtml(S.risk.byPath[f.path].reasons.join(" · "))}"><span class="dot s-${f.stale ? "stale" : statusOf(f)}"></span><span class="mono nm">${escapeHtml(shortPath(f.path))}</span>${riskPill(f.path, { compact: true })}</li>`).join("")}</ul><p class="muted" style="font-size:11.5px;margin:4px 0 12px">Queue order <b>Risk first</b> uses these scores.</p>` : ""; })() : ""}
      <h3>Commits (${S.snap.commits.length}) <span class="muted">newest first</span></h3>
      <ul class="commits">${[...S.snap.commits].reverse().map((c) => `<li class="${newShas.has(c.sha) ? "new" : ""}"><a class="sha" href="${S.snap.pr.url.replace(/\/pull\/\d+$/, "")}/commit/${c.sha}" target="_blank" rel="noopener">${c.sha.slice(0, 7)}</a><span class="msg" title="${escapeHtml(c.message)}">${escapeHtml(c.message.split("\n")[0])}</span></li>`).join("")}</ul>
      <div class="history">Head <span class="mono">${S.snap.pr.headSha.slice(0, 7)}</span> · synced ${S.snap.lastSyncAt ? ago(S.snap.lastSyncAt) : "never"} · ${S.snap.history.length} sync${S.snap.history.length === 1 ? "" : "s"}${S.snap.dropped.length ? `<br/>${S.snap.dropped.length} file${S.snap.dropped.length > 1 ? "s" : ""} you touched are no longer in the PR` : ""}
        <div class="history-actions"><button class="ghost tb" data-act="backups" title="Rolling backups of this review's state">⧉ Backups…</button><button class="ghost tb" data-act="reset" title="Clear statuses and start over (a backup is taken first)">↺ Start a fresh review…</button><a class="ghost tb" href="/" title="All pull requests">⌂ All PRs</a></div></div>
    </aside>
  </section>`;
  main.querySelectorAll("[data-open]").forEach((n) => n.addEventListener("click", () => openFile(n.dataset.open)));
  main.querySelectorAll("[data-act]").forEach((n) => n.addEventListener("click", () => runAction(n.dataset.act)));
  main.querySelector("[data-toggle=brief]")?.addEventListener("click", () => { S.briefOpen = !S.briefOpen; savePrefs(); renderMap(main); });
  main.querySelector("[data-toggle=stories]")?.addEventListener("click", () => { S.storiesOpen = !S.storiesOpen; savePrefs(); renderMap(main); });
  main.querySelectorAll("[data-sit-min]").forEach((n) => n.addEventListener("click", () => { S.sittingMin = Number(n.dataset.sitMin); renderMap(main); }));
  main.querySelectorAll(".area-card .nm").forEach((n) => n.addEventListener("click", () => { S.filter.area = n.dataset.area; S.filter.status = "all"; onFilterChange(); navigate("ledger"); }));
  main.querySelectorAll("[data-story-review]").forEach((n) => n.addEventListener("click", () => reviewStory(Number(n.dataset.storyReview))));
  main.querySelectorAll("[data-story-open]").forEach((n) => n.addEventListener("click", () => showStory(Number(n.dataset.storyOpen))));
}
function storyCard(st) {
  const files = st.files.map((p) => S.byPath.get(p)).filter(Boolean);
  const done = files.filter((f) => DONE.has(statusOf(f)) && !f.stale).length;
  const flagged = files.filter((f) => statusOf(f) === "flagged").length;
  const pct = files.length ? Math.round((100 * done) / files.length) : 0;
  const depth = st.depth || 0;
  return `<div class="story-card" style="margin-left:${depth * 18}px">
    <div class="story-head">
      <span class="story-num mono">${st.number ? `#${st.number}` : "direct"}</span>
      <span class="story-title" data-story-open="${st.number}">${escapeHtml(st.title || "")}</span>
      <span class="muted story-meta">${st.author ? "@" + escapeHtml(st.author) : ""}${st.mergedAt ? " · merged " + ago(st.mergedAt) : ""}${st.reviewComments ? ` · 💬 ${st.reviewComments}` : ""}${st.commits?.length ? ` · ${st.commits.length} commit${st.commits.length > 1 ? "s" : ""}` : ""}</span>
    </div>
    <div class="story-prog"><div class="pbar"><i class="s-reviewed" style="width:${pct}%"></i>${flagged ? `<i class="s-flagged" style="width:${(100 * flagged) / Math.max(1, files.length)}%"></i>` : ""}</div><span class="muted">${done}/${files.length} files</span>
      <button data-story-review="${st.number}" ${files.length ? "" : "disabled"}>Review →</button><button class="ghost" data-story-open="${st.number}">details</button></div>
  </div>`;
}
function reviewStory(n) {
  S.filter = { status: "all", tier: null, area: null, q: "", story: n };
  S.order = "foundations";
  S.queueCache = null;
  savePrefs();
  const first = nextPending(null) || queue()[0];
  if (first) openFile(first.path);
  else render();
}
function showStory(n) {
  const st = storyMeta(n);
  if (!st) return;
  const files = (st.files || []).map((p) => S.byPath.get(p)).filter(Boolean);
  const done = files.filter((f) => DONE.has(statusOf(f)) && !f.stale).length;
  const issues = (st.issues || []).map((i) => S.stories.issues?.[i] || { number: i });
  dialog({
    title: `${st.number ? `#${st.number} · ` : ""}${escapeHtml(st.title || "")}`,
    body: `<p class="muted">${st.author ? "@" + escapeHtml(st.author) + " · " : ""}${st.branch ? `<span class="mono">${escapeHtml(st.branch)}</span>` : ""}${st.baseRef ? ` → <span class="mono">${escapeHtml(st.baseRef)}</span>` : ""}${st.mergedAt ? ` · merged ${ago(st.mergedAt)}` : ""}${st.url ? ` · <a href="${st.url}" target="_blank" rel="noopener">GitHub ↗</a>` : ""}</p>
      <p><b>${done}/${files.length}</b> of its files covered${st.reviewComments ? ` · ${st.reviewComments} review comments on the sub-PR` : ""}${st.changedFiles ? ` · PR diff: ${st.changedFiles} files, +${st.additions} −${st.deletions}` : ""}</p>
      ${issues.length ? `<h4>Linked issues</h4><ul>${issues.map((i) => `<li>${i.url ? `<a href="${i.url}" target="_blank" rel="noopener">#${i.number}</a>` : `#${i.number}`} ${escapeHtml(i.title || "")} ${i.state ? `<span class="pill tiny">${i.state}</span>` : ""}</li>`).join("")}</ul>` : ""}
      ${st.body ? `<h4>Description</h4><div class="story-body">${renderMarkdownLite(st.body)}</div>` : ""}
      ${st.commits?.length ? `<details><summary class="muted">${st.commits.length} commit${st.commits.length > 1 ? "s" : ""}</summary><ul class="mono" style="font-size:12px">${st.commits.map((c) => `<li>${c.sha.slice(0, 7)} ${escapeHtml(c.subject)}</li>`).join("")}</ul></details>` : ""}`,
    buttons: [{ label: `Review these ${files.length} files`, primary: true, onClick: () => reviewStory(n) }, { label: "Close" }],
  });
}
// ---------- review brief (what the author says this is) + sitting planner ----------

function briefFacts() {
  const pr = S.snap.pr;
  const body = pr.body || "";
  const repoUrl = pr.url.replace(/\/pull\/\d+$/, "");
  const issues = new Map();
  for (const m of body.matchAll(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:#|https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/)(\d+)/gi)) issues.set(Number(m[2]), { n: Number(m[2]), closes: true });
  for (const m of body.matchAll(/(?:^|[\s(])#(\d+)\b/g)) if (!issues.has(Number(m[1]))) issues.set(Number(m[1]), { n: Number(m[1]), closes: false });
  for (const m of body.matchAll(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/g)) if (!issues.has(Number(m[1]))) issues.set(Number(m[1]), { n: Number(m[1]), closes: false });
  const boxes = body.match(/^\s*[-*]\s+\[[ xX]\]/gm) || [];
  const ticked = boxes.filter((b) => /\[[xX]\]/.test(b)).length;
  const media = (body.match(/!\[[^\]]*\]\([^)]+\)|<img\b|\.(?:png|gif|mp4|mov|webm)\b/gi) || []).length;
  return { pr, repoUrl, issues: [...issues.values()].slice(0, 12), boxes: boxes.length, ticked, media, words: body.trim() ? body.trim().split(/\s+/).length : 0 };
}
function briefHtml() {
  const { pr, repoUrl, issues, boxes, ticked, media, words } = briefFacts();
  const open = S.briefOpen;
  const merge = pr.mergeable === false ? `<span class="pill" style="color:var(--flagged)" title="GitHub reports merge conflicts with ${escapeHtml(pr.baseRef || "the base branch")}">⚠ conflicts with ${escapeHtml(pr.baseRef || "base")}</span>` : pr.mergeable === true ? `<span class="pill tiny ok">mergeable</span>` : "";
  const facts = [
    `<span><b>@${escapeHtml(pr.author || "?")}</b></span>`,
    `<span class="mono">${escapeHtml(pr.headRef || "")} → ${escapeHtml(pr.baseRef || "")}</span>`,
    pr.draft ? `<span class="pill tiny">draft</span>` : "",
    pr.state && pr.state !== "open" ? `<span class="pill tiny">${escapeHtml(pr.state)}</span>` : "",
    merge,
    `<span class="muted">${fmtNum(pr.changedFiles || S.snap.files.length)} files · <span class="a">+${fmtNum(pr.additions || 0)}</span> <span class="d">−${fmtNum(pr.deletions || 0)}</span> · ${pr.commitCount || S.snap.commits.length} commits</span>`,
    S.stories?.stories?.length ? `<span class="muted">${S.stories.stories.length} sub-PRs</span>` : "",
    pr.labels?.length ? pr.labels.map((l) => `<span class="pill tiny">${escapeHtml(l)}</span>`).join("") : "",
    issues.length ? `<span class="muted">issues:</span> ${issues.map((i) => `<a href="${repoUrl}/issues/${i.n}" target="_blank" rel="noopener" title="${i.closes ? "closed by this PR" : "mentioned"}">${i.closes ? "✓ " : ""}#${i.n}</a>`).join(" ")}` : "",
    boxes ? `<span class="muted" title="Task-list items in the description">checklist ${ticked}/${boxes}</span>` : "",
    media ? `<span class="muted">${media} screenshot${media > 1 ? "s" : ""}/recording${media > 1 ? "s" : ""} in the description</span>` : "",
  ].filter(Boolean);
  const bodyHtml = words ? renderMarkdownLite(pr.body.length > 1800 ? pr.body.slice(0, 1800) + "\n\n…" : pr.body) : `<p class="muted">The description is empty — the author hasn't said what this is or how to verify it. Worth asking before reading 98k lines.</p>`;
  return `<div class="brief ${open ? "" : "closed"}">
    <h3 class="sec-toggle" data-toggle="brief"><span>Brief <span class="mini">what the author says this is${words ? ` · ${words} words` : ""}</span></span><span class="caret">${open ? "▾" : "▸"}</span></h3>
    <div class="brief-facts">${facts.join("")}</div>
    ${open ? `<div class="brief-body th-body">${bodyHtml}</div>${pr.body && pr.body.length > 1800 ? `<button class="ghost tb" data-act="brief">read the whole description</button>` : ""}` : ""}
  </div>`;
}
function showBriefDialog() {
  const pr = S.snap.pr;
  dialog({ title: `#${pr.number} ${escapeHtml(pr.title)}`, body: `<div class="th-body">${renderMarkdownLite(pr.body || "_(empty)_")}</div><p class="muted"><a href="${pr.url}" target="_blank" rel="noopener">Open on GitHub ↗</a></p>`, buttons: [{ label: "Close" }] });
}
const DEFAULT_LPM = 100; // lines per active minute assumed until Sift has measured your pace
function planSitting(minutes) {
  const lpm = S.snap.stats.pace?.linesPerMinute || DEFAULT_LPM;
  const start = nextPending(S.current) || nextPending(null);
  if (!start) return { files: [], lines: 0, minutes: 0, lpm, measured: Boolean(S.snap.stats.pace) };
  const q = queue();
  let i = q.findIndex((f) => f.path === start.path);
  const files = [];
  let lines = 0;
  while (i >= 0 && i < q.length) {
    const f = q[i++];
    if (!isPending(f)) continue;
    files.push(f);
    lines += f.changes || 0;
    if (lines / lpm >= minutes) break;
  }
  return { files, lines, minutes: lines / lpm, lpm, measured: Boolean(S.snap.stats.pace) };
}
function sittingHtml() {
  const sittings = S.snap.sittings || [];
  const last = sittings[sittings.length - 1];
  const mins = S.sittingMin || 30;
  const plan = planSitting(mins);
  const pending = S.snap.files.filter(isPending).length;
  const lastHtml = last
    ? `<div class="sit-last"><b>Last sitting</b> · ${last.files} file${last.files === 1 ? "" : "s"} · ${fmtNum(last.lines)} lines · ${fmtDuration(Math.max(60000, last.durationMs))} · ended ${ago(last.end)}${last.last && S.byPath.has(last.last) ? ` · stopped at <a data-open="${escapeHtml(last.last)}" class="mono">${escapeHtml(shortPath(last.last))}</a>` : ""}${sittings.length > 1 ? ` <span class="muted">· ${sittings.length} sittings so far</span>` : ""}</div>`
    : `<div class="sit-last muted">No sittings yet. Pick a chunk below and press start.</div>`;
  const planHtml = plan.files.length
    ? `<div class="sit-plan"><b>Next ${mins} min</b> <span class="seg">${[15, 30, 60].map((m) => `<button class="${m === mins ? "on" : ""}" data-sit-min="${m}">${m}m</button>`).join("")}</span> → <b>${plan.files.length}</b> file${plan.files.length === 1 ? "" : "s"} · ${fmtNum(plan.lines)} lines <span class="muted">at ~${Math.round(plan.lpm)} lines/min${plan.measured ? "" : " (default until Sift has measured your pace)"}</span>
        <button class="primary" data-open="${escapeHtml(plan.files[0].path)}">▶ Start · <span class="mono">${escapeHtml(shortPath(plan.files[0].path))}</span></button>
        <details class="sit-files"><summary class="muted">the ${plan.files.length} files</summary><ul class="mono">${plan.files.map((f) => `<li><a data-open="${escapeHtml(f.path)}">${escapeHtml(f.path)}</a> <span class="muted">${f.changes} lines</span></li>`).join("")}</ul></details>
        ${pending > plan.files.length ? `<span class="muted">${pending - plan.files.length} more pending after that</span>` : `<span class="muted">that's everything pending in this queue</span>`}</div>`
    : `<div class="sit-plan muted">Nothing pending in the current queue.</div>`;
  return `<div class="sitting">${lastHtml}${planHtml}</div>`;
}

function renderMarkdownLite(md) {
  const lines = String(md).replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const out = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const esc = escapeHtml(line).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(https?:\/\/\S+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/(^|\s)#(\d+)\b/g, `$1<a href="${S.snap.pr.url.replace(/\/pull\/\d+$/, "")}/issues/$2" target="_blank" rel="noopener">#$2</a>`);
    if (/^#{1,6}\s/.test(line)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<h4>${esc.replace(/^#+\s*/, "")}</h4>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${esc.replace(/^\s*[-*]\s+/, "")}</li>`);
    } else if (!line.trim()) {
      if (inList) { out.push("</ul>"); inList = false; }
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p>${esc}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}
async function loadStories() {
  try {
    S.stories = await api("/api/stories");
    S.queueCache = null;
    renderFilterBar();
    if (S.lens === "map") renderMap($("#lens"));
    else if (S.lens === "deck" && S.current) { renderRail(); renderPaneHead(); }
    else if (S.lens === "ledger") renderLedger($("#lens"));
  } catch {}
}
function areaCard(area, files) {
  files.sort((a, b) => a.path.localeCompare(b.path));
  const done = files.filter((f) => DONE.has(statusOf(f)) && !f.stale).length;
  const by = {};
  for (const f of files) {
    const k = f.stale ? "stale" : statusOf(f);
    by[k] = (by[k] || 0) + 1;
  }
  const seg = (k) => (by[k] ? `<i class="s-${k}" style="width:${(100 * by[k]) / files.length}%;background:var(--${k})"></i>` : "");
  return `<div class="area-card"><header><span class="nm" data-area="${escapeHtml(area)}" title="Open ${escapeHtml(area)} in the ledger">${escapeHtml(area)}</span><span class="ct">${done}/${files.length}</span></header>
    <div class="mbar">${seg("reviewed")}${seg("skimmed")}${seg("flagged")}${seg("stale")}${seg("deferred")}</div>
    <div class="tiles">${files.map((f) => `<a class="tile s-${statusOf(f)} sz-${sizeBucket(f.changes)} ${f.stale ? "stale" : ""} ${f.review?.noteCount ? "noted" : ""} ${f.path === S.current ? "cur" : ""}" data-open="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}  +${f.additions} −${f.deletions} · ${STATUS_LABEL[statusOf(f)]}${f.stale ? " · changed since review" : ""}"></a>`).join("")}</div></div>`;
}
function sizeBucket(n) {
  return n < 20 ? 0 : n < 100 ? 1 : n < 300 ? 2 : n < 800 ? 3 : 4;
}

// ============================================================================
// LEDGER lens
// ============================================================================

function renderLedger(main) {
  const q = queue();
  if (S.ledgerHl && !q.some((f) => f.path === S.ledgerHl)) S.ledgerHl = null;
  if (!S.ledgerHl && q.length) S.ledgerHl = q[0].path;
  const grouped = S.order === "foundations" || S.order === "path" || S.order === "story";
  const grpOf = (x) => (S.order === "foundations" ? `${x.tier}. ${TIERS[x.tier]} › ${x.area}` : S.order === "story" ? storyLabel(storyOf(x.path)) : x.area);
  let lastGrp = null;
  const rows = [];
  for (const f of q) {
    const g = grouped ? grpOf(f) : null;
    if (g && g !== lastGrp) {
      const inGrp = q.filter((x) => grpOf(x) === g);
      rows.push(`<tr class="grp-row"><td colspan="9">${escapeHtml(g)}<span class="ct">${inGrp.filter((x) => DONE.has(statusOf(x)) && !x.stale).length}/${inGrp.length}</span></td></tr>`);
      lastGrp = g;
    }
    const s = statusOf(f);
    const [dir, base] = splitPath(f.path);
    rows.push(
      `<tr class="r ${S.selection.has(f.path) ? "selected" : ""} ${S.ledgerHl === f.path ? "hl" : ""}" data-path="${escapeHtml(f.path)}">` +
        `<td><input type="checkbox" ${S.selection.has(f.path) ? "checked" : ""} data-sel="${escapeHtml(f.path)}"/></td>` +
        `<td class="st"><span class="pill s-${s} ${f.stale ? "stale" : ""}">${f.stale ? "stale" : STATUS_LABEL[s]}</span></td>` +
        `<td class="path" title="${escapeHtml(f.path)}"><span class="dir">${escapeHtml(dir)}</span>${escapeHtml(base)}${f.status !== "modified" ? ` <span class="pill fs-${f.status}">${f.status}</span>` : ""}${S.risk ? ` ${riskPill(f.path)}` : (f.risks || []).filter((r) => r !== "generated-ish").map((r) => ` <span class="pill risk">${r}</span>`).join("")}</td>` +
        `<td class="tier">${TIERS[f.tier]}</td>` +
        `<td class="num"><span class="pm"><span class="a">+${f.additions}</span> <span class="d">−${f.deletions}</span></span></td>` +
        `<td class="num">${f.review?.noteCount ? `✎ ${f.review.noteCount}` : ""}</td>` +
        `<td class="num">${ciBadge(f.path)}${threadBadge(f.path)}${lintBadge(f.path)}</td>` +
        `<td class="num when">${f.review?.timeMs ? fmtDuration(f.review.timeMs) : ""}</td>` +
        `<td class="when">${f.review?.at && s !== "unreviewed" ? ago(f.review.at) : ""}</td></tr>`,
    );
  }
  main.innerHTML = `<section class="ledger"><table><thead><tr><th style="width:30px"></th><th>Status</th><th>File</th><th>Tier</th><th style="text-align:right">Δ</th><th style="text-align:right">Notes</th><th style="text-align:right">CI</th><th style="text-align:right">Time</th><th>When</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="9" class="empty">No files match the current filter.</td></tr>`}</tbody></table>
    ${S.selection.size ? `<div class="bulkbar"><b>${S.selection.size} selected</b>${["reviewed", "skimmed", "flagged", "deferred", "unreviewed"].map((s) => `<button data-bulk="${s}">${s === "unreviewed" ? "Clear" : STATUS_LABEL[s]}</button>`).join("")}<button class="ghost" data-bulk="none">Deselect</button></div>` : ""}
  </section>`;
  main.querySelectorAll("tr.r").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("input")) return;
      if (e.shiftKey && S.ledgerHl) {
        rangeSelect(S.ledgerHl, tr.dataset.path);
        return;
      }
      openFile(tr.dataset.path);
    });
  });
  main.querySelectorAll("input[data-sel]").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) S.selection.add(cb.dataset.sel);
      else S.selection.delete(cb.dataset.sel);
      S.ledgerHl = cb.dataset.sel;
      renderLedger(main);
    }),
  );
  main.querySelectorAll("[data-bulk]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.bulk === "none") {
        S.selection.clear();
        renderLedger(main);
      } else bulkStatus([...S.selection], b.dataset.bulk);
    }),
  );
  $(".ledger tr.hl")?.scrollIntoView({ block: "nearest" });
}
function rangeSelect(a, b) {
  const q = queue();
  let i = queueIndex(a);
  let j = queueIndex(b);
  if (i < 0 || j < 0) return;
  if (i > j) [i, j] = [j, i];
  for (let k = i; k <= j; k++) S.selection.add(q[k].path);
  S.ledgerHl = b;
  renderLedger($("#lens"));
}
function ledgerMove(dir) {
  const q = queue();
  if (!q.length) return;
  const i = Math.max(0, queueIndex(S.ledgerHl));
  S.ledgerHl = q[Math.min(q.length - 1, Math.max(0, i + dir))].path;
  renderLedger($("#lens"));
}

// ============================================================================
// DECK lens
// ============================================================================

function renderDeck(main) {
  if (!main.querySelector(".deck")) {
    main.innerHTML = `<section class="deck"><nav class="rail"></nav><div class="pane"><div class="pane-head"></div><div class="banner-slot"></div><div class="pane-body"></div></div><aside class="side"></aside><div class="rz rz-rail" title="Drag to resize · double-click to reset"></div><div class="rz rz-side" title="Drag to resize · double-click to reset"></div></section>`;
    S.bodyKey = null;
    wireResizers(main.querySelector(".deck"));
  }
  const deck = main.querySelector(".deck");
  applyPanelWidths(deck);
  deck.classList.toggle("no-rail", !S.rail);
  deck.classList.toggle("no-side", !S.side);
  if (S.current && !S.byPath.has(S.current)) S.current = null;
  if (!S.current) S.current = (nextPending(null) || queue()[0])?.path || null;
  renderRail();
  if (!S.current) {
    $(".pane-head").innerHTML = "";
    $(".banner-slot").innerHTML = "";
    $(".pane-body").innerHTML = `<div class="empty-state"><h2>Queue is empty</h2>Adjust the filters above, or press <kbd>1</kbd> for the map.</div>`;
    $(".side").innerHTML = "";
    S.bodyKey = null;
    return;
  }
  renderPaneHead();
  renderJumpBar();
  renderTourBar();
  loadDetail(S.current).then((d) => {
    if (S.current !== d.path) return;
    S.detail = d;
    renderPaneHead();
    renderBanner();
    renderSide();
    // Only re-render the (expensive) diff body when something that affects it changed.
    const key = bodyKey(d);
    if (key !== S.bodyKey) {
      S.bodyKey = key;
      renderBody();
    } else applyPendingScroll();
    prefetchNext();
  }).catch((err) => {
    $(".pane-body").innerHTML = `<div class="empty-state"><h2>Couldn't load file</h2>${escapeHtml(err.message)}</div>`;
    S.bodyKey = null;
  });
}
function applyPanelWidths(deck) {
  if (S.railW) deck.style.setProperty("--rail-w", `${S.railW}px`);
  else deck.style.removeProperty("--rail-w");
  if (S.sideW) deck.style.setProperty("--side-w", `${S.sideW}px`);
  else deck.style.removeProperty("--side-w");
}
/** Drag the rail's right edge or the inspector's left edge; widths persist in prefs. */
function wireResizers(deck) {
  const start = (which) => (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = which === "rail" ? deck.querySelector(".rail").getBoundingClientRect().width : deck.querySelector(".side").getBoundingClientRect().width;
    deck.classList.add("resizing");
    const move = (ev) => {
      const dx = ev.clientX - x0;
      const w = Math.max(160, Math.min(window.innerWidth * 0.5, which === "rail" ? w0 + dx : w0 - dx));
      S[which === "rail" ? "railW" : "sideW"] = Math.round(w);
      applyPanelWidths(deck);
    };
    const up = () => {
      deck.classList.remove("resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      savePrefs();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  deck.querySelector(".rz-rail").addEventListener("mousedown", start("rail"));
  deck.querySelector(".rz-side").addEventListener("mousedown", start("side"));
  deck.querySelector(".rz-rail").addEventListener("dblclick", () => { S.railW = null; applyPanelWidths(deck); savePrefs(); });
  deck.querySelector(".rz-side").addEventListener("dblclick", () => { S.sideW = null; applyPanelWidths(deck); savePrefs(); });
}
function bodyKey(d) {
  const f = S.byPath.get(d.path);
  const v = S.view;
  return [d.path, f.sha, v.mode, v.full, v.inter, v.words, S.foldMoved, S.moveLines.has(d.path), altView(d.path)?.on ? `alt:${altView(d.path).kind}:${S.ci?.run?.id || ""}` : "", (f.review?.notes || []).map((n) => `${n.id}:${n.text.length}`).join(",")].join("|");
}

async function loadDetail(path) {
  const f = S.byPath.get(path);
  const c = S.detailCache.get(path);
  if (c && c.sha === f.sha) return c.detail;
  const d = await api(`/api/file?path=${encodeURIComponent(path)}`);
  d.hunks = parsePatch(d.patch);
  S.detailCache.set(path, { sha: f.sha, detail: d });
  if (S.detailCache.size > 60) S.detailCache.delete(S.detailCache.keys().next().value);
  return d;
}
function prefetchNext() {
  let p = S.current;
  for (let i = 0; i < 2; i++) {
    const n = nextPending(p);
    if (!n || n.path === S.current) break;
    loadDetail(n.path).catch(() => {});
    p = n.path;
  }
}

function renderRail() {
  const rail = $(".rail");
  const q = queue();
  if (!q.length) {
    rail.innerHTML = `<div class="empty">Nothing matches the filter.</div>`;
    return;
  }
  const grpKey = (f) => (S.order === "foundations" ? `${TIERS[f.tier]} › ${f.area}` : S.order === "story" ? storyLabel(storyOf(f.path), { short: true }) : S.order === "path" || S.order === "stale" ? f.area : null);
  const parts = [];
  let last = null;
  let grpFiles = [];
  const flush = () => {
    if (!last) return;
    const done = grpFiles.filter((f) => DONE.has(statusOf(f)) && !f.stale).length;
    parts.push(`<div class="grp"><span class="nm" title="${escapeHtml(last)}">${escapeHtml(last)}</span><span class="ct">${done}/${grpFiles.length}</span></div>`);
    parts.push(...grpFiles.map(railRow));
    grpFiles = [];
  };
  for (const f of q) {
    const g = grpKey(f);
    if (g === null) {
      parts.push(railRow(f));
      continue;
    }
    if (g !== last) {
      flush();
      last = g;
    }
    grpFiles.push(f);
  }
  flush();
  rail.innerHTML = parts.join("");
  rail.querySelectorAll(".f").forEach((n) => n.addEventListener("click", () => openFile(n.dataset.path)));
  rail.querySelector(".f.cur")?.scrollIntoView({ block: "center" });
}
function railRow(f) {
  const s = statusOf(f);
  return `<div class="f ${f.path === S.current ? "cur" : ""} ${f.stale ? "stale" : ""}" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}"><span class="dot s-${s}"></span><span class="nm"><bdi>${escapeHtml(f.path)}</bdi></span>${f.review?.noteCount ? `<span class="nc">✎${f.review.noteCount}</span>` : ""}${ciBadge(f.path)}${threadBadge(f.path)}${lintBadge(f.path)}<span class="pm"><span class="a">+${f.additions}</span> <span class="d">−${f.deletions}</span></span></div>`;
}

function renderPaneHead() {
  const f = S.byPath.get(S.current);
  const d = S.detail && S.detail.path === S.current ? S.detail : null;
  const s = statusOf(f);
  const [dir, base] = splitPath(f.path);
  const i = queueIndex(f.path);
  const v = S.view;
  const isAdded = f.status === "added";
  $(".pane-head").innerHTML = `
    <div class="ph-row">
      <span class="pill s-${s} ${f.stale ? "stale" : ""}">${f.stale ? "⚠ stale · was " + STATUS_LABEL[s] : STATUS_LABEL[s]}</span>
      <span class="ph-path" title="${escapeHtml(f.path)}"><span class="dir">${escapeHtml(dir)}</span><span class="base">${escapeHtml(base)}</span>${f.previousPath ? `<span class="ren"> ← ${escapeHtml(f.previousPath)}</span>` : ""}</span>
      <button class="ghost" data-act="copy-path" title="Copy path">⧉</button>
      <span class="pm"><span class="a">+${f.additions}</span> <span class="d">−${f.deletions}</span></span>
      <span class="ph-pos">${i >= 0 ? `${i + 1} / ${queue().length}` : "not in queue"}</span>
    </div>
    <div class="ph-row">
      ${f.status !== "modified" ? `<span class="pill fs-${f.status}">${f.status}</span>` : ""}
      <span class="pill" title="Tier">${f.tier}. ${TIERS[f.tier]}</span>
      <span class="pill" title="Area">${escapeHtml(f.area)}</span>
      ${S.risk ? "" : (f.risks || []).filter((r) => r !== "generated-ish").map((r) => `<span class="pill risk" title="Heuristic risk hint (structural score appears once the index is built)">${r}</span>`).join("")}
      ${f.review?.noteCount ? `<span class="pill" style="color:var(--accent)">✎ ${f.review.noteCount} note${f.review.noteCount > 1 ? "s" : ""}</span>` : ""}
      ${d?.patchSource === "computed" ? `<span class="pill" title="GitHub omitted this diff (too large); Sift computed it locally from the blobs">local diff</span>` : ""}
      ${S.stories && storyMeta(storyOf(f.path)) ? `<button class="pill story-chip" data-story="${storyOf(f.path)}" title="Story: the sub-PR whose commits changed this file the most${(() => { const others = S.stories.stories.filter((st) => st.number !== storyOf(f.path) && storyMembers(st.number).has(f.path)).map((st) => "#" + st.number); return others.length ? `. Also touched by ${others.join(", ")}` : ""; })()}. Click for its description.">📖 ${escapeHtml(storyLabel(storyOf(f.path), { short: true }))}${(() => { const n = S.stories.stories.filter((st) => st.number !== storyOf(f.path) && storyMembers(st.number).has(f.path)).length; return n ? ` <span class="muted">+${n}</span>` : ""; })()}</button>` : ""}
      ${riskPill(f.path)}
      ${threadChip(f.path)}
      ${lintChip(f.path)}
      ${moveChip(f)}
      <button class="pill rel-chip" id="rel-chip" hidden title="Related changes — open the panel (N)"></button>
      <span class="sp" style="flex:1"></span>
      <a class="pill" id="gh-link" href="${S.snap.pr.url}/files" target="_blank" rel="noopener" title="Open this file on GitHub (G)">GitHub ↗</a>
    </div>
    <div class="toolbar">
      ${altView(f.path) ? `<span class="seg"><button class="${altView(f.path).on ? "on" : ""}" data-act="outline:on" title="${altView(f.path).kind === "outline" ? "Scenario outline: what each test does" : altView(f.path).kind === "keys" ? "Translation keys as a table with usages" : "API surface: exports, props, hooks, data access"} (O)">${altView(f.path).label}</button><button class="${altView(f.path).on ? "" : "on"}" data-act="outline:off" title="Diff (O)">Code</button></span>` : ""}
      ${altView(f.path)?.on ? "" : `<span class="seg"><button class="${v.mode === "unified" ? "on" : ""}" data-act="view:unified">Unified</button><button class="${v.mode === "split" ? "on" : ""}" data-act="view:split">Split</button></span>`}
      ${altView(f.path)?.on ? "" : `<button class="tb ${v.full ? "on" : ""}" data-act="view:full" ${isAdded || f.status === "removed" ? "disabled title='Added/removed files already show everything'" : "title='Show the whole file with changes highlighted (E)'"}>Full file</button>
      <button class="tb ${v.wrap ? "on" : ""}" data-act="view:wrap" title="Soft-wrap long lines (W)">Wrap</button>
      <button class="tb ${v.words ? "on" : ""}" data-act="view:words" title="Highlight changed words within lines">Words</button>
      ${S.moves?.summary?.[f.path]?.moved ? `<button class="tb ${S.foldMoved ? "on" : ""}" data-act="view:fold" title="Fold runs of code moved verbatim from elsewhere in this PR (M)">Fold moved</button>` : ""}`}
      ${f.stale ? `<button class="tb ${v.inter ? "on" : ""}" data-act="view:inter" title="Show only what changed since you reviewed this file (I)" style="color:var(--stale)">Since my review</button>` : ""}
      <span class="sp"></span>
      <span class="cov-slot">${altView(f.path)?.on ? "" : coverageHtml(f.path)}</span>
      <span class="muted" style="font-size:11.5px">${d ? `${d.hunks.length} hunk${d.hunks.length === 1 ? "" : "s"}` : "loading…"}${f.review?.timeMs ? ` · ${fmtDuration(f.review.timeMs)} here` : ""}</span>
    </div>`;
  $(".pane-head").querySelectorAll("[data-act]").forEach((n) => n.addEventListener("click", () => runAction(n.dataset.act)));
  $(".pane-head .story-chip")?.addEventListener("click", (e) => showStory(Number(e.currentTarget.dataset.story)));
  $("#rel-chip").addEventListener("click", () => {
    if (!S.side) runAction("side");
    if (!S.relatedOpen) {
      S.relatedOpen = true;
      savePrefs();
      renderSide();
    }
    $(".rel-sec")?.scrollIntoView({ block: "start" });
  });
  const cached = S.relatedCache.get(`${f.path}@${S.snap.pr.headSha}`);
  if (cached) updateRelChip(cached);
  githubFileUrl(f.path).then((u) => { const a = $("#gh-link"); if (a && S.current === f.path) a.href = u; });
}
function updateRelChip(data) {
  const chip = $("#rel-chip");
  if (!chip || data.status !== "ready") return;
  const prImports = data.imports.filter((i) => i.target === "pr").length;
  const total = data.usedBy.length + prImports + data.tests.length + data.testedSources.length + data.formerImporters.length;
  const parts = [];
  if (data.usedBy.length) parts.push(`<b>${data.usedBy.length}</b> used by`);
  if (prImports) parts.push(`<b>${prImports}</b> imports`);
  if (data.tests.length) parts.push(`<b>${data.tests.length}</b> tests`);
  if (data.testedSources.length) parts.push(`covers <b>${data.testedSources.length}</b>`);
  if (data.formerImporters.length) parts.push(`<b>${data.formerImporters.length}</b> former importers`);
  chip.innerHTML = total ? `⇄ ${parts.join(" · ")}` : `⇄ no related changes in PR`;
  chip.hidden = false;
}

function renderBanner() {
  const f = S.byPath.get(S.current);
  const slot = $(".banner-slot");
  if (!f.stale) {
    slot.innerHTML = f.status === "removed" ? `<div class="banner info"><b>Deleted file.</b> Showing the removed content; notes attach to the old side.</div>` : "";
    return;
  }
  const r = f.review;
  slot.innerHTML = `<div class="banner"><b>Changed since your review.</b> You marked it <b>${STATUS_LABEL[r.status]}</b> ${ago(r.at)} at <span class="mono">${(r.sha || "").slice(0, 7)}</span>; it is now <span class="mono">${f.sha.slice(0, 7)}</span>${r.fileStatus !== f.status ? ` (status ${r.fileStatus} → ${f.status})` : ""}.<span class="sp"></span>
    <button class="${S.view.inter ? "active" : ""}" data-act="view:inter">${S.view.inter ? "Show full diff" : "Show what changed since"}</button>
    <button data-act="status:${r.status}">Re-mark ${STATUS_LABEL[r.status]} <kbd>${r.status[0].toUpperCase()}</kbd></button></div>`;
  slot.querySelectorAll("[data-act]").forEach((n) => n.addEventListener("click", () => runAction(n.dataset.act)));
}

async function renderBody() {
  const body = $(".pane-body");
  const f = S.byPath.get(S.current);
  const d = S.detail;
  if (!body || !f || !d || d.path !== f.path) return;
  S.seenObserver?.disconnect();
  S.seenObserver = null;
  S.bodyKey = bodyKey(d);
  body.classList.toggle("wrap", S.view.wrap);
  const av = altView(f.path);
  if (av?.on && !S.view.inter) {
    if (av.kind === "outline") return renderOutlineBody(body, f);
    if (av.kind === "surface") return renderSurfaceBody(body, f);
    if (av.kind === "keys") return renderKeysBody(body, f);
  }
  body.innerHTML = `<div class="loading">Rendering…</div>`;
  const notes = f.review?.notes || [];
  try {
    let hunks = d.hunks;
    let fullContent = null;
    let title = "";
    if (S.view.inter && f.stale) {
      const inter = await loadInterdiff(f);
      if (inter.kind === "diff") {
        hunks = parsePatch(inter.patch);
        title = `<div class="banner info"><b>Changes since your review</b> · ${hunks.length} hunk${hunks.length === 1 ? "" : "s"} between <span class="mono">${inter.fromSha.slice(0, 7)}</span> → <span class="mono">${inter.toSha.slice(0, 7)}</span>. Line numbers are of the current file.</div>`;
      } else {
        body.innerHTML = `<div class="empty-state"><h2>${interKindText(inter)}</h2>Showing the full diff instead.<br/><br/><button data-act="view:inter">Back to full diff</button></div>`;
        body.querySelector("[data-act]").addEventListener("click", () => runAction("view:inter"));
        return;
      }
    } else if (S.view.full && f.status !== "added" && f.status !== "removed") {
      fullContent = await loadContent(f.path);
    }
    if (S.current !== f.path) return;
    const r = renderDiff(hunks.map(cloneHunk), {
      mode: S.view.mode,
      language: f.language,
      words: S.view.words,
      notes: S.view.inter ? [] : notes,
      fullContent,
      fileStatus: f.status,
    });
    if (!hunks.length) {
      body.innerHTML = title + `<div class="empty-state"><h2>No textual diff</h2>${f.status === "renamed" ? "Pure rename." : "Binary or empty change."}</div>`;
      return;
    }
    // Very large tables land progressively: the first screens now, the rest in animation-frame chunks,
    // so a 7k-row locale file is readable immediately instead of after one long synchronous parse.
    const FIRST = 900;
    const CHUNK = 1200;
    const progressive = r.rows.length > FIRST + CHUNK;
    body.innerHTML = title + r.open + (progressive ? r.rows.slice(0, FIRST).join("") : r.rows.join("")) + r.close;
    body.scrollTop = 0;
    wireDiffBody(body);
    if (progressive) {
      const tbody = body.querySelector("tbody");
      const note = el(`<div class="render-progress">Rendering ${fmtNum(r.rows.length)} rows… <span>${Math.round((100 * FIRST) / r.rows.length)}%</span></div>`);
      body.appendChild(note);
      const myKey = S.bodyKey;
      let i = FIRST;
      await new Promise((resolve) => {
        const step = () => {
          if (S.current !== f.path || S.bodyKey !== myKey || !tbody.isConnected) return resolve();
          tbody.insertAdjacentHTML("beforeend", r.rows.slice(i, i + CHUNK).join(""));
          i += CHUNK;
          if (i >= r.rows.length) {
            note.remove();
            return resolve();
          }
          note.querySelector("span").textContent = `${Math.round((100 * i) / r.rows.length)}%`;
          nextFrame(step);
        };
        nextFrame(step);
      });
      if (S.current !== f.path || S.bodyKey !== myKey) return;
    }
    if (!S.view.inter) {
      await applyMoves(body, f.path);
      injectThreads(body, f.path);
      injectLint(body, f.path);
    }
    wireContextExpanders(body, f, d);
    observeHunks(body, f, d.hunks);
    S.hunkIdx = -1;
    applyPendingScroll();
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h2>Render failed</h2>${escapeHtml(err.message)}</div>`;
  }
}
/** rAF when visible; a timer when the tab is hidden (rAF pauses there and the render would never finish). */
function nextFrame(cb) {
  if (document.hidden) setTimeout(cb, 16);
  else requestAnimationFrame(cb);
}
function cloneHunk(h) {
  return { ...h, lines: h.lines.map((l) => ({ ...l })) };
}
function interKindText(inter) {
  return { none: "No earlier review to compare against", dropped: "File is no longer in the PR", same: "No changes since your review", "removed-now": "File was deleted since your review", restored: "File was restored since your review" }[inter.kind] || "Nothing to compare";
}
async function loadInterdiff(f) {
  const key = `${f.path}:${f.review?.sha}:${f.sha}`;
  if (!S.interCache.has(key)) S.interCache.set(key, await api(`/api/interdiff?path=${encodeURIComponent(f.path)}`));
  return S.interCache.get(key);
}
async function loadContent(path) {
  const f = S.byPath.get(path);
  const key = `${path}:${f.sha}`;
  if (!S.contentCache.has(key)) {
    const res = await fetch(withPr(`/api/content?path=${encodeURIComponent(path)}&side=head`));
    if (!res.ok) throw new Error("Could not fetch file content");
    S.contentCache.set(key, await res.text());
    if (S.contentCache.size > 20) S.contentCache.delete(S.contentCache.keys().next().value);
  }
  return S.contentCache.get(key);
}

function wireDiffBody(body) {
  body.onclick = (e) => {
    if (e.altKey && e.target.closest("td.code")) {
      e.preventDefault();
      const word = wordAtPoint(e.clientX, e.clientY);
      if (word) gotoDefinition(word, { jump: e.shiftKey });
      return;
    }
    const btn = e.target.closest("button[data-act]");
    if (btn) {
      if (btn.dataset.act === "edit-note") return editNote(btn.dataset.id);
      if (btn.dataset.act === "del-note") return deleteNote(btn.dataset.id);
      return;
    }
    const gl = e.target.closest("td.gl");
    if (gl && gl.dataset.line) {
      e.preventDefault();
      const line = Number(gl.dataset.line);
      const side = gl.dataset.side;
      if (e.shiftKey && S.pendingRange && S.pendingRange.side === side) {
        S.pendingRange.end = line;
      } else S.pendingRange = { side, start: line, end: line };
      openComposer(gl.closest("tr"));
    }
  };
}

function openComposer(afterRow) {
  closeComposer();
  const { side, start, end } = S.pendingRange;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const cols = S.view.mode === "split" ? 4 : 3;
  const row = el(`<tr class="composer"><td colspan="${cols}"><div class="composer-box"><textarea placeholder="Note for L${lo}${hi !== lo ? `–${hi}` : ""}${side === "LEFT" ? " (old side)" : ""}… Markdown ok. ⌘⏎ to save, Esc to cancel, ⇧-click another line number to extend the range."></textarea><div class="row"><span>L${lo}${hi !== lo ? `–${hi}` : ""} · ${side === "LEFT" ? "old" : "new"} side</span>${kindPicker("kp-line")}${side === "RIGHT" ? `<button class="ghost" data-x="suggest" title="Insert the selected lines as a GitHub suggestion block you can edit">✎ Suggest edit</button>` : ""}<span class="sp"></span><button class="ghost" data-x="cancel">Cancel</button><button class="primary" data-x="save">Save note <kbd>⌘⏎</kbd></button></div></div></td></tr>`);
  // Place the composer after the last row of the range.
  const table = afterRow.closest("table");
  const rows = [...table.querySelectorAll(`td.gl[data-side="${side}"]`)].map((td) => td.closest("tr"));
  const target = rows.find((tr) => Number(tr.querySelector(`td.gl[data-side="${side}"]`).dataset.line) === hi) || afterRow;
  target.after(row);
  table.querySelectorAll("tr.line.sel").forEach((tr) => tr.classList.remove("sel"));
  rows.forEach((tr) => {
    const n = Number(tr.querySelector(`td.gl[data-side="${side}"]`).dataset.line);
    if (n >= lo && n <= hi) tr.classList.add("sel");
  });
  const ta = row.querySelector("textarea");
  wireKindPicker(row.querySelector("#kp-line"));
  attachTemplates(ta, { kindRoot: row.querySelector("#kp-line") });
  ta.focus();
  const save = async () => {
    const text = ta.value.trim();
    if (!text) return closeComposer();
    const ok = await addNote({ text, line: lo, endLine: hi !== lo ? hi : null, side, kind: S.noteKind });
    if (ok) closeComposer();
  };
  row.querySelector("[data-x=save]").addEventListener("click", save);
  row.querySelector("[data-x=cancel]").addEventListener("click", closeComposer);
  row.querySelector("[data-x=suggest]")?.addEventListener("click", () => {
    const texts = rows
      .filter((tr) => {
        const n = Number(tr.querySelector(`td.gl[data-side="${side}"]`).dataset.line);
        return n >= lo && n <= hi;
      })
      .map((tr) => {
        const code = tr.querySelector(`td.code[data-side="${side}"]`) || tr.querySelector("td.code");
        return (code?.textContent || "").replace(/^[+−\- ]/, "").replace(/⏎̸$/, "");
      });
    const fence = "```suggestion\n" + texts.join("\n") + "\n```\n";
    ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, "\n\n") : "") + fence;
    ta.focus();
    const pos = ta.value.indexOf("```suggestion\n") + "```suggestion\n".length;
    ta.setSelectionRange(pos, pos);
  });
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
    if (e.key === "Escape") closeComposer();
  });
}
function closeComposer() {
  document.querySelectorAll("tr.composer").forEach((r) => r.remove());
  document.querySelectorAll("tr.line.sel").forEach((tr) => tr.classList.remove("sel"));
}

function renderSide() {
  const f = S.byPath.get(S.current);
  const notes = f.review?.notes || [];
  const side = $(".side");
  side.innerHTML = `
    ${lintSideHtml(f.path)}
    ${threadsSideHtml(f.path)}
    <div class="side-sec rel-sec ${S.relatedOpen ? "" : "closed"}">
      <h3 class="sec-toggle" data-toggle="related"><span>Related <span class="muted" id="rel-count"></span></span><span class="caret">${S.relatedOpen ? "▾" : "▸"}</span></h3>
      <div class="rel-body" id="rel-body"><div class="muted rel-hint">Loading…</div></div>
    </div>
    <div class="side-sec notes-sec">
    <h3>Notes <span>${notes.length}</span></h3>
    <div class="fileinfo">
      <span>status</span><b>${STATUS_LABEL[statusOf(f)]}${f.review?.at && statusOf(f) !== "unreviewed" ? ` · ${ago(f.review.at)}` : ""}</b>
      <span>blob</span><b class="mono">${f.sha.slice(0, 10)}</b>
      <span>language</span><b>${f.language}</b>
    </div>
    <div class="notes">${notes.length ? notes.map(noteCard).join("") : `<div class="muted" style="font-size:12px">No notes. Click a line number in the diff to anchor a note, or write a file-level note below (<kbd>C</kbd>).</div>`}</div>
    <div class="composer"><textarea id="file-note" placeholder="${statusOf(f) === "flagged" ? "Why is this flagged?" : "File-level note…"} ⌘⏎ saves${S.autoAdvance ? " and advances" : ""}."></textarea><div class="row">${kindPicker("kp-file")}<span class="sp"></span><button class="primary" id="save-file-note">Save <kbd>⌘⏎</kbd></button></div></div>
    </div>`;
  side.querySelectorAll("[data-goto]").forEach((n) => n.addEventListener("click", () => scrollToLine(n.dataset.goto, n.dataset.side)));
  side.querySelectorAll("[data-edit]").forEach((n) => n.addEventListener("click", () => editNote(n.dataset.edit)));
  side.querySelectorAll("[data-del]").forEach((n) => n.addEventListener("click", () => deleteNote(n.dataset.del)));
  side.querySelectorAll("[data-thread-goto]").forEach((n) => n.addEventListener("click", () => scrollToThread(n.dataset.threadGoto)));
  side.querySelectorAll("[data-lint-goto]").forEach((n) => n.addEventListener("click", () => gotoLine(Number(n.dataset.lintGoto))));
  side.querySelectorAll("[data-dismiss-side]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const x = (S.lintByPath.get(f.path) || []).find((y) => findingKey(y) === b.dataset.dismissSide);
      if (!x) return;
      if (e.shiftKey) {
        const reason = await promptDialog(`Why is "${x.rule}" fine here?`, "");
        if (reason == null) return;
        return dismissFinding(x, { reason });
      }
      dismissFinding(x);
    }),
  );
  side.querySelectorAll("[data-undismiss]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); undismissFinding(b.dataset.undismiss); }));
  side.querySelector("#toggle-bots")?.addEventListener("change", (e) => { S.showBotThreads = e.target.checked; savePrefs(); renderFilterBar(); renderRail(); renderPaneHead(); renderSide(); renderBody(); });
  side.querySelector("[data-toggle=related]").addEventListener("click", () => {
    S.relatedOpen = !S.relatedOpen;
    savePrefs();
    renderSide();
  });
  const ta = $("#file-note");
  wireKindPicker(side.querySelector("#kp-file"));
  attachTemplates(ta, { kindRoot: side.querySelector("#kp-file") });
  const save = async () => {
    const text = ta.value.trim();
    if (!text) return;
    const ok = await addNote({ text, kind: S.noteKind });
    if (!ok) return;
    ta.value = "";
    S.sideDraft = "";
    if (S.autoAdvance && statusOf(f) === "flagged") advance();
  };
  ta.addEventListener("input", () => (S.sideDraft = ta.value));
  if (S.sideDraft && S.sideDraftPath === f.path) ta.value = S.sideDraft;
  S.sideDraftPath = f.path;
  $("#save-file-note").addEventListener("click", save);
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
    if (e.key === "Escape") ta.blur();
  });
  loadRelated(f.path);
}

// ---------- related changes (cross-reference) ----------

async function loadRelated(path) {
  const key = `${path}@${S.snap.pr.headSha}`;
  let data = S.relatedCache.get(key);
  if (!data) {
    try {
      data = await api(`/api/related?path=${encodeURIComponent(path)}`);
    } catch (err) {
      data = { status: "error", error: err.message };
    }
    if (data.status === "ready") S.relatedCache.set(key, data);
  }
  if (S.current !== path) return;
  renderRelated(data);
  if (data.status === "building") {
    clearTimeout(S.relatedPoll);
    S.relatedPoll = setTimeout(() => S.current === path && loadRelated(path), 1500);
  }
}

function renderRelated(data) {
  const body = $("#rel-body");
  const count = $("#rel-count");
  if (!body) return;
  if (data.status === "building") {
    const p = data.progress || {};
    const phase = { tree: "reading repo tree", content: "fetching file contents", parse: "parsing imports", ready: "finishing" }[p.phase] || "starting";
    body.innerHTML = `<div class="rel-hint muted">Building cross-reference index — ${phase}${p.total ? ` (${p.done}/${p.total})` : ""}…</div>`;
    return;
  }
  if (data.status !== "ready") {
    body.innerHTML = `<div class="rel-hint muted">${data.status === "unavailable" ? "Cross-reference index unavailable." : escapeHtml(data.error || "Failed to load.")}</div>`;
    return;
  }
  const f = S.byPath.get(S.current);
  const prImports = data.imports.filter((i) => i.target === "pr");
  const repoImports = data.imports.filter((i) => i.target !== "pr");
  const total = data.usedBy.length + prImports.length + data.tests.length + data.testedSources.length + data.formerImporters.length;
  if (count) count.textContent = total ? `· ${total}` : "";
  updateRelChip(data);

  const row = (file, { path = file?.path, sub = "", line = null, side = "RIGHT", peekable = true, badge = "" } = {}) => {
    const s = file ? statusOf(file) : "unreviewed";
    const [dir, base] = splitPath(path);
    return `<div class="rel-row" data-path="${escapeHtml(path)}" ${line != null ? `data-line="${line}" data-side="${side}"` : ""} ${file ? "" : 'data-repo="1"'} title="${escapeHtml(path)}${file ? "" : " (unchanged in this PR)"}">
      <span class="dot s-${file ? s : "unreviewed"} ${file?.stale ? "stale-ring" : ""} ${file ? "" : "hollow"}"></span>
      <span class="rel-path"><span class="dir">${escapeHtml(shortDir(dir))}</span>${escapeHtml(base)}</span>
      ${badge}
      ${file ? `<span class="pm"><span class="a">+${file.additions}</span> <span class="d">−${file.deletions}</span></span>` : `<span class="muted" style="font-size:10.5px">unchanged</span>`}
      ${peekable ? `<button class="peek-btn" data-peek="${escapeHtml(path)}" ${line != null ? `data-line="${line}" data-side="${side}"` : ""} title="Peek in a split pane (⇧-click row)">⧉</button>` : ""}
      ${sub ? `<div class="rel-sub">${sub}</div>` : ""}
    </div>`;
  };
  const names = (arr) => (arr && arr.length ? `<span class="rel-names">{ ${arr.slice(0, 5).map(escapeHtml).join(", ")}${arr.length > 5 ? ", …" : ""} }</span>` : "");
  const sec = (title, n, inner, { open = true, hint = "" } = {}) =>
    n
      ? `<details class="rel-group" ${open ? "open" : ""}><summary>${title} <span class="n">${n}</span>${hint ? `<span class="muted hint">${hint}</span>` : ""}</summary>${inner}</details>`
      : "";

  const exportsHtml = data.exports.length
    ? `<div class="rel-exports">${data.exports
        .slice(0, 24)
        .map((e) => {
          const unused = e.usedBy === 0;
          const firstUse = data.usedBy.find((u) => u.names.includes(e.kind === "default" ? "default" : e.name));
          const target = firstUse ? `data-path="${escapeHtml(firstUse.path)}" data-line="${firstUse.usages[0]?.line ?? firstUse.line}" data-side="RIGHT"` : "";
          return `<span class="sym ${unused ? "unused" : ""} ${firstUse ? "linked" : ""}" ${target} title="${e.kind}${firstUse ? ` · jump to first usage in ${escapeHtml(firstUse.path)}` : unused ? " · not imported by any file in this PR" : ""}">${e.kind === "default" ? "<i>default</i> " : e.kind === "type" || e.kind === "interface" || e.kind === "enum" ? `<i>${e.kind}</i> ` : ""}${escapeHtml(e.name)}<span class="n">×${e.usedBy}</span></span>`;
        })
        .join("")}${data.exports.length > 24 ? `<span class="muted">+${data.exports.length - 24} more</span>` : ""}</div>`
    : "";

  const usedByHtml = data.usedBy
    .map((u) =>
      row(u.file, {
        path: u.path,
        line: u.usages[0]?.line ?? u.line,
        sub: `${names(u.names)}${u.usages.length ? `<span class="rel-uses">${u.usages.slice(0, 4).map((x) => `<a data-path="${escapeHtml(u.path)}" data-line="${x.line}" data-side="RIGHT" title="${escapeHtml(x.text)}">L${x.line}</a>`).join(" ")}${u.usages.length > 4 ? " …" : ""}</span>` : `<span class="muted">import only</span>`}`,
      }),
    )
    .join("");

  const importsHtml =
    prImports.map((i) => row(i.file, { path: i.path, sub: names(i.names), badge: i.kind === "type" ? `<span class="pill tiny">type</span>` : i.kind === "dynamic" ? `<span class="pill tiny">lazy</span>` : "" })).join("") +
    (repoImports.length
      ? `<details class="rel-more"><summary>${repoImports.length} unchanged file${repoImports.length > 1 ? "s" : ""} in repo</summary>${repoImports.map((i) => row(null, { path: i.path || i.spec, sub: names(i.names), peekable: i.target === "repo" })).join("")}</details>`
      : "") +
    (data.packages.length ? `<div class="rel-pkgs muted">packages: ${data.packages.map((p) => escapeHtml(p.name)).join(", ")}</div>` : "");

  const viaBadge = (t) => `<span class="pill tiny via-${t.via}" title="${t.via === "text" ? `Shares UI strings via i18n keys: ${escapeHtml((t.keys || []).join(", "))}` : t.via === "testid" ? `Shares test ids: ${escapeHtml((t.ids || []).join(", "))}` : "File names share a distinctive word"}">${t.via === "text" ? "via text" : t.via === "testid" ? "via test id" : "by name"}${t.count > 1 ? ` ×${t.count}` : ""}</span>`;
  const testsHtml = data.tests.map((t) => row(t.file, { path: t.test, badge: viaBadge(t) })).join("");
  const coversHtml = data.testedSources.map((t) => row(t.file, { path: t.path, badge: viaBadge(t) })).join("");
  const formerHtml = data.formerImporters.map((x) => row(x)).join("");
  const siblingsHtml = data.siblings.map((x) => row(x)).join("");

  body.innerHTML =
    (exportsHtml ? `<div class="rel-group-static"><div class="rel-title">Exports <span class="muted hint">click a symbol to jump to its first usage</span></div>${exportsHtml}</div>` : "") +
    sec("Used by", data.usedBy.length, usedByHtml, { hint: "files in this PR importing this one" }) +
    (f.status === "added" && !data.usedBy.length && data.exports.length && !isTestPath(f.path) ? `<div class="rel-warn">New file with no importers in this PR — entry point, registered dynamically, or dead code?</div>` : "") +
    sec("Formerly imported by", data.formerImporters.length, formerHtml, { hint: "import removed in this PR" }) +
    sec("Imports", prImports.length + repoImports.length, importsHtml, { open: prImports.length > 0 && prImports.length <= 12 }) +
    sec("Tests", data.tests.length, testsHtml, { hint: "likely related specs" }) +
    sec("Covers", data.testedSources.length, coversHtml, { hint: "source files this spec likely exercises" }) +
    sec("Siblings", data.siblings.length, siblingsHtml, { open: false, hint: "same folder" }) +
    (!total && !data.exports.length ? `<div class="rel-hint muted">No imports or importers among the changed files.</div>` : "") +
    `<div id="gitx-slot"></div>`;
  if (S.snap.hasGit) loadGitx(f.path);

  body.querySelectorAll(".rel-row").forEach((r) =>
    r.addEventListener("click", (e) => {
      if (e.target.closest("button, a")) return;
      const line = r.dataset.line ? Number(r.dataset.line) : null;
      if (e.shiftKey) return peek(r.dataset.path, { line, side: r.dataset.side || "RIGHT" });
      if (r.dataset.repo) return peek(r.dataset.path, { line, side: "RIGHT" });
      jumpTo(r.dataset.path, { line, side: r.dataset.side || "RIGHT" });
    }),
  );
  body.querySelectorAll(".rel-uses a, .sym.linked").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.stopPropagation();
      const line = Number(a.dataset.line);
      if (e.shiftKey) return peek(a.dataset.path, { line, side: "RIGHT" });
      jumpTo(a.dataset.path, { line, side: a.dataset.side || "RIGHT" });
    }),
  );
  body.querySelectorAll(".peek-btn").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      peek(b.dataset.peek, { line: b.dataset.line ? Number(b.dataset.line) : null, side: b.dataset.side || "RIGHT" });
    }),
  );
}
function isTestPath(p) {
  return /^tests?\//.test(p) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(p);
}
function isI18nPath(p) {
  return /(^|\/)locales?\/[\w-]+\.json$/.test(p);
}
function isSourcePath(p) {
  return /\.(tsx?|jsx?|mjs|cjs)$/.test(p) && !isTestPath(p);
}
/** Which alternative (non-diff) view applies to a file, and whether it is active. */
function altView(p) {
  if (S.altSkip?.has(p)) return null;
  if (isTestPath(p)) return { kind: "outline", label: "Outline", on: S.outlineMode };
  if (isI18nPath(p)) return { kind: "keys", label: "Keys", on: S.surfaceMode };
  if (isSourcePath(p)) return { kind: "surface", label: "Surface", on: S.surfaceMode };
  return null;
}
function shortDir(dir) {
  const parts = dir.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts[0] === "src") parts.shift();
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}/` : parts.length ? `${parts.join("/")}/` : "";
}

/** Open another file to check a usage, remembering where we came from (B goes back). */
function jumpTo(path, { line = null, side = "RIGHT" } = {}) {
  if (!S.byPath.has(path)) return peek(path, { line, side });
  if (S.current && S.current !== path) {
    S.jumpStack.push({ path: S.current, scrollTop: $(".pane-body")?.scrollTop || 0 });
    if (S.jumpStack.length > 30) S.jumpStack.shift();
  }
  S.pendingScroll = line != null ? { line, side } : null;
  if (path === S.current) return applyPendingScroll();
  openFile(path);
}
function goBack() {
  const prev = S.jumpStack.pop();
  if (!prev) return toast("No jump to go back to");
  if (!S.byPath.has(prev.path)) return goBack();
  S.pendingScroll = { scrollTop: prev.scrollTop };
  openFile(prev.path);
}
function renderJumpBar() {
  const pane = $(".pane");
  if (!pane) return;
  let bar = pane.querySelector(".jump-bar");
  const prev = S.jumpStack[S.jumpStack.length - 1];
  if (!prev) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = el(`<div class="jump-bar"></div>`);
    pane.prepend(bar);
  }
  bar.innerHTML = `<button class="ghost" data-act="back">↩ Back to <span class="mono">${escapeHtml(shortPath(prev.path))}</span> <kbd>B</kbd></button><span class="muted">${S.jumpStack.length > 1 ? `${S.jumpStack.length} jumps deep` : ""}</span>`;
  bar.querySelector("[data-act=back]").addEventListener("click", goBack);
}
function applyPendingScroll() {
  const ps = S.pendingScroll;
  if (!ps) return;
  const body = $(".pane-body");
  if (!body) return;
  if (ps.test) {
    // a test card in the outline, not a code line
    const card = body.querySelector(`details.ol-test[data-test-line="${ps.line}"]`);
    if (!card) {
      if (!body.querySelector(".outline")) return; // outline still rendering; try again after it lands
      S.pendingScroll = null;
      return;
    }
    card.open = true;
    body.scrollTop = Math.max(0, card.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 48);
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 1500);
    S.pendingScroll = null;
    return;
  }
  if (ps.line != null && altView(S.current)?.on && !ps.retriedAlt) {
    // a line target needs the code view
    ps.retriedAlt = true;
    if (altView(S.current).kind === "outline") S.outlineMode = false;
    else S.surfaceMode = false;
    renderPaneHead();
    renderBody();
    return;
  }
  if (ps.scrollTop != null) {
    body.scrollTop = ps.scrollTop;
    S.pendingScroll = null;
    return;
  }
  if (ps.thread) {
    S.pendingScroll = null;
    return scrollToThread(ps.thread);
  }
  const found = scrollToLine(ps.line, ps.side, { quiet: true });
  const f = S.byPath.get(S.current);
  if (!found && !ps.retried && f && f.status !== "added" && f.status !== "removed" && !S.view.full && !S.view.inter) {
    // The usage is in unchanged context — show the whole file so we can land on it.
    ps.retried = true;
    S.view.full = true;
    renderPaneHead();
    renderBody();
    return;
  }
  if (!found) toast(`Line ${ps.line} isn't in this view`, "warn");
  S.pendingScroll = null;
}

// ---------- peek pane ----------

async function peek(path, { line = null, side = "RIGHT" } = {}) {
  const pane = $(".pane");
  if (!pane) return;
  S.peek = { path, line, side };
  let box = pane.querySelector(".peek");
  if (!box) {
    box = el(`<div class="peek"><div class="peek-head"></div><div class="peek-body"></div></div>`);
    pane.appendChild(box);
  }
  pane.classList.add("has-peek");
  const f = S.byPath.get(path);
  const [dir, base] = splitPath(path);
  box.querySelector(".peek-head").innerHTML = `<span class="muted">⧉ peek</span>
    ${f ? `<span class="pill s-${statusOf(f)} ${f.stale ? "stale" : ""}">${f.stale ? "stale" : STATUS_LABEL[statusOf(f)]}</span>` : `<span class="pill">unchanged</span>`}
    <span class="ph-path" title="${escapeHtml(path)}"><span class="dir">${escapeHtml(dir)}</span><span class="base">${escapeHtml(base)}</span></span>
    ${f ? `<span class="pm"><span class="a">+${f.additions}</span> <span class="d">−${f.deletions}</span></span>` : ""}
    ${f ? `<button data-x="open" title="Make this the current file">Open ⤴</button>` : ""}
    <button data-x="swap" title="Swap: peek the current file, open this one" ${f ? "" : "hidden"}>⇅ Swap</button>
    <button class="ghost" data-x="close" title="Close (Esc)">✕</button>`;
  box.querySelector("[data-x=open]")?.addEventListener("click", () => {
    const target = S.peek;
    closePeek();
    jumpTo(target.path, { line: target.line, side: target.side });
  });
  box.querySelector("[data-x=swap]")?.addEventListener("click", () => {
    const cur = S.current;
    const target = S.peek;
    jumpTo(target.path, { line: target.line, side: target.side });
    setTimeout(() => peek(cur), 50);
  });
  box.querySelector("[data-x=close]").addEventListener("click", closePeek);
  const body = box.querySelector(".peek-body");
  body.classList.toggle("wrap", S.view.wrap);
  body.innerHTML = `<div class="loading">Loading…</div>`;
  try {
    let hunks;
    let language;
    if (f) {
      const d = await loadDetail(path);
      hunks = d.hunks.map(cloneHunk);
      language = f.language;
      if (f.status !== "added" && f.status !== "removed" && line != null && !hunks.some((h) => h.lines.some((l) => l.newNo === line))) {
        const content = await loadContent(path);
        const r = renderDiff(hunks, { mode: "unified", language, words: false, notes: [], fullContent: content, fileStatus: f.status });
        body.innerHTML = r.html;
      } else body.innerHTML = renderDiff(hunks, { mode: "unified", language, words: S.view.words, notes: [], fileStatus: f.status }).html;
    } else {
      const res = await api(`/api/repo-file?path=${encodeURIComponent(path)}`);
      const lines = res.content.replace(/\n$/, "").split("\n");
      hunks = [{ header: "", context: "unchanged file at head", oldStart: 1, newStart: 1, lead: true, lines: lines.map((t, i) => ({ type: "ctx", text: t, oldNo: i + 1, newNo: i + 1 })) }];
      body.innerHTML = renderDiff(hunks, { mode: "unified", language: langOf(path), words: false, notes: [], fileStatus: "modified" }).html;
    }
    if (S.peek?.path !== path) return;
    if (line != null) {
      const tr = body.querySelector(`td.gl[data-side="${side}"][data-line="${line}"]`)?.closest("tr");
      if (tr) {
        body.scrollTop = Math.max(0, tr.offsetTop + tableOffset(tr, body) - body.clientHeight / 3);
        tr.classList.add("flash");
      }
    }
    body.onclick = (e) => {
      const gl = e.target.closest("td.gl");
      if (gl && f) {
        const target = S.peek;
        closePeek();
        jumpTo(target.path, { line: Number(gl.dataset.line), side: gl.dataset.side });
      }
    };
  } catch (err) {
    body.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}
function closePeek() {
  S.peek = null;
  const pane = $(".pane");
  pane?.classList.remove("has-peek");
  pane?.querySelector(".peek")?.remove();
}
function langOf(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", css: "css", scss: "scss", md: "markdown", yml: "yaml", yaml: "yaml", html: "xml" }[ext] || "plaintext";
}
const NOTE_KINDS = ["issue", "suggestion", "nitpick", "question", "praise", "thought"];
const KIND_GLYPH = { issue: "⛔", suggestion: "✎", nitpick: "nit", question: "?", praise: "👍", thought: "💭" };
S.noteKind = S.noteKind || "suggestion";
// ---------- note templates: 0–9 inserts, / searches, or just type ----------

function setKind(kind, root) {
  S.noteKind = kind;
  root?.querySelectorAll(".kind").forEach((x) => x.classList.toggle("on", x.dataset.kind === kind));
}
/** Attach the template popover to a composer textarea. Register before other keydown handlers so Esc can be claimed. */
function attachTemplates(ta, { kindRoot = null } = {}) {
  let pop = null;
  let mode = null; // "digits" | "search"
  let query = "";
  let hl = 0;
  const list = () => S.templates || [];
  const keyFor = (i) => (i + 1) % 10; // templates 1–9 on 1–9, the tenth on 0
  const filtered = () => {
    const q = query.toLowerCase();
    return list().map((t, i) => ({ ...t, i })).filter((t) => !q || t.text.toLowerCase().includes(q) || (t.kind || "").includes(q));
  };
  const close = () => {
    pop?.remove();
    pop = null;
    mode = null;
    query = "";
    hl = 0;
  };
  const render = () => {
    const items = mode === "search" ? filtered() : list().map((t, i) => ({ ...t, i })).slice(0, 10);
    if (!pop) {
      pop = el(`<div class="tpl-pop"></div>`);
      ta.after(pop);
    }
    pop.innerHTML =
      `<div class="tpl-head">${mode === "search" ? `<span class="tpl-q">/${escapeHtml(query)}</span><span class="muted">type to filter · ⏎ insert · Esc</span>` : `<span class="muted"><kbd>1</kbd>–<kbd>9</kbd>,<kbd>0</kbd> insert a template · <kbd>/</kbd> search · or just type</span>`}<span class="sp"></span><button class="ghost tb" data-x="edit" title="Edit the templates">edit…</button></div>` +
      (items.map((t, j) => `<div class="tpl-item ${mode === "search" && j === hl ? "hl" : ""}" data-i="${t.i}"><kbd>${keyFor(t.i)}</kbd>${t.kind ? `<span class="kind-badge k-${t.kind}">${t.kind}</span>` : ""}<span class="t">${escapeHtml(t.text)}</span></div>`).join("") || `<div class="muted" style="padding:4px 8px">No template matches</div>`);
    pop.querySelectorAll(".tpl-item").forEach((n) => n.addEventListener("mousedown", (e) => { e.preventDefault(); pick(Number(n.dataset.i)); }));
    pop.querySelector("[data-x=edit]").addEventListener("mousedown", (e) => { e.preventDefault(); close(); showTemplatesEditor(); });
  };
  const pick = (i) => {
    const t = list()[i];
    if (!t) return;
    const cur = ta.value;
    ta.value = cur.trim() ? cur.replace(/\s*$/, "\n") + t.text : t.text;
    if (t.kind) setKind(t.kind, kindRoot);
    close();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const open = (m) => {
    if (!list().length) return;
    mode = m;
    query = "";
    hl = 0;
    render();
  };
  ta.addEventListener("focus", () => { if (!ta.value.trim()) open("digits"); });
  ta.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== ta) close(); }, 150));
  ta.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (mode === "search") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") return close();
      if (e.key === "Enter") { const items = filtered(); if (items[hl]) pick(items[hl].i); return; }
      if (e.key === "ArrowDown") { hl = Math.min(Math.max(0, filtered().length - 1), hl + 1); return render(); }
      if (e.key === "ArrowUp") { hl = Math.max(0, hl - 1); return render(); }
      if (e.key === "Backspace") { if (!query) return close(); query = query.slice(0, -1); hl = 0; return render(); }
      if (e.key.length === 1) { query += e.key; hl = 0; render(); }
      return;
    }
    if (!ta.value.trim()) {
      if (/^[0-9]$/.test(e.key) && list().length) {
        const i = e.key === "0" ? 9 : Number(e.key) - 1;
        if (list()[i]) { e.preventDefault(); e.stopImmediatePropagation(); return pick(i); }
      }
      if (e.key === "/") { e.preventDefault(); e.stopImmediatePropagation(); return open("search"); }
    }
    if (mode && e.key === "Escape") { e.stopImmediatePropagation(); return close(); }
    if (mode === "digits" && e.key.length === 1) close(); // they're typing their own words
  });
  ta.addEventListener("input", () => { if (!ta.value.trim() && !mode && document.activeElement === ta) open("digits"); });
  return { open: () => open("digits"), close };
}
function showTemplatesEditor() {
  const lines = (S.templates || []).map((t) => `${t.kind ? `${t.kind}: ` : ""}${t.text}`).join("\n");
  let current = lines; // the dialog closes before onClick runs, so track the text as it is typed
  dialog({
    title: "Note templates",
    body: `<p class="muted">One per line, optionally prefixed with a kind — <code>issue:</code>, <code>suggestion:</code>, <code>nitpick:</code>, <code>question:</code>, <code>praise:</code>, <code>thought:</code>. The first ten get the keys <kbd>1</kbd>–<kbd>9</kbd>, <kbd>0</kbd> in any note composer; all of them are searchable with <kbd>/</kbd>. Shared across your pull requests.</p>
      <textarea id="tpl-editor" style="width:100%;min-height:260px;font-family:var(--mono);font-size:12.5px">${escapeHtml(lines)}</textarea>`,
    buttons: [
      { label: "Save", primary: true, onClick: async () => {
        const templates = current.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const m = l.match(/^(issue|suggestion|nitpick|question|praise|thought)\s*:\s*(.+)$/i); return m ? { kind: m[1].toLowerCase(), text: m[2].trim() } : { kind: null, text: l }; });
        try {
          const r = await api("/api/templates", { method: "PUT", body: { templates } });
          S.templates = r.templates;
          toast(`${r.templates.length} templates saved`, "ok");
        } catch (err) {
          toast(`Could not save templates: ${err.message}`, "err");
        }
      } },
      { label: "Reset to defaults", onClick: async () => { try { const r = await api("/api/templates", { method: "DELETE" }); S.templates = r.templates; toast("Templates reset", "ok"); } catch (err) { toast(err.message, "err"); } } },
      { label: "Cancel" },
    ],
  });
  const ta = document.getElementById("tpl-editor");
  ta?.addEventListener("input", () => (current = ta.value));
  ta?.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") $("#overlay .d-foot .primary")?.click(); e.stopPropagation(); });
  ta?.focus();
}

// ---------- backups & recovery ----------

async function showBackupsDialog() {
  let d;
  try {
    d = await api("/api/backups");
  } catch (err) {
    return toast(err.message, "err");
  }
  const rows = d.backups.map((b) => `<tr><td class="mono" title="${escapeHtml(b.name)}">${escapeHtml(new Date(b.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }))} <span class="muted">· ${escapeHtml(ago(b.at))}</span></td><td style="text-align:right">${b.records}</td><td style="text-align:right">${b.notes}</td><td style="text-align:right">${b.events}</td><td class="mono muted">${b.headSha ? b.headSha.slice(0, 7) : ""}</td><td><button class="tb" data-restore="${escapeHtml(b.name)}" title="Merge this backup into the current state (adds what's missing; never removes anything)">restore</button></td></tr>`).join("");
  dialog({
    title: "Backups of this review's state",
    body: `<p class="muted">Now: <b>${d.now.records}</b> files with a status or notes · <b>${d.now.notes}</b> notes · ${d.now.events} events. Sift keeps a backup after changes (every backup from the last 24 h, then one a day for 60 days) and one whenever the record count drops. Restoring <b>merges</b> — nothing currently in your state is removed. CLI: <code>sift &lt;pr&gt; --backups</code> · <code>--restore latest</code>.</p>
      ${rows ? `<table class="bk-table"><thead><tr><th>Taken</th><th style="text-align:right">Records</th><th style="text-align:right">Notes</th><th style="text-align:right">Events</th><th>Head</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p>No backups yet — the first one is written after your next status change.</p>`}`,
    buttons: [{ label: "Close" }],
  });
  $("#overlay").querySelectorAll("[data-restore]").forEach((b) =>
    b.addEventListener("click", async () => {
      closeOverlay();
      await restoreBackup(b.dataset.restore);
    }),
  );
}
async function restoreBackup(name) {
  try {
    const r = await api("/api/backups/restore", { method: "POST", body: { name } });
    applySnapshot(r.snapshot);
    render();
    toast(`Backup merged · ${r.added} records added, ${r.updated} updated, ${r.notesAdded} notes added`, "ok");
  } catch (err) {
    toast(`Restore failed: ${err.message}`, "err");
  }
}
/** Start over on this PR: backup first, typed confirmation, optional note retention. */
function showResetDialog() {
  const st = S.snap.stats;
  const notes = st.notes;
  const published = S.snap.files.reduce((n, f) => n + (f.review?.notes || []).filter((x) => x.publishedAt).length, 0);
  const n = S.snap.ref.number;
  let keep = notes > 0;
  let typed = "";
  dialog({
    title: `↺ Start a fresh review of #${n}`,
    body: `<p>This clears your <b>${st.done}</b> covered file${st.done === 1 ? "" : "s"} (${st.byStatus.reviewed} reviewed · ${st.byStatus.skimmed} skimmed · ${st.byStatus.flagged} flagged · ${st.byStatus.deferred} deferred), hunk coverage, dismissed findings, pace and sittings for this PR. A backup is taken first — <b>Backups…</b> in the palette can bring it all back.</p>
      ${notes ? `<p><label><input type="radio" name="rs-notes" value="keep" checked /> Keep my <b>${notes}</b> note${notes === 1 ? "" : "s"} as drafts on unreviewed files</label><br/><label><input type="radio" name="rs-notes" value="drop" /> Delete them too${published ? ` <span class="muted">(${published} already published stay on GitHub)</span>` : ""}</label></p>` : ""}
      <p>Type the PR number <code>${n}</code> to confirm: <input type="text" id="rs-confirm" style="width:110px" autocomplete="off" /></p>`,
    buttons: [
      { label: "Start fresh", primary: true, onClick: async () => {
        if (String(typed).trim() !== String(n)) return toast("Not reset — the PR number didn't match", "warn");
        try {
          const r = await api("/api/reset", { method: "POST", body: { keepNotes: keep, confirm: typed.trim() } });
          S.seenLocal.clear();
          S.lastAction = null;
          S.tour.idx = -1;
          S.tour.list = null;
          S.detailCache.clear();
          applySnapshot(r.snapshot);
          S.current = null;
          savePrefs();
          navigate("map");
          toast(`Fresh start · ${r.before.records} records cleared${r.keptNotes ? ` · ${r.keptNotes} notes kept` : ""}`, "ok", r.backup ? `Backup ${r.backup} keeps the old review.` : "");
        } catch (err) {
          toast(`Reset failed: ${err.message}`, "err");
        }
      } },
      { label: "Cancel" },
    ],
  });
  const ov = $("#overlay");
  ov.querySelectorAll("input[name=rs-notes]").forEach((r) => r.addEventListener("change", () => (keep = r.value === "keep")));
  const inp = ov.querySelector("#rs-confirm");
  inp.addEventListener("input", () => (typed = inp.value));
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") ov.querySelector(".d-foot .primary")?.click(); });
  inp.focus();
}
/** Banners above the lens: review state looks wiped (one-click restore) · another Sift has this PR open. */
function renderNotices() {
  let bar = $("#notices");
  if (!bar) {
    bar = el(`<div id="notices"></div>`);
    $("#filterbar").before(bar);
  }
  const parts = [];
  const rec = S.snap?.recovery;
  if (rec) parts.push(`<div class="notice warn"><b>Your review state looks wiped.</b> It has ${rec.now.records} file${rec.now.records === 1 ? "" : "s"} with a status or notes, but the backup from ${escapeHtml(ago(rec.at))} has <b>${rec.records}</b> (${rec.notes} notes). <button class="primary" data-x="restore" data-name="${escapeHtml(rec.backup)}">Restore it</button> <button class="ghost" data-act="backups">All backups…</button> <button class="ghost" data-x="later">This is expected</button></div>`);
  const other = S.snap?.otherInstance;
  if (other) parts.push(`<div class="notice"><b>Another Sift has this PR open</b> (pid ${other.pid}${other.port ? `, port ${other.port}` : ""}, started ${escapeHtml(ago(other.startedAt))}). Changes from both are merged on every save, but use one at a time to avoid confusion.</div>`);
  bar.innerHTML = parts.join("");
  bar.hidden = !parts.length;
  bar.querySelector("[data-x=restore]")?.addEventListener("click", (e) => restoreBackup(e.currentTarget.dataset.name));
  bar.querySelector("[data-x=later]")?.addEventListener("click", async () => { S.snap.recovery = null; renderNotices(); api("/api/backups/dismiss-warning", { method: "POST" }).catch(() => {}); });
  bar.querySelectorAll("[data-act]").forEach((n) => n.addEventListener("click", () => runAction(n.dataset.act)));
}

function kindPicker(id) {
  return `<span class="kinds" id="${id}">${NOTE_KINDS.map((k) => `<button type="button" class="kind k-${k} ${S.noteKind === k ? "on" : ""}" data-kind="${k}" title="${k}">${KIND_GLYPH[k]}</button>`).join("")}</span>`;
}
function wireKindPicker(root) {
  root?.querySelectorAll(".kind").forEach((b) =>
    b.addEventListener("click", () => {
      S.noteKind = b.dataset.kind;
      root.querySelectorAll(".kind").forEach((x) => x.classList.toggle("on", x === b));
    }),
  );
}
function kindBadge(n) {
  return n.kind ? `<span class="kind-badge k-${n.kind}" title="${n.kind}">${n.kind}</span>` : "";
}
function changedSince(n, f) {
  return Boolean(n.sha && f && n.sha !== f.sha && n.line != null);
}
function noteHtml(text) {
  return escapeHtml(text).replace(/```suggestion\n([\s\S]*?)```/g, '<div class="sugg"><div class="sugg-h">suggested change</div><pre>$1</pre></div>').replace(/```(\w*)\n([\s\S]*?)```/g, "<pre>$2</pre>");
}
function publishedBadge(n, cls = "") {
  if (!n.publishedAt) return "";
  const title = `Published to GitHub ${ago(n.publishedAt)}${n.remote?.id ? " · edits and deletes follow it there" : n.remote?.kind === "body" ? " · in the review summary" : ""}`;
  return n.remote?.url ? `<a class="${cls}" href="${n.remote.url}" target="_blank" rel="noopener" title="${title} · open on GitHub" style="color:var(--reviewed)">↑ published ↗</a>` : `<span class="${cls}" title="${title}" style="color:var(--reviewed)">↑ published</span>`;
}
function noteCard(n) {
  const f = S.byPath.get(S.current);
  return `<div class="note-card">${n.line != null ? `<span class="anchor" data-goto="${n.line}" data-side="${n.side || "RIGHT"}">L${n.line}${n.endLine && n.endLine !== n.line ? `–${n.endLine}` : ""}${n.side === "LEFT" ? " (old)" : ""}</span>` : `<span class="anchor muted">file</span>`} ${kindBadge(n)}${changedSince(n, f) ? `<span class="pill tiny" style="color:var(--flagged)" title="The file changed after you wrote this — check whether it was addressed (I shows changes since your review)">file changed since</span>` : ""}<div class="txt">${noteHtml(n.text)}</div><div class="meta"><span>${ago(n.at)}</span>${publishedBadge(n)}<span class="sp"></span><button data-edit="${n.id}">edit</button><button data-del="${n.id}">delete</button></div></div>`;
}
function scrollToLine(line, side, { quiet = false } = {}) {
  const td = $(`.pane-body td.gl[data-side="${side}"][data-line="${line}"]`);
  const tr = td?.closest("tr");
  if (!tr) {
    if (!quiet) toast("Line not visible in this view", "warn");
    return false;
  }
  const body = $(".pane-body");
  body.scrollTop = Math.max(0, tr.offsetTop + tableOffset(tr, body) - body.clientHeight / 3);
  tr.classList.add("flash");
  setTimeout(() => tr.classList.remove("flash"), 1500);
  return true;
}

// ============================================================================
// actions
// ============================================================================

function openFile(path) {
  if (!S.byPath.has(path)) return;
  navigate("deck", path);
}
function advance() {
  const n = nextPending(S.current);
  if (!n) {
    const deferred = queue().filter((f) => statusOf(f) === "deferred");
    if (deferred.length && S.filter.status !== "deferred") {
      dialog({
        title: "Nothing pending in this queue",
        body: `<p>All files in the current filter are covered — but <b>${deferred.length}</b> ${deferred.length === 1 ? "file is" : "files are"} <span style="color:var(--deferred)">deferred</span>. Deferred work is not done work.</p>`,
        buttons: [{ label: `Review the ${deferred.length} deferred`, primary: true, onClick: () => { S.filter.status = "deferred"; S.queueCache = null; savePrefs(); const first = queue()[0]; if (first) openFile(first.path); else render(); } }, { label: "Later" }],
      });
    } else toast("Queue clear for this filter 🎉", "ok", "Switch filters or open the Map.");
    renderDeck($("#lens"));
    return;
  }
  openFile(n.path);
}

async function setStatus(path, status, { advanceAfter = true } = {}) {
  const f = S.byPath.get(path);
  if (!f) return;
  const from = statusOf(f);
  S.lastAction = { items: [{ path, review: f.review ? { status: f.review.status, at: f.review.at, sha: f.review.sha, headSha: f.review.headSha, fileStatus: f.review.fileStatus } : null }], label: `${shortPath(path)} back to ${STATUS_LABEL[from]}` };
  try {
    const { file, stats } = await api("/api/status", { method: "POST", body: { path, status } });
    updateFile(file, stats);
    if (S.view.inter && !file.stale && path === S.current) {
      S.view.inter = false;
      renderBody();
    }
    const verb = status === "unreviewed" ? "Cleared" : STATUS_LABEL[status];
    const cov = status === "reviewed" ? coverageOf(path) : null;
    const partial = cov && cov.unseen > 0 && cov.seen > 0;
    toast(`${verb} · ${shortPath(path)}`, status === "flagged" ? "warn" : status === "unreviewed" ? "" : cov && cov.unseen ? "warn" : "ok", cov && cov.unseen ? `${cov.unseen} of ${cov.total} hunks ${partial ? "were never" : "haven't been"} on screen · Z to undo` : "Z to undo");
    if (S.lens === "deck") {
      if (status === "flagged") {
        refreshDeckChrome();
        if (!S.side) runAction("side");
        setTimeout(() => $("#file-note")?.focus(), 0);
      } else if (advanceAfter && S.autoAdvance && status !== "unreviewed" && path === S.current) advance();
      else refreshDeckChrome();
    } else render();
  } catch (err) {
    toast(`Failed: ${err.message}`, "err");
  }
}
/** Everything in the deck except the diff body (which keeps its scroll position). */
function refreshDeckChrome() {
  renderHeader();
  renderFilterBar();
  renderRail();
  if (S.current && S.byPath.has(S.current)) {
    renderPaneHead();
    renderBanner();
    renderSide();
  }
}
async function bulkStatus(paths, status) {
  if (!paths.length) return;
  S.lastAction = { items: paths.map((p) => { const f = S.byPath.get(p); return { path: p, review: f?.review ? { status: f.review.status, at: f.review.at, sha: f.review.sha, headSha: f.review.headSha, fileStatus: f.review.fileStatus } : null }; }), label: `${paths.length} files restored` };
  try {
    const { files, stats } = await api("/api/bulk", { method: "POST", body: { paths, status } });
    files.forEach((f) => updateFile(f));
    S.snap.stats = stats;
    S.selection.clear();
    toast(`${files.length} files → ${status === "unreviewed" ? "cleared" : STATUS_LABEL[status]}`, "ok", "Z to undo");
    render();
  } catch (err) {
    toast(`Failed: ${err.message}`, "err");
  }
}
async function undo() {
  if (!S.lastAction) return toast("Nothing to undo");
  const { items, label } = S.lastAction;
  S.lastAction = null;
  try {
    // Restores the exact previous records (status, reviewed SHA, timestamps), so staleness is not erased.
    const { files, stats } = await api("/api/review/restore", { method: "POST", body: { items } });
    files.forEach((f) => updateFile(f));
    S.snap.stats = stats;
    toast(`Undone · ${label}`);
    if (S.lens === "deck" && items.length === 1 && items[0].path !== S.current) openFile(items[0].path);
    else render();
  } catch (err) {
    S.lastAction = { items, label };
    toast(`Undo failed: ${err.message}`, "err", "Press Z to try again");
  }
}
async function addNote({ text, line = null, endLine = null, side = null, kind = null }) {
  const path = S.current;
  try {
    const { file, stats } = await api("/api/note", { method: "POST", body: { path, text, line, endLine, side, kind } });
    updateFile(file, stats);
    toast("Note saved", "ok");
    refreshDeckChrome();
    if (line != null) renderBody();
    return true;
  } catch (err) {
    toast(`Note NOT saved: ${err.message}`, "err", "Your text is still in the box.");
    return false;
  }
}
async function editNote(id, path = S.current) {
  const f = S.byPath.get(path);
  const n = (f?.review?.notes || []).find((x) => x.id === id);
  if (!n) return;
  const text = await promptDialog(n.publishedAt ? `Edit note <span class="muted" style="font-weight:400">· published${n.remote?.id || n.remote?.kind === "body" ? ", GitHub will be updated too" : ""}</span>` : "Edit note", n.text);
  if (text == null || text.trim() === n.text) return;
  if (!text.trim()) return deleteNote(id, path);
  try {
    const { file, remote } = await api("/api/note", { method: "PUT", body: { path, id, text } });
    updateFile(file);
    if (remote === "updated") toast("Note updated here and on GitHub", "ok");
    else if (typeof remote === "string" && remote.startsWith("failed")) toast("Saved locally, but GitHub update failed", "err", remote.replace(/^failed:\s*/, ""));
    else if (remote === "unlinked") toast("Saved locally", "", "This note was published before Sift tracked comment ids — edit it on GitHub too.");
  } catch (err) {
    return toast(`Edit failed: ${err.message}`, "err");
  }
  if (S.lens === "notes") return renderNotes($("#lens"));
  if (S.lens === "deck" && path === S.current) {
    renderSide();
    renderBody();
  }
}
async function deleteNote(id, path = S.current) {
  const f = S.byPath.get(path);
  const n = (f?.review?.notes || []).find((x) => x.id === id);
  let remote = false;
  if (n?.publishedAt) {
    const linked = Boolean(n.remote?.id || n.remote?.kind === "body");
    const choice = await new Promise((resolve) =>
      dialog({
        title: "This note is published on GitHub",
        body: linked ? `<p>Delete it on GitHub as well, or only forget it here?</p>` : `<p>It was published before Sift tracked comment ids, so it can only be removed here — delete it on GitHub yourself.</p>`,
        buttons: linked ? [{ label: "Delete here and on GitHub", primary: true, onClick: () => resolve("both") }, { label: "Only here", onClick: () => resolve("local") }, { label: "Cancel", onClick: () => resolve(null) }] : [{ label: "Delete here", primary: true, onClick: () => resolve("local") }, { label: "Cancel", onClick: () => resolve(null) }],
        onDismiss: () => resolve(null),
      }),
    );
    if (!choice) return;
    remote = choice === "both";
  }
  try {
    const { file, stats, remote: r } = await api("/api/note", { method: "DELETE", body: { path, id, remote } });
    updateFile(file, stats);
    if (r === "deleted") toast("Deleted here and on GitHub", "ok");
    else if (typeof r === "string" && r.startsWith("failed")) toast("Deleted locally, but GitHub delete failed", "err", r.replace(/^failed:\s*/, ""));
    else toast("Note deleted");
  } catch (err) {
    return toast(`Delete failed: ${err.message}`, "err");
  }
  if (S.lens === "notes") {
    renderHeader();
    return renderNotes($("#lens"));
  }
  if (S.lens === "deck" && path === S.current) {
    refreshDeckChrome();
    renderBody();
  }
}

function flushTime() {
  if (S.seenPending && document.visibilityState !== "hidden") flushSeen();
  if (!S.current || !S.openedAt) return;
  const ms = Date.now() - S.openedAt;
  const path = S.current;
  S.openedAt = Date.now();
  if (ms < 2000) return;
  const f = S.byPath.get(path);
  if (f) {
    f.review = f.review || { status: "unreviewed", notes: [], noteCount: 0, timeMs: 0 };
    f.review.timeMs = (f.review.timeMs || 0) + ms;
  }
  const payload = JSON.stringify({ path, ms });
  if (document.visibilityState === "hidden" && navigator.sendBeacon) navigator.sendBeacon(withPr("/api/time"), new Blob([payload], { type: "application/json" }));
  else api("/api/time", { method: "POST", body: { path, ms } }).catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushTime();
  else if (S.lens === "deck") S.openedAt = Date.now();
});
window.addEventListener("pagehide", flushTime);

async function sync() {
  if (S.syncing) return;
  S.syncing = true;
  renderHeader();
  toast("Syncing with GitHub…");
  try {
    const { summary, snapshot } = await api("/api/sync", { method: "POST" });
    S.lastSync = summary;
    S.interCache.clear();
    applySnapshot(snapshot);
    S.syncing = false;
    if (summary.prevHeadSha !== summary.headSha) {
      // evidence overlays are per head: drop and reload them
      S.moveLines.clear();
      S.lintByPath = new Map();
      S.lint = null;
      S.moves = null;
      S.threads = null;
      S.threadsByPath = new Map();
      S.gitx.clear();
      S.ciFileCache.clear();
      S.outlineCache.clear();
      S.surfaceCache.clear();
      S.keysCache.clear();
      if (S.stories) S.stories._members = null;
      loadStories();
      loadThreads();
      loadMoves();
      loadLint();
      loadCi();
    }
    render();
    showSyncSummary(summary);
  } catch (err) {
    S.syncing = false;
    renderHeader();
    toast(`Sync failed: ${err.message}`, "err");
  }
}
function showSyncSummary(s) {
  const moved = s.prevHeadSha && s.prevHeadSha !== s.headSha;
  const list = (arr, max = 12) => (arr.length ? `<ul>${arr.slice(0, max).map((p) => `<li><a href="#/deck/${encodeURIComponent(p)}" class="mono" data-open="${escapeHtml(p)}">${escapeHtml(p)}</a></li>`).join("")}${arr.length > max ? `<li class="muted">…and ${arr.length - max} more</li>` : ""}</ul>` : "");
  const body = moved
    ? `<p>Head moved <span class="mono">${s.prevHeadSha.slice(0, 7)}</span> → <span class="mono">${s.headSha.slice(0, 7)}</span>.</p>
      ${s.newCommits.length ? `<h4>${s.newCommits.length} new commit${s.newCommits.length > 1 ? "s" : ""}</h4><ul>${s.newCommits.map((c) => `<li><span class="mono muted">${c.sha.slice(0, 7)}</span> ${escapeHtml(c.message)}</li>`).join("")}</ul>` : ""}
      ${s.staleNow.length ? `<h4 style="color:var(--stale)">${s.staleNow.length} file${s.staleNow.length > 1 ? "s" : ""} you had reviewed changed → stale</h4>${list(s.staleNow)}` : ""}
      ${s.changed.length ? `<h4>${s.changed.length} changed file${s.changed.length > 1 ? "s" : ""} total</h4>${list(s.changed.filter((p) => !s.staleNow.includes(p)), 8)}` : ""}
      ${s.added.length ? `<h4>${s.added.length} new file${s.added.length > 1 ? "s" : ""}</h4>${list(s.added, 8)}` : ""}
      ${s.removed.length ? `<h4>${s.removed.length} file${s.removed.length > 1 ? "s" : ""} no longer in PR</h4>${list(s.removed, 8)}` : ""}`
    : `<p>No new commits. Head is still <span class="mono">${s.headSha.slice(0, 7)}</span>.</p>`;
  dialog({
    title: moved ? "↻ PR updated" : "↻ Up to date",
    body,
    buttons: [
      ...(s.staleNow.length ? [{ label: `Re-review ${s.staleNow.length} stale`, primary: true, onClick: () => runAction("review-stale") }] : []),
      { label: "Close" },
    ],
  });
  $("#overlay").querySelectorAll("[data-open]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      closeOverlay();
      openFile(a.dataset.open);
    }),
  );
}

async function publishFlow() {
  let preview;
  try {
    preview = await api("/api/publish/preview");
  } catch (err) {
    return toast(err.message, "err");
  }
  const total = preview.counts.inline + preview.counts.fileLevel;
  if (!total) return toast("No unpublished notes to publish", "warn");
  const warnings = [];
  if (preview.counts.demoted) warnings.push(`${preview.counts.demoted} line note${preview.counts.demoted > 1 ? "s sit" : " sits"} outside the diff hunks (GitHub can't comment there) — ${preview.counts.demoted > 1 ? "they" : "it"} will be posted as file-level text.`);
  if (preview.counts.changed) warnings.push(`${preview.counts.changed} note${preview.counts.changed > 1 ? "s anchor" : " anchors"} to a file that changed after you wrote ${preview.counts.changed > 1 ? "them" : "it"} — the line number${preview.counts.changed > 1 ? "s" : ""} may be off. <label><input type="checkbox" id="pub-skip-changed" /> skip ${preview.counts.changed > 1 ? "those" : "it"} for now</label>`);
  dialog({
    title: "↑ Publish notes as a pending GitHub review",
    body: `<p><b>${preview.counts.inline}</b> inline comment${preview.counts.inline === 1 ? "" : "s"} and <b>${preview.counts.fileLevel}</b> file-level section${preview.counts.fileLevel === 1 ? "" : "s"} will be posted. Note kinds become Conventional Comments prefixes (<code>**issue:**</code>, <code>**nitpick:**</code> …).</p>
      <div class="pub-opts">
        <label><input type="radio" name="pub-ev" value="PENDING" checked /> <b>Pending draft</b> — nothing visible until you submit on github.com</label>
        <label><input type="radio" name="pub-ev" value="COMMENT" /> Comment — submit now without a verdict</label>
        <label><input type="radio" name="pub-ev" value="APPROVE" /> Approve — submit now</label>
        <label><input type="radio" name="pub-ev" value="REQUEST_CHANGES" /> Request changes — submit now</label>
      </div>
      <textarea id="pub-summary" placeholder="Optional review summary (goes at the top of the review body)…" style="width:100%;min-height:70px;margin-top:8px"></textarea>
      ${warnings.length ? `<div class="rel-warn">${warnings.join("<br/>")}</div>` : ""}
      <p class="muted">GitHub allows one pending review per user per PR — if you already have one, finish or discard it first.</p>
      ${preview.comments.length ? `<h4>Inline comments</h4><ul>${preview.comments.slice(0, 10).map((c) => `<li><span class="mono">${escapeHtml(c.path)}:${c.line}</span> — ${escapeHtml(c.body.slice(0, 90))}${c.body.length > 90 ? "…" : ""}</li>`).join("")}${preview.comments.length > 10 ? `<li class="muted">…and ${preview.comments.length - 10} more</li>` : ""}</ul>` : ""}`,
    buttons: [
      {
        label: "Publish",
        primary: true,
        onClick: async () => {
          try {
            const res = await api("/api/publish", { method: "POST", body: { event: publishFlow.event || "PENDING", summary: publishFlow.summary || "", skipChanged: Boolean(publishFlow.skipChanged) } });
            toast(`${publishFlow.event && publishFlow.event !== "PENDING" ? "Review submitted" : "Pending review created"} (${res.counts.inline} inline${res.counts.inline && res.counts.linked < res.counts.inline ? `, ${res.counts.linked} tracked` : ""})`, "ok", publishFlow.event && publishFlow.event !== "PENDING" ? "Edits and deletes of these notes now follow them to GitHub." : "Open the PR on GitHub to finish it. Edits here follow the comments there.");
            window.open(res.url || S.snap.pr.url, "_blank");
            const snap = await api("/api/snapshot");
            applySnapshot(snap);
            render();
          } catch (err) {
            toast(`Publish failed: ${err.message}`, "err");
          }
        },
      },
      { label: "Cancel" },
    ],
  });
  publishFlow.event = "PENDING";
  publishFlow.summary = "";
  publishFlow.skipChanged = false;
  $("#pub-skip-changed")?.addEventListener("change", (e) => (publishFlow.skipChanged = e.target.checked));
  const evLabel = { PENDING: "Create pending review", COMMENT: "Submit comment", APPROVE: "Approve now", REQUEST_CHANGES: "Request changes now" };
  const primaryBtn = $("#overlay .d-foot .primary");
  $("#overlay").querySelectorAll("input[name=pub-ev]").forEach((r) => r.addEventListener("change", () => { publishFlow.event = r.value; if (primaryBtn) primaryBtn.textContent = evLabel[r.value] || "Publish"; }));
  if (primaryBtn) primaryBtn.textContent = evLabel.PENDING;
  $("#pub-summary")?.addEventListener("input", (e) => (publishFlow.summary = e.target.value));
}

function runAction(act) {
  if (!act) return;
  if (act.startsWith("status:")) {
    const status = act.slice(7);
    if (S.lens === "ledger") {
      const targets = S.selection.size ? [...S.selection] : S.ledgerHl ? [S.ledgerHl] : [];
      return bulkStatus(targets, status);
    }
    if (S.lens === "deck" && S.current) return setStatus(S.current, status);
    return;
  }
  if (act.startsWith("view:")) {
    const k = act.slice(5);
    if (k === "unified" || k === "split") S.view.mode = k;
    else if (k === "mode") S.view.mode = S.view.mode === "unified" ? "split" : "unified";
    else if (k === "inter") {
      S.view.inter = !S.view.inter;
      if (S.view.inter) S.view.full = false;
    } else if (k === "fold") S.foldMoved = !S.foldMoved;
    else if (k === "full") {
      const f = S.byPath.get(S.current);
      if (f && (f.status === "added" || f.status === "removed")) return toast("Added/removed files already show the whole file");
      S.view.full = !S.view.full;
      if (S.view.full) S.view.inter = false;
    } else S.view[k] = !S.view[k];
    savePrefs();
    if (S.lens === "deck" && S.detail) {
      renderPaneHead();
      renderBanner();
      renderBody();
    }
    return;
  }
  if (act.startsWith("outline:")) {
    const av = S.current ? altView(S.current) : null;
    if (!av) return;
    const flag = av.kind === "outline" ? "outlineMode" : "surfaceMode";
    const on = act === "outline:on" ? true : act === "outline:off" ? false : !S[flag];
    if (on === S[flag]) return;
    S[flag] = on;
    savePrefs();
    if (S.lens === "deck" && S.detail) {
      renderPaneHead();
      renderBody();
    }
    return;
  }
  switch (act) {
    case "ci": return showCiDialog();
    case "prs": return showPrPicker();
    case "tour": return tourStep(1);
    case "tour-list": return showTourDialog();
    case "brief": return showBriefDialog();
    case "templates": return showTemplatesEditor();
    case "backups": return showBackupsDialog();
    case "reset": return showResetDialog();
    case "notes": return navigate("notes");
    case "search": return setTimeout(() => openPalette("/"), 0);
    case "stories": S.order = "story"; S.storiesOpen = true; S.queueCache = null; savePrefs(); return navigate("map");
    case "threads": return showThreadsDialog();
    case "lint": return showLintDialog();
    case "lint-side": if (!S.side) runAction("side"); return setTimeout(() => $(".lint-sec")?.scrollIntoView({ block: "start" }), 0);
    case "threads-side": if (!S.side) runAction("side"); return setTimeout(() => $(".th-sec")?.scrollIntoView({ block: "start" }), 0);
    case "undo": return undo();
    case "nextpending": return advance();
    case "note": return $("#file-note")?.focus();
    case "rail": S.rail = !S.rail; savePrefs(); return S.lens === "deck" && renderDeck($("#lens"));
    case "side": S.side = !S.side; savePrefs(); return S.lens === "deck" && renderDeck($("#lens"));
    case "help": return showHelp();
    case "palette": return openPalette();
    case "sync": return sync();
    case "export": return window.open(withPr("/api/export.md"), "_blank");
    case "publish": return publishFlow();
    case "copy-path": navigator.clipboard?.writeText(S.current); return toast("Path copied");
    case "github": return S.current && githubFileUrl(S.current).then((u) => window.open(u, "_blank"));
    case "resume": { const n = nextPending(S.current) || nextPending(null); return n ? openFile(n.path) : navigate("deck"); }
    case "review-stale": S.filter.status = "stale"; S.order = "stale"; S.queueCache = null; savePrefs(); { const n = queue()[0]; return n ? openFile(n.path) : render(); }
    case "select": if (S.ledgerHl) { S.selection.has(S.ledgerHl) ? S.selection.delete(S.ledgerHl) : S.selection.add(S.ledgerHl); renderLedger($("#lens")); } return;
    case "selectall": { const q = queue(); const all = q.every((f) => S.selection.has(f.path)); S.selection.clear(); if (!all) q.forEach((f) => S.selection.add(f.path)); renderLedger($("#lens")); return; }
    case "open": return S.ledgerHl && openFile(S.ledgerHl);
    case "theme": S.theme = S.theme === "dark" ? "light" : "dark"; applyTheme(); savePrefs(); return;
    default: return;
  }
}
function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  $("#hljs-dark").disabled = S.theme !== "dark";
  $("#hljs-light").disabled = S.theme !== "light";
}
/** GitHub anchors a file in the Files tab by the SHA-256 of its path. */
async function githubFileUrl(path) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${S.snap.pr.url}/files#diff-${hex}`;
  } catch {
    return `${S.snap.pr.url}/files`;
  }
}

// ============================================================================
// hunk navigation
// ============================================================================

function hunkNav(dir) {
  const body = $(".pane-body");
  if (!body) return;
  const heads = [...body.querySelectorAll("tr.hunk:not(.lead)")];
  if (!heads.length) {
    body.scrollTop += dir * body.clientHeight * 0.8;
    return;
  }
  let idx = S.hunkIdx;
  if (idx < 0) {
    // Start from whatever hunk is nearest the top of the viewport.
    const top = body.getBoundingClientRect().top;
    idx = heads.findIndex((h) => h.getBoundingClientRect().top > top + 4);
    if (idx < 0) idx = heads.length;
    idx = dir > 0 ? idx - 1 : idx;
  }
  idx = Math.max(0, Math.min(heads.length - 1, idx + dir));
  S.hunkIdx = idx;
  heads.forEach((h, i) => h.classList.toggle("cur", i === idx));
  const target = heads[idx];
  body.scrollTop = Math.max(0, target.offsetTop + tableOffset(target, body) - 8);
}
function tableOffset(row, scroller) {
  // tr.offsetTop is relative to its table; add the table's own offset inside the scroller.
  const table = row.closest("table");
  return table ? table.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop : 0;
}

// ============================================================================
// palette, help, dialogs, toasts
// ============================================================================

const COMMANDS = [
  ["Switch pull request…", "prs"],
  ["Attention tour: next signal (⇧J)", "tour"],
  ["Attention list: findings, threads, failing tests, stale (⇧L)", "tour-list"],
  ["All my notes", "notes"],
  ["Edit note templates (0–9 in the composer)…", "templates"],
  ["Backups of this review's state…", "backups"],
  ["Start a fresh review of this PR (reset)…", "reset"],
  ["Search the PR diff (⌘⇧F, or / in this palette)", "search"],
  ["Sync with GitHub", "sync"],
  ["Playwright results (CI)", "ci"],
  ["Stories: review by sub-PR", "stories"],
  ["Review threads & bot reviews", "threads"],
  ["Findings by rule (reviewer lint)", "lint"],
  ["Toggle test outline / code", "outline:toggle"],
  ["Jump to next pending file", "nextpending"],
  ["Re-review stale files", "review-stale"],
  ["Export notes as Markdown", "export"],
  ["Publish notes as pending GitHub review", "publish"],
  ["Toggle split / unified", "view:mode"],
  ["Toggle full file", "view:full"],
  ["Toggle wrap", "view:wrap"],
  ["Toggle word highlights", "view:words"],
  ["Toggle rail", "rail"],
  ["Toggle notes panel", "side"],
  ["Toggle light / dark theme", "theme"],
  ["Undo last status change", "undo"],
  ["Help", "help"],
];

function openPalette(prefill = "") {
  const ov = $("#overlay");
  ov.hidden = false;
  ov.innerHTML = `<div class="dialog palette"><input type="text" placeholder="Jump to a file…  ·  > commands  ·  / search the PR diff" autofocus /><div class="items"></div></div>`;
  const input = ov.querySelector("input");
  const items = ov.querySelector(".items");
  let results = [];
  let sel = 0;
  const run = () => {
    const q = input.value.trim();
    if (q.startsWith(">")) {
      const qq = q.slice(1).trim().toLowerCase();
      results = COMMANDS.filter(([l]) => l.toLowerCase().includes(qq)).map(([l, a]) => ({ cmd: true, label: l, act: a }));
    } else if (q.startsWith("/")) {
      const qq = q.slice(1).trim();
      results = [];
      if (qq.length >= 2) {
        clearTimeout(openPalette.searchTimer);
        openPalette.searchTimer = setTimeout(async () => {
          try {
            const d = await api(`/api/search?q=${encodeURIComponent(qq)}&mode=changed`);
            if (input.value.trim() !== q) return;
            results = d.results.flatMap((r) => r.hits.slice(0, 6).map((hit) => ({ hit: true, file: S.byPath.get(r.path), path: r.path, line: hit.line, side: hit.side, kind: hit.kind, text: hit.text, more: r.count > 6 ? r.count - 6 : 0 })));
            results.unshift({ info: true, label: `${d.total} match${d.total === 1 ? "" : "es"} in ${d.files} file${d.files === 1 ? "" : "s"} (changed lines) — ⏎ jumps to the line` });
            sel = 1;
            draw();
          } catch (err) {
            results = [{ info: true, label: err.message }];
            draw();
          }
        }, 180);
      } else results = [{ info: true, label: "Type at least 2 characters to search the PR diff (added and removed lines)" }];
    } else if (!q) {
      results = [
        ...COMMANDS.slice(0, 4).map(([l, a]) => ({ cmd: true, label: l, act: a })),
        ...queue().filter(isPending).slice(0, 12).map((f) => ({ file: f, score: 0, hl: escapeHtml(f.path) })),
      ];
    } else {
      results = S.snap.files
        .map((f) => ({ file: f, ...fuzzy(q, f.path) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 40);
    }
    sel = 0;
    draw();
  };
  const draw = () => {
    let lastSec = null;
    items.innerHTML = results
      .map((r, i) => {
        const sec = r.cmd ? "Commands" : r.hit || r.info ? "Search in PR" : "Files";
        const head = sec !== lastSec ? `<div class="sec">${sec}</div>` : "";
        lastSec = sec;
        if (r.info) return `${head}<div class="item info"><span class="path muted">${escapeHtml(r.label)}</span></div>`;
        if (r.hit) return `${head}<div class="item hit ${i === sel ? "sel" : ""}" data-i="${i}"><span class="dot s-${r.file ? statusOf(r.file) : "unreviewed"}"></span><span class="path"><span class="muted">${escapeHtml(shortPath(r.path))}:${r.line}</span> <span class="kind ${r.kind}">${r.kind === "removed" ? "−" : "+"}</span> ${escapeHtml(r.text.slice(0, 110))}</span></div>`;
        if (r.cmd) return `${head}<div class="item cmd ${i === sel ? "sel" : ""}" data-i="${i}"><span class="path">› ${r.label}</span></div>`;
        const f = r.file;
        return `${head}<div class="item ${i === sel ? "sel" : ""}" data-i="${i}"><span class="dot s-${statusOf(f)}"></span><span class="path">${r.hl}</span><span class="meta">${f.stale ? '<span style="color:var(--stale)">stale · </span>' : ""}${STATUS_LABEL[statusOf(f)]} · +${f.additions} −${f.deletions}</span></div>`;
      })
      .join("") || `<div class="sec">No matches</div>`;
    items.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
  };
  const choose = (i) => {
    const r = results[i];
    if (!r || r.info) return;
    closeOverlay();
    if (r.cmd) runAction(r.act);
    else if (r.hit) jumpTo(r.path, { line: r.line, side: r.side });
    else openFile(r.file.path);
  };
  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(results.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter") choose(sel);
    else if (e.key === "Escape") closeOverlay();
  });
  items.addEventListener("click", (e) => { const it = e.target.closest(".item"); if (it) choose(Number(it.dataset.i)); });
  ov.onclick = (e) => { if (e.target === ov) closeOverlay(); };
  if (prefill) input.value = prefill;
  run();
  input.focus();
}
function fuzzy(q, path) {
  const needle = q.toLowerCase();
  const hay = path.toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx >= 0) {
    const bonus = hay.lastIndexOf("/") < idx ? 40 : 0;
    return { score: 100 + bonus - idx / 10 - path.length / 100, hl: escapeHtml(path.slice(0, idx)) + "<b>" + escapeHtml(path.slice(idx, idx + needle.length)) + "</b>" + escapeHtml(path.slice(idx + needle.length)) };
  }
  let score = 0;
  let hi = 0;
  let out = "";
  let prevMatch = -2;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (hi < needle.length && hay[i] === needle[hi]) {
      score += 2 + (i === 0 || "/._-".includes(path[i - 1]) ? 6 : 0) + (prevMatch === i - 1 ? 3 : 0);
      prevMatch = i;
      out += `<b>${escapeHtml(ch)}</b>`;
      hi++;
    } else out += escapeHtml(ch);
  }
  if (hi < needle.length) return { score: 0, hl: "" };
  return { score: score - path.length / 50, hl: out };
}

function showHelp() {
  const row = (k, l) => `<div><span>${l}</span><kbd>${k}</kbd></div>`;
  dialog({
    title: "Keyboard",
    body: `<div class="keys">
      <h4>Lenses</h4>${row("1", "Map")}${row("2", "Deck")}${row("3", "Ledger")}${row("4", "Notes")}${row("⌘K", "Palette: files · > commands · / search diff")}${row("⌘⇧F", "Search the PR diff")}
      <h4>Attention tour</h4>${row("⇧J / ⇧K", "Next / previous signal: findings, open threads, failing tests, stale files")}${row("⇧L", "List all signals in the current queue")}${row("✕ on a finding", "Dismiss it (⇧-click to say why)")}
      <h4>Deck</h4>${row("→ / ]  ·  ← / [", "Next / previous file in queue")}${row(".", "Next pending file")}${row("J / K", "Next / previous hunk")}${row("↑ 20 / ↓ 20", "Reveal more unchanged lines around a hunk")}${row("drag edges", "Resize rail / inspector (double-click resets)")}
      ${row("R", "Mark reviewed")}${row("S", "Mark skimmed")}${row("F", "Flag (then type why)")}${row("D", "Defer")}${row("U", "Clear status")}${row("Z", "Undo last status change")}
      ${row("C", "File-level note")}${row("click line №", "Line note (⇧-click to extend)")}${row("1–9, 0", "Insert a note template (empty composer)")}${row("/", "Search templates (empty composer)")}${row("⌘⏎", "Save note")}${row("V", "Split / unified")}${row("E", "Full file")}${row("W", "Wrap")}${row("I", "Since my review (stale files)")}${row("\\", "Toggle rail")}${row("N", "Toggle notes panel")}${row("G", "Open on GitHub")}
      <h4>Views</h4>${row("O", "Outline (tests) · Surface (source) · Keys (locale) ↔ code")}${row("M", "Fold / unfold code moved verbatim from elsewhere in the PR")}${row("⌥-click identifier", "Peek its definition (⌥⇧-click jumps)")}${row("click step / item", "Peek the code at that line (⌘-click opens it)")}
      <h4>Tests</h4>${row("▶ / 🔍", "Play CI video · open trace viewer")}
      <h4>Pull requests</h4>${row("⌘P", "Switch pull request")}
      <h4>Related changes</h4>${row("click row", "Jump to that file (at the usage line)")}${row("⇧-click / ⧉", "Peek in a split pane")}${row("B", "Back to where you jumped from")}${row("Esc", "Close peek")}
      <h4>Ledger</h4>${row("J / K", "Move")}${row("X", "Toggle select")}${row("A", "Select all visible")}${row("⏎", "Open")}${row("R S F D U", "Apply to selection")}
      <h4>Everywhere</h4>${row("T", "Light / dark")}${row("Esc", "Close / blur")}${row("?", "This help")}
    </div>
    <h4>Statuses</h4><p class="muted" style="margin:4px 0">Reviewed = read carefully · Skimmed = glanced, low risk · Flagged = has concerns (add notes) · Deferred = come back later · <b style="color:var(--stale)">Stale</b> = you reviewed it, then the author changed it — re-check with "Since my review".</p>`,
    buttons: [{ label: "Close" }],
  });
}

function dialog({ title, body, buttons = [], onDismiss = null }) {
  const ov = $("#overlay");
  ov.hidden = false;
  ov.innerHTML = `<div class="dialog"><div class="d-head">${title}</div><div class="d-body">${body}</div><div class="d-foot">${buttons.map((b, i) => `<button class="${b.primary ? "primary" : ""}" data-b="${i}">${b.label}</button>`).join("")}</div></div>`;
  let settled = false;
  ov.querySelectorAll("[data-b]").forEach((btn) =>
    btn.addEventListener("click", () => {
      settled = true;
      closeOverlay();
      buttons[Number(btn.dataset.b)].onClick?.();
    }),
  );
  ov.onclick = (e) => { if (e.target === ov) closeOverlay(); };
  // Dismissal without a button (click outside, Esc) must still settle callers that await an answer.
  if (onDismiss) {
    const mo = new MutationObserver(() => {
      if (!ov.hidden) return;
      mo.disconnect();
      if (!settled) onDismiss();
    });
    mo.observe(ov, { attributes: true, attributeFilter: ["hidden"] });
  }
  (ov.querySelector(".primary") || ov.querySelector("[data-b]"))?.focus();
}
function promptDialog(title, value) {
  return new Promise((resolve) => {
    const ov = $("#overlay");
    ov.hidden = false;
    ov.innerHTML = `<div class="dialog"><div class="d-head">${title}</div><div class="d-body"><textarea style="width:100%;min-height:120px">${escapeHtml(value)}</textarea></div><div class="d-foot"><button data-x="c">Cancel</button><button class="primary" data-x="s">Save <kbd>⌘⏎</kbd></button></div></div>`;
    const ta = ov.querySelector("textarea");
    const done = (v) => { closeOverlay(); resolve(v); };
    ov.querySelector("[data-x=s]").addEventListener("click", () => done(ta.value));
    ov.querySelector("[data-x=c]").addEventListener("click", () => done(null));
    ta.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") done(ta.value); if (e.key === "Escape") done(null); });
    ta.focus();
  });
}
function closeOverlay() {
  const ov = $("#overlay");
  ov.hidden = true;
  ov.innerHTML = "";
}
function toast(msg, kind = "", sub = "") {
  const t = el(`<div class="toast ${kind}">${escapeHtml(msg)}${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}</div>`);
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, 2600);
}

// ============================================================================
// keyboard
// ============================================================================

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    return $("#overlay").hidden ? openPalette() : closeOverlay();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openPalette("/");
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
    e.preventDefault();
    return $("#overlay").hidden ? showPrPicker() : closeOverlay();
  }
  if (e.key === "Escape") {
    if (!$("#overlay").hidden) return closeOverlay();
    if (document.querySelector("tr.composer")) return closeComposer();
    if (S.peek) return closePeek();
    if (typing) return e.target.blur();
    if (S.tour.idx >= 0) return endTour();
    return;
  }
  if (typing || !$("#overlay").hidden || e.metaKey || e.ctrlKey || e.altKey || !S.snap) return;
  // Letters keep their case so ⇧J (tour) and j (hunk) are different keys; Caps Lock alone doesn't count.
  const k = e.key.length === 1 && /[a-z]/i.test(e.key) ? (e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase()) : e.key;
  const deck = S.lens === "deck";
  const ledger = S.lens === "ledger";
  const focusFileNote = () => {
    if (!deck) return false;
    if (!S.side) runAction("side");
    setTimeout(() => $("#file-note")?.focus(), 0);
    return true;
  };
  const map = {
    "1": () => navigate("map"),
    "2": () => navigate("deck", S.current),
    "3": () => navigate("ledger"),
    "4": () => navigate("notes"),
    "/": () => { e.preventDefault(); $("#f-q").focus(); $("#f-q").select(); },
    "?": () => showHelp(),
    t: () => runAction("theme"),
    r: () => runAction("status:reviewed"),
    s: () => runAction("status:skimmed"),
    f: () => runAction("status:flagged"),
    d: () => runAction("status:deferred"),
    u: () => runAction("status:unreviewed"),
    z: () => (deck || S.lens === "ledger") && runAction("undo"),
    ".": () => (deck ? runAction("nextpending") : S.lens === "map" || S.lens === "ledger" ? runAction("resume") : null),
    ArrowRight: () => deck && neighbor(S.current, 1) && openFile(neighbor(S.current, 1).path),
    ArrowLeft: () => deck && neighbor(S.current, -1) && openFile(neighbor(S.current, -1).path),
    "]": () => deck && neighbor(S.current, 1) && openFile(neighbor(S.current, 1).path),
    "[": () => deck && neighbor(S.current, -1) && openFile(neighbor(S.current, -1).path),
    j: () => (deck ? hunkNav(1) : ledger ? ledgerMove(1) : null),
    k: () => (deck ? hunkNav(-1) : ledger ? ledgerMove(-1) : null),
    J: () => tourStep(1),
    K: () => tourStep(-1),
    L: () => showTourDialog(),
    c: focusFileNote,
    v: () => deck && runAction("view:mode"),
    e: () => (deck ? runAction("view:full") : S.lens === "notes" ? runAction("export") : null),
    p: () => S.lens === "notes" && runAction("publish"),
    w: () => deck && runAction("view:wrap"),
    i: () => deck && runAction("view:inter"),
    n: () => deck && runAction("side"),
    "\\": () => deck && runAction("rail"),
    g: () => deck && runAction("github"),
    b: () => deck && goBack(),
    o: () => deck && S.current && altView(S.current) && runAction("outline:toggle"),
    m: () => deck && runAction("view:fold"),
    x: () => ledger && runAction("select"),
    a: () => ledger && runAction("selectall"),
    Enter: () => ledger && runAction("open"),
  };
  const fn = map[k];
  if (fn) {
    fn();
    if (["j", "k", "J", "K", "/", " ", "ArrowLeft", "ArrowRight"].includes(k)) e.preventDefault();
  }
});

// ============================================================================
// utils
// ============================================================================

function splitPath(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
}
function shortPath(p) {
  const parts = p.split("/");
  return parts.length <= 3 ? p : `…/${parts.slice(-2).join("/")}`;
}
function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function fmtNum(n) {
  return n.toLocaleString();
}
function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ============================================================================
// boot
// ============================================================================

async function boot() {
  applyTheme();
  document.querySelectorAll(".lenses button").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.lens, b.dataset.lens === "deck" ? S.current : undefined)));
  $("#btn-sync").addEventListener("click", sync);
  $("#btn-palette").addEventListener("click", () => openPalette());
  $("#btn-help").addEventListener("click", showHelp);
  $("#btn-prs").addEventListener("click", () => (PR ? showPrPicker() : null));
  if (!PR) return renderPickerPage();
  $("#lens").innerHTML = `<div class="empty-state" style="padding:80px 20px"><h2>Loading ${escapeHtml(PR.owner + "/" + PR.repo)} #${PR.number}…</h2><div class="muted">First open fetches the PR from GitHub (a few seconds for very large PRs).</div></div>`;
  try {
    applySnapshot(await api("/api/snapshot"));
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:var(--sans)"><h2>Sift couldn't load ${escapeHtml(PR_PARAM)}</h2><p>${escapeHtml(err.message)}</p><p><a href="/">← pick another pull request</a></p></div>`;
    return;
  }
  S.current = prefs.current && S.byPath.has(prefs.current) ? prefs.current : null;
  window.sift = { state: S, queue, nextPending, openFile, runAction, gotoDefinition, peek, jumpTo }; // handy for debugging from the console
  route();
  loadCi();
  loadStories();
  loadThreads();
  loadMoves();
  loadLint();
  loadRisk();
}
boot();

// ============================================================================
// Playwright: CI results + spec outlines
// ============================================================================

async function loadCi() {
  try {
    const data = await api("/api/ci");
    const was = S.ci?.state;
    S.ci = data;
    S.queueCache = null;
    S.tour.list = null;
    if (data.state === "ready" && was !== "ready") {
      loadCiHistory();
      renderHeader();
      renderFilterBar();
      if (S.lens === "deck") {
        renderRail();
        if (S.current && isTestPath(S.current) && S.outlineMode) renderBody();
      } else if (S.lens === "map") renderMap($("#lens"));
      else if (S.lens === "ledger") renderLedger($("#lens"));
    }
    clearTimeout(S.ciPoll);
    if (data.state === "discovering" || data.state === "loading" || data.state === "idle") S.ciPoll = setTimeout(loadCi, 2000);
  } catch {
    S.ci = { state: "error", error: "unreachable" };
  }
}
async function loadCiHistory({ refresh = false } = {}) {
  clearTimeout(S.ciHistPoll);
  try {
    const d = await api(`/api/ci/history${refresh ? "?refresh=1" : ""}`);
    S.ciHist = d;
    if (d.state === "loading" || d.state === "waiting" || d.state === "idle") S.ciHistPoll = setTimeout(loadCiHistory, 5000);
    else if (d.state === "ready" && S.lens === "deck" && S.current && isTestPath(S.current) && S.outlineMode) renderBody();
  } catch {}
}
const HIST_GLYPH = { passed: "·", failed: "✗", flaky: "~", skipped: "–" };
const HIST_LABEL = { "newly-broken": "newly broken", "broken-since": "broken since", "always-failing": "failing in every run", intermittent: "flaky across runs", recovered: "recovered", failing: "failing" };
const HIST_SHORT = { "newly-broken": "newly broken", "broken-since": "broken for several runs", "always-failing": "always failing", intermittent: "flaky", recovered: "recovered" };
function histFor(path, title, project) {
  return S.ciHist?.state === "ready" ? S.ciHist.tests?.[`${path}::${title}::${project || ""}`] || null : null;
}
function histHtml(h) {
  if (!h) return "";
  const runs = S.ciHist.runs;
  const since = h.since != null ? runs[h.since] : null;
  const label = h.cls === "broken-since" && since ? `broken since run #${since.number} (${h.streak} runs)` : HIST_LABEL[h.cls] || h.cls;
  const spark = h.seq.map((o, i) => `<i class="${o || "none"}" title="run #${runs[i]?.number}: ${o || "not run"}">${o ? HIST_GLYPH[o] : "□"}</i>`).join("");
  return `<span class="hist hist-${h.cls}" title="${escapeHtml(label)} — last ${runs.length} runs, oldest → newest">${spark} <span class="hist-l">${escapeHtml(label)}</span></span>`;
}
function ciBadge(path) {
  const c = S.ci?.byFile?.[path];
  if (!c) return "";
  const parts = [];
  if (c.passed) parts.push(`<span class="ci-ok">✓${c.passed}</span>`);
  if (c.failed) parts.push(`<span class="ci-fail">✗${c.failed}</span>`);
  if (c.flaky) parts.push(`<span class="ci-flaky">↻${c.flaky}</span>`);
  if (c.skipped) parts.push(`<span class="ci-skip">–${c.skipped}</span>`);
  return `<span class="ci-badge" title="Playwright: ${c.passed} passed · ${c.failed} failed · ${c.flaky} flaky · ${c.skipped} skipped">${parts.join(" ")}</span>`;
}
function ciRunLabel(run, { short = false } = {}) {
  if (!run) return "";
  if (run.local) return "local run";
  const behind = run.behind ? ` · ${run.behind} commit${run.behind > 1 ? "s" : ""} behind head` : " · on head";
  return `run #${run.number} @ ${run.headSha.slice(0, 7)}${short ? "" : behind} · ${ago(run.createdAt)}`;
}
function outcomeIcon(o) {
  return { passed: '<span class="oc ok" title="passed">✓</span>', failed: '<span class="oc fail" title="failed">✗</span>', flaky: '<span class="oc flaky" title="flaky: failed, then passed on retry">↻</span>', skipped: '<span class="oc skip" title="skipped">–</span>' }[o] || '<span class="oc none" title="no CI result">○</span>';
}

async function loadOutline(path) {
  const f = S.byPath.get(path);
  const key = `${path}:${f.sha}`;
  if (!S.outlineCache.has(key)) S.outlineCache.set(key, await api(`/api/outline?path=${encodeURIComponent(path)}`));
  return S.outlineCache.get(key);
}
async function loadCiFile(path) {
  if (S.ci?.state !== "ready") return null;
  const key = `${path}@${S.ci.run?.id}`;
  if (!S.ciFileCache.has(key)) S.ciFileCache.set(key, (await api(`/api/ci/file?path=${encodeURIComponent(path)}`)).tests || []);
  return S.ciFileCache.get(key);
}

const STEP_GLYPH = { nav: "→", action: "•", expect: "✓", helper: "ƒ", locator: "◇", data: "=", wait: "…", hardwait: "⏱", mock: "⇄", api: "⇅", step: "▸", branch: "?", loop: "↻", group: "∥", read: "◎", other: "·" };

async function renderOutlineBody(body, f) {
  body.innerHTML = `<div class="loading">Reading spec…</div>`;
  let outline;
  let ciTests;
  try {
    [outline, ciTests] = await Promise.all([loadOutline(f.path), loadCiFile(f.path).catch(() => null)]);
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h2>Couldn't build outline</h2>${escapeHtml(err.message)}<br/><br/><button data-act="outline:off">Show code instead</button></div>`;
    body.querySelector("[data-act]").addEventListener("click", () => runAction("outline:off"));
    return;
  }
  if (S.current !== f.path) return;
  if (!outline.ok) {
    body.innerHTML = `<div class="empty-state"><h2>Couldn't parse this spec</h2>${escapeHtml(outline.error || "")}<br/><br/><button data-act="outline:off">Show code</button></div>`;
    body.querySelector("[data-act]").addEventListener("click", () => runAction("outline:off"));
    return;
  }
  if (!outline.tests.length && !outline.hooks.length) {
    // a helper/fixture module, not a spec: show the code instead of an empty outline
    S.altSkip ||= new Set();
    S.altSkip.add(f.path);
    renderPaneHead();
    return renderBody();
  }
  // Match CI results by title first (stable across edits), then by line; across projects keep the worst outcome.
  const rank = { failed: 0, flaky: 1, passed: 2, skipped: 3 };
  const pick = (map, key, t) => { const cur = map.get(key); if (!cur || rank[t.outcome] < rank[cur.outcome]) map.set(key, t); };
  const byLine = new Map();
  const byTitle = new Map();
  for (const t of ciTests || []) { pick(byTitle, t.title, t); pick(byLine, t.line, t); }
  const ciFor = (t) => byTitle.get(t.title) || byLine.get(t.line) || null;
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const t of outline.tests) {
    const c = ciFor(t);
    if (c) counts[c.outcome]++;
  }
  const changes = { new: 0, modified: 0, unchanged: 0 };
  for (const t of outline.tests) changes[t.change || (f.status === "added" ? "new" : "unchanged")]++;
  const ci = S.ci;
  const ciBar =
    ci?.state === "ready" && ciTests
      ? ciTests.length
        ? `<div class="ol-ci"><span class="ol-ci-counts">${counts.passed ? `<span class="ci-ok">✓ ${counts.passed} passed</span>` : ""}${counts.failed ? `<span class="ci-fail">✗ ${counts.failed} failed</span>` : ""}${counts.flaky ? `<span class="ci-flaky">↻ ${counts.flaky} flaky</span>` : ""}${counts.skipped ? `<span class="ci-skip">– ${counts.skipped} skipped</span>` : ""}<span class="muted">· ${fmtMs(ciTests.reduce((n, t) => n + t.lastDuration, 0))} total</span>${(() => { if (S.ciHist?.state !== "ready") return S.ciHist?.state === "loading" ? `<span class="muted">· ⟳ history ${escapeHtml(S.ciHist.progress || "")}</span>` : ""; const hs = outline.tests.map((t) => { const c = ciFor(t); return c ? histFor(f.path, t.title, c.project) : null; }).filter(Boolean); const by = {}; for (const h of hs) by[h.cls] = (by[h.cls] || 0) + 1; const parts = ["newly-broken", "broken-since", "always-failing", "intermittent", "recovered"].filter((k) => by[k]).map((k) => `<span class="hist-${k}">${by[k]} ${HIST_SHORT[k]}</span>`); return parts.length ? `<span class="muted">· across ${S.ciHist.runs.length} runs:</span> ${parts.join(" ")}` : `<span class="muted">· stable across ${S.ciHist.runs.length} runs</span>`; })()}</span><span class="sp"></span><a class="muted" href="${ci.run?.url || "#"}" target="_blank" rel="noopener" title="Open the workflow run on GitHub">${ciRunLabel(ci.run)}${ci.run?.url ? " ↗" : ""}</a><button class="ghost tb" data-act="ci">details</button></div>`
        : `<div class="ol-ci muted">No results for this spec in ${ciRunLabel(ci.run, { short: true })} (new since that run, or not in the shard set).<span class="sp"></span><button class="ghost tb" data-act="ci">details</button></div>`
      : ci?.state === "loading" || ci?.state === "discovering"
        ? `<div class="ol-ci muted">⟳ ${escapeHtml(ci.progress || "Loading Playwright results…")}</div>`
        : ci?.state === "none"
          ? `<div class="ol-ci muted">No Playwright CI run found on this PR's commits. <span class="muted">Load a local run with <code>--playwright-results &lt;dir&gt;</code>.</span></div>`
          : ci?.state === "error"
            ? `<div class="ol-ci muted">Playwright results unavailable: ${escapeHtml(ci.error || "")} <button class="ghost tb" data-act="ci">details</button></div>`
            : "";

  const smell = (sm) => `<span class="pill tiny smell-${sm.level}" title="${escapeHtml(sm.text)}" ${sm.lines?.length ? `data-line="${sm.lines[0]}"` : ""}>${escapeHtml(sm.text)}</span>`;
  const summary = `<div class="ol-bar">
      <b>${outline.tests.length}</b> test${outline.tests.length === 1 ? "" : "s"}
      ${f.status !== "added" ? `<span class="muted">·</span> ${changes.new ? `<span class="chg new">${changes.new} new</span>` : ""} ${changes.modified ? `<span class="chg mod">${changes.modified} modified</span>` : ""} ${changes.unchanged ? `<span class="muted">${changes.unchanged} untouched</span>` : ""}` : `<span class="chg new">all new</span>`}
      ${outline.hooks.length ? `<span class="muted">· ${outline.hooks.length} hook${outline.hooks.length > 1 ? "s" : ""}</span>` : ""}
      ${outline.fixtures.length ? `<span class="muted">· fixtures:</span> <span class="mono">${outline.fixtures.map(escapeHtml).join(", ")}</span>` : ""}
      ${outline.helpers.length ? `<span class="muted">· helpers:</span> <span class="mono">${outline.helpers.slice(0, 8).map(escapeHtml).join(", ")}${outline.helpers.length > 8 ? ` +${outline.helpers.length - 8}` : ""}</span>` : ""}
      ${outline.config.length ? `<span class="muted">· </span><span class="mono muted" title="${outline.config.map((c) => escapeHtml(c.text)).join("&#10;")}">${escapeHtml(outline.config[0].text)}${outline.config.length > 1 ? ` +${outline.config.length - 1}` : ""}</span>` : ""}
      <span class="sp"></span>
      ${outline.smells.map(smell).join(" ")}
      <button class="ghost tb" data-x="expand">expand all</button><button class="ghost tb" data-x="collapse">collapse all</button>
    </div>`;

  // Collapsed by default; only tests that need attention open themselves (CI failed/flaky, .only/.skip).
  const renderSteps = (steps, depth = 0) =>
    steps.length
      ? `<ul class="ol-steps d${depth}">${steps
          .map((s) => {
            const kids = s.children?.length ? renderSteps(s.children, depth + 1) : "";
            return `<li class="st ${s.kind}" data-line="${s.line}" title="L${s.line} — click to peek the code"><span class="g">${STEP_GLYPH[s.kind] || "·"}</span><span class="t">${s.assign ? `<span class="as">${escapeHtml(s.assign)} =</span> ` : ""}${escapeHtml(s.text)}${s.soft ? ' <span class="muted">(soft)</span>' : ""}</span><span class="ln">L${s.line}</span>${kids}</li>`;
          })
          .join("")}</ul>`
      : `<div class="muted" style="padding:2px 8px">no steps</div>`;

  const hooksHtml = outline.hooks.length
    ? `<details class="ol-hooks"><summary>Hooks <span class="muted">${outline.hooks.map((h) => h.kind).join(", ")}</span></summary>${outline.hooks.map((h) => `<div class="ol-hook"><div class="ol-hook-h" data-line="${h.line}"><b>${h.kind}</b> ${h.scope.length ? `<span class="muted">in ${h.scope.map(escapeHtml).join(" › ")}</span>` : ""}<span class="ln">L${h.line}</span></div>${renderSteps(h.steps)}</div>`).join("")}</details>`
    : "";

  let lastScope = null;
  const cards = [];
  for (const t of outline.tests) {
    const scope = t.scope.join(" › ");
    if (scope !== lastScope) {
      cards.push(`<div class="ol-scope">${scope ? escapeHtml(scope) : '<span class="muted">(top level)</span>'}</div>`);
      lastScope = scope;
    }
    const c = ciFor(t);
    const open = (c && (c.outcome === "failed" || c.outcome === "flaky")) || t.modifiers.length > 0;
    const mods = t.modifiers.map((m) => `<span class="pill tiny mod-${m}">.${m}</span>`).join("");
    const chg = t.change === "new" || (f.status === "added" && !t.change) ? `<span class="chg new">new</span>` : t.change === "modified" ? `<span class="chg mod">modified</span>` : "";
    const dur = c ? `<span class="muted dur">${fmtMs(c.lastDuration)}${c.attempts.length > 1 ? ` · ${c.attempts.length} attempts` : ""}</span>` : "";
    const hist = c ? histHtml(histFor(f.path, t.title, c.project)) : "";
    const stepCount = flatCount(t.steps);
    const meta = `<span class="muted meta">${stepCount} step${stepCount === 1 ? "" : "s"} · ${t.assertions} expect${t.assertions === 1 ? "" : "s"} · ${t.endLine - t.line + 1} lines</span>`;
    cards.push(`<details class="ol-test ${c ? c.outcome : "none"}" ${open ? "open" : ""} data-test-line="${t.line}">
      <summary>${outcomeIcon(c?.outcome)}<span class="title">${escapeHtml(t.title)}</span>${mods}${chg}${t.tags.map((x) => `<span class="pill tiny">${escapeHtml(x)}</span>`).join("")}<span class="sp"></span>${hist}${meta}${dur}<a class="ln" data-line="${t.line}" title="Peek the code">L${t.line}</a></summary>
      <div class="ol-test-body">${renderSteps(t.steps)}${c ? renderCiAttempts(c, f) : ""}</div>
    </details>`);
  }

  body.innerHTML = `<div class="outline">${ciBar}${summary}${hooksHtml}${cards.join("") || `<div class="empty-state"><h2>No tests found</h2>This file has no test() calls — maybe a helper or fixture module. <button data-act="outline:off">Show code</button></div>`}</div>`;
  body.scrollTop = 0;
  applyPendingScroll();

  body.onclick = async (e) => {
    const act = e.target.closest("[data-act]");
    if (act) return runAction(act.dataset.act);
    const x = e.target.closest("[data-x]");
    if (x) {
      if (x.dataset.x === "expand" || x.dataset.x === "collapse") body.querySelectorAll("details.ol-test").forEach((d) => (d.open = x.dataset.x === "expand"));
      else if (x.dataset.x === "media") toggleMedia(x, body);
      else if (x.dataset.x === "repro") copyText(x.dataset.cmd, "Repro command copied");
      else if (x.dataset.x === "trace") window.open(`https://trace.playwright.dev/?trace=${encodeURIComponent(location.origin + x.dataset.url)}`, "_blank");
      else if (x.dataset.x === "snapshot") toggleSnapshot(x);
      else if (x.dataset.x === "goto-loc") {
        const p = x.dataset.path;
        if (S.byPath.has(p)) jumpTo(p, { line: Number(x.dataset.line), side: "RIGHT" });
        else peek(p, { line: Number(x.dataset.line), side: "RIGHT" });
      }
      return;
    }
    const ln = e.target.closest("[data-line]");
    if (ln && !e.target.closest("summary > .title")) {
      e.preventDefault();
      const line = Number(ln.dataset.line);
      if (e.shiftKey || e.metaKey) {
        S.outlineMode = false;
        S.pendingScroll = { line, side: "RIGHT" };
        savePrefs();
        renderPaneHead();
        renderBody();
      } else peek(f.path, { line, side: "RIGHT" });
    }
  };
}

function flatCount(steps) {
  return steps.reduce((n, s) => n + 1 + (s.children ? flatCount(s.children) : 0), 0);
}
function renderCiAttempts(c, f) {
  const parts = [];
  if (c.annotations?.length) parts.push(`<div class="muted">annotations: ${c.annotations.map(escapeHtml).join(", ")}</div>`);
  const failedAttempts = c.attempts.filter((a) => a.error);
  const firstErr = failedAttempts[0]?.error;
  if (firstErr) {
    const loc = firstErr.location;
    const locPath = loc?.file ? toRepoPath(loc.file) : null;
    parts.push(`<div class="ci-error">
      <div class="ci-error-h"><span class="ci-fail">✗</span> ${escapeHtml(firstErr.headline)}${failedAttempts.length > 1 ? `<span class="muted"> · same on ${failedAttempts.length} attempts</span>` : ""}</div>
      ${loc ? `<div class="ci-error-loc">at <a data-x="goto-loc" data-path="${escapeHtml(locPath || loc.file)}" data-line="${loc.line}" title="${escapeHtml(loc.file)}">${escapeHtml(locPath || loc.file)}:${loc.line}</a>${locPath === f.path ? "" : locPath ? ' <span class="muted">(helper)</span>' : ""}</div>` : ""}
      ${firstErr.snippet ? `<pre class="ci-snippet">${escapeHtml(firstErr.snippet.split("\n").slice(0, 10).join("\n"))}</pre>` : ""}
      <details class="ci-full"><summary class="muted">full error</summary><pre>${escapeHtml(firstErr.message.slice(0, 4000))}</pre></details>
    </div>`);
  }
  const attemptsHtml = c.attempts
    .map((a, i) => {
      const atts = a.attachments.filter((x) => x.url || x.inline);
      const btn = (x) => {
        if (/video/.test(x.contentType)) return `<button class="tb att" data-x="media" data-kind="video" data-url="${x.url}">▶ video</button>`;
        if (/image/.test(x.contentType)) return `<button class="tb att" data-x="media" data-kind="image" data-url="${x.url}">📷 ${escapeHtml(x.name)}</button>`;
        if (x.name === "trace" || /zip/.test(x.contentType)) return `<button class="tb att" data-x="trace" data-url="${x.url}" title="Opens trace.playwright.dev with this trace (served from Sift)">🔍 trace</button>`;
        if (/markdown|text/.test(x.contentType)) return `<button class="tb att" data-x="snapshot" data-url="${x.url || ""}" title="${escapeHtml(x.name)}">▤ ${x.name === "error-context" ? "page snapshot" : escapeHtml(x.name)}</button>`;
        return `<a class="tb att" href="${x.url}" target="_blank">${escapeHtml(x.name)}</a>`;
      };
      const label = a.retry ? `retry ${a.retry}` : c.attempts.length > 1 ? "attempt 1" : "run";
      return `<div class="ci-attempt"><span class="oc ${a.status === "passed" ? "ok" : a.status === "skipped" ? "skip" : "fail"}">${a.status === "passed" ? "✓" : a.status === "skipped" ? "–" : "✗"}</span><span class="muted">${label} · ${a.status} · ${fmtMs(a.duration)}</span>${atts.map(btn).join("")}</div><div class="ci-media" data-for="${i}"></div>`;
    })
    .join("");
  if (c.attempts.length) parts.push(`<div class="ci-attempts">${attemptsHtml}</div>`);
  if (c.outcome === "failed" || c.outcome === "flaky") parts.push(`<div class="ci-repro"><button class="tb" data-x="repro" data-cmd="${escapeHtml(reproCommand(c, f.path))}" title="Copy a command that runs just this test locally, with trace and video on">⧉ copy repro command</button><code class="muted">${escapeHtml(reproCommand(c, f.path))}</code></div>`);
  return parts.length ? `<div class="ci-block">${parts.join("")}</div>` : "";
}
function reproCommand(c, filePath) {
  const file = filePath || c.file;
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const grep = c.title ? ` -g ${q(c.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}` : "";
  return `npx playwright test ${file}:${c.line}${grep}${c.project ? ` --project=${q(c.project)}` : ""} --trace on --video on --retries 0`;
}
async function copyText(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what, "ok");
  } catch {
    promptDialog("Copy this", text);
  }
}
function toRepoPath(abs) {
  const p = String(abs).replace(/\\/g, "/");
  const m = p.match(/\/(tests?|src|e2e|cypress)\/.*$/);
  if (!m) return null;
  const rel = m[0].slice(1);
  if (S.byPath.has(rel)) return rel;
  const hit = [...S.byPath.keys()].find((k) => k.endsWith(rel));
  return hit || rel;
}
function toggleMedia(btn, body) {
  const url = btn.dataset.url;
  const holder = btn.closest(".ci-attempt").nextElementSibling;
  const existing = holder.querySelector(`[data-url="${CSS.escape(url)}"]`);
  if (existing) {
    existing.remove();
    btn.classList.remove("on");
    return;
  }
  btn.classList.add("on");
  const el2 = document.createElement("div");
  el2.className = "media-item";
  el2.dataset.url = url;
  el2.innerHTML = btn.dataset.kind === "video" ? `<video controls preload="metadata" src="${url}"></video><div class="muted" style="font-size:11px">Streamed from the CI artifact · <a href="${url}" download>download</a></div>` : `<img src="${url}" alt="screenshot" />`;
  holder.appendChild(el2);
  void body;
}
async function toggleSnapshot(btn) {
  const url = btn.dataset.url;
  const holder = btn.closest(".ci-attempt").nextElementSibling;
  const existing = holder.querySelector(`[data-url="${CSS.escape(url)}"]`);
  if (existing) {
    existing.remove();
    btn.classList.remove("on");
    return;
  }
  btn.classList.add("on");
  const el2 = document.createElement("div");
  el2.className = "media-item";
  el2.dataset.url = url;
  el2.innerHTML = `<pre class="snapshot">Loading…</pre>`;
  holder.appendChild(el2);
  try {
    const res = await fetch(url);
    el2.querySelector("pre").textContent = (await res.text()).slice(0, 20000);
  } catch (err) {
    el2.querySelector("pre").textContent = `Failed: ${err.message}`;
  }
}

async function showCiDialog() {
  let ci = S.ci;
  try {
    ci = await api("/api/ci");
    S.ci = ci;
  } catch {}
  const st = ci?.stats;
  const runRow = (r) => `<option value="${r.id}" ${ci.run?.id === r.id ? "selected" : ""}>#${r.number} · ${r.headSha.slice(0, 7)} · ${r.branch} · ${r.behind ? `${r.behind} behind` : "head"} · ${r.conclusion || r.status} · ${ago(r.createdAt)}</option>`;
  const testLink = (t) => `<a data-open-test="${escapeHtml(t.file)}" data-line="${t.line}" class="mono" title="${escapeHtml(t.title)}">${escapeHtml(t.file.replace(/^tests\//, ""))}:${t.line}</a> <span class="muted">${escapeHtml(t.title.slice(0, 70))}</span>${t.outcome === "failed" || t.outcome === "flaky" ? ` <button class="ghost tb" data-repro="${escapeHtml(reproCommand(t, t.file))}" title="Copy a command that runs just this test locally">⧉</button>` : ""}`;
  const body =
    ci?.state === "ready"
      ? `<p><b>${st.passed}</b> passed · <b style="color:var(--stale)">${st.failed}</b> failed · <b style="color:var(--flagged)">${st.flaky}</b> flaky · ${st.skipped} skipped · ${fmtMs(st.durationMs)} of test time — ${ci.run?.url ? `<a href="${ci.run.url}" target="_blank" rel="noopener">${ciRunLabel(ci.run)} ↗</a>` : ciRunLabel(ci.run)}.</p>
        ${ci.newer ? `<p class="rel-warn">A newer run is available: #${ci.newer.number} on ${ci.newer.headSha.slice(0, 7)} (${ci.newer.behind ? `${ci.newer.behind} behind` : "head"}). <button data-load-run="${ci.newer.id}">Load it</button></p>` : ""}
        ${ci.note ? `<p class="muted">${escapeHtml(ci.note)} Want recordings of every test? Run locally with <code>npx playwright test --video=on --trace=on --reporter=json,html</code> and start Sift with <code>--playwright-results &lt;dir&gt;</code>.</p>` : ""}
        ${ci.candidates?.length > 1 ? `<h4>Runs on this PR's commits</h4><select id="ci-run-select">${ci.candidates.map(runRow).join("")}</select> <button id="ci-run-load">Load</button>` : ""}
        ${ci.clusters?.length ? `<h4>Failures by error signature (${ci.clusters.length}) <span class="muted" style="font-weight:400">— same first line of the error, not a proven root cause</span></h4>${ci.clusters.map((c) => `<details class="ci-cluster"><summary><b>${c.tests.length}×</b> ${escapeHtml(c.signature)}</summary><ul>${c.tests.slice(0, 40).map((t) => `<li>${outcomeIcon(t.outcome)} ${testLink(t)}</li>`).join("")}${c.tests.length > 40 ? `<li class="muted">…and ${c.tests.length - 40} more</li>` : ""}</ul></details>`).join("")}` : "<p>No failures 🎉</p>"}
        ${histSectionHtml()}
        ${ci.slowest?.length ? `<h4>Slowest tests</h4><ul>${ci.slowest.map((t) => `<li><span class="mono muted">${fmtMs(t.duration)}</span> ${testLink(t)}</li>`).join("")}</ul>` : ""}
        ${ci.artifacts?.length ? `<h4>Artifacts</h4><ul class="muted">${ci.artifacts.map((a) => `<li>${escapeHtml(a.name)} · ${(a.size / 1048576).toFixed(0)} MB · expires ${a.expiresAt ? ago(a.expiresAt).replace(" ago", "").replace(/^(\d+)/, "in $1") : "?"}</li>`).join("")}</ul><p class="muted">Only the JSON report is downloaded; videos and traces are fetched from the artifact when you open them.</p>` : ""}`
      : ci?.state === "none"
        ? `<p>No Playwright workflow run was found on any of this PR's ${S.snap.commits.length} commits.</p><p class="muted">Load a local run instead: <code>sift &lt;pr&gt; --playwright-results path/to/dir</code> (a folder containing <code>test-results.json</code> and <code>test-results/</code>).</p><button data-ci-discover>Look again</button>`
        : ci?.state === "error"
          ? `<p>Couldn't load Playwright results: ${escapeHtml(ci.error || "")}</p>${ci.candidates?.length ? `<select id="ci-run-select">${ci.candidates.map(runRow).join("")}</select> <button id="ci-run-load">Try this run</button>` : `<button data-ci-discover>Look again</button>`}`
          : `<p>⟳ ${escapeHtml(ci?.progress || "Loading Playwright results…")}</p>`;
  dialog({ title: "Playwright results", body, buttons: [{ label: "Close" }] });
  const ov = $("#overlay");
  ov.querySelectorAll("[data-repro]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); copyText(b.dataset.repro, "Repro command copied"); }));
  ov.querySelectorAll("[data-open-test]").forEach((a) =>
    a.addEventListener("click", () => {
      closeOverlay();
      S.outlineMode = true;
      openTestAt(a.dataset.openTest, Number(a.dataset.line) || null, a.dataset.title || null);
    }),
  );
  const loadRun = async (id) => {
    closeOverlay();
    toast("Loading Playwright run…");
    S.ciFileCache.clear();
    await api("/api/ci/load", { method: "POST", body: { runId: id } });
    S.ci = { state: "loading", progress: "Loading…" };
    loadCi();
  };
  ov.querySelector("#ci-run-load")?.addEventListener("click", () => loadRun(ov.querySelector("#ci-run-select").value));
  ov.querySelector("[data-hist-refresh]")?.addEventListener("click", async () => { closeOverlay(); toast("Reloading run history…"); await loadCiHistory({ refresh: true }); showCiDialog(); });
  ov.querySelectorAll("[data-load-run]").forEach((b) => b.addEventListener("click", () => loadRun(b.dataset.loadRun)));
  ov.querySelector("[data-ci-discover]")?.addEventListener("click", async () => {
    closeOverlay();
    await api("/api/ci/discover", { method: "POST" });
    S.ci = { state: "idle" };
    loadCi();
  });
}
function histSectionHtml() {
  const h = S.ciHist;
  if (!h || h.state === "waiting" || h.state === "idle") return "";
  if (h.state === "loading") return `<h4>History across runs</h4><p class="muted">⟳ ${escapeHtml(h.progress || "Loading earlier runs…")} — only the JSON report of each run is read.</p>`;
  if (h.state === "error") return `<h4>History across runs</h4><p class="muted">Couldn't load earlier runs: ${escapeHtml(h.error || "")}</p>`;
  const runs = h.runs || [];
  const c = h.counts || {};
  const groups = [
    ["newly-broken", "Newly broken — passed in the previous run", true],
    ["broken-since", "Broken for several runs", true],
    ["always-failing", "Failing in every run we have", false],
    ["intermittent", "Flaky across runs", false],
    ["recovered", "Recovered — failed last run, passes now", false],
  ];
  const items = Object.entries(h.tests || {}).map(([k, v]) => { const [file, title, project] = k.split("::"); return { file, title, project, line: 0, ...v }; });
  const list = (cls) => {
    const arr = items.filter((x) => x.cls === cls).sort((a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title));
    return arr.length ? `<ul>${arr.slice(0, 40).map((t) => `<li>${histHtml(t)} <a data-open-test="${escapeHtml(t.file)}" data-title="${escapeHtml(t.title)}" class="mono">${escapeHtml(t.file.replace(/^tests\//, ""))}</a> <span class="muted">${escapeHtml(t.title.slice(0, 70))}</span></li>`).join("")}${arr.length > 40 ? `<li class="muted">…and ${arr.length - 40} more</li>` : ""}</ul>` : "";
  };
  return `<h4>History across ${runs.length} runs <span class="muted" style="font-weight:400">— ${runs.map((r) => `#${r.number}${r.skipped ? " (skipped: artifacts expired)" : ""}`).join(" → ")}</span> <button class="ghost tb" data-hist-refresh>↻</button></h4>
    <p class="muted">${c.stable || 0} tests stable · <span class="hist-newly-broken">${c["newly-broken"] || 0} newly broken</span> · <span class="hist-broken-since">${c["broken-since"] || 0} broken for several runs</span> · <span class="hist-always-failing">${c["always-failing"] || 0} always failing</span> · <span class="hist-intermittent">${c.intermittent || 0} flaky</span> · <span class="hist-recovered">${c.recovered || 0} recovered</span>. "Always failing" usually means the fixture or environment, not this change; "newly broken" is where to look first.</p>
    ${groups.map(([cls, label, open]) => (c[cls] ? `<details class="ci-cluster" ${open ? "open" : ""}><summary><b>${c[cls]}</b> ${label}</summary>${list(cls)}</details>` : "")).join("")}`;
}
function openTestAt(path, line, title = null) {
  if (!S.byPath.has(path)) return toast(`${path} is not part of this PR`, "warn");
  S.pendingTest = line;
  jumpTo(path, {});
  setTimeout(() => {
    const d = line ? document.querySelector(`details.ol-test[data-test-line="${line}"]`) : [...document.querySelectorAll("details.ol-test")].find((x) => x.querySelector(".title")?.textContent === title);
    if (d) {
      d.open = true;
      d.scrollIntoView({ block: "start" });
      d.classList.add("flash");
      setTimeout(() => d.classList.remove("flash"), 1500);
    }
  }, 900);
}
function fmtMs(ms) {
  if (!ms && ms !== 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  return `${m}m ${Math.round((ms % 60000) / 1000)}s`;
}


// ============================================================================
// PR picker (root page and header switcher)
// ============================================================================

function prPath(p) {
  return `/pr/${p.owner}/${p.repo}/${p.number}/`;
}
function prCard(p, { known = false } = {}) {
  const total = p.changedFiles || 0;
  const pct = total ? Math.round((100 * (p.done || 0)) / total) : 0;
  return `<a class="pr-card ${known ? "known" : ""}" href="${prPath(p)}" data-pr="${p.owner}/${p.repo}/${p.number}">
    <div class="pr-top"><span class="mono muted">${escapeHtml(p.owner)}/${escapeHtml(p.repo)}#${p.number}</span>${p.draft ? '<span class="pill tiny">draft</span>' : ""}${p.state && p.state !== "open" ? `<span class="pill tiny">${p.state}</span>` : ""}<span class="sp"></span><span class="muted">${p.author ? "@" + escapeHtml(p.author) : ""}${p.updatedAt ? " · " + ago(p.updatedAt) : p.lastActivity ? " · " + ago(p.lastActivity) : ""}</span></div>
    <div class="pr-title">${escapeHtml(p.title || "")}</div>
    ${known ? `<div class="pr-progress"><div class="pbar"><i class="s-reviewed" style="width:${pct}%"></i></div><span class="muted">${p.done || 0}/${total} covered${p.flagged ? ` · <span style="color:var(--flagged)">${p.flagged} flagged</span>` : ""}${p.additions != null ? ` · +${p.additions} −${p.deletions}` : ""}</span></div>` : `<div class="muted" style="font-size:12px">${(p.labels || []).slice(0, 4).map((l) => `<span class="pill tiny">${escapeHtml(l)}</span>`).join(" ")}${p.baseRef ? ` ${escapeHtml(p.headRef || "")} → ${escapeHtml(p.baseRef)}` : ""}</div>`}
  </a>`;
}
async function pickerHtml(repoOverride, { refresh = false } = {}) {
  let data;
  try {
    const qs = [repoOverride ? `repo=${encodeURIComponent(repoOverride)}` : "", refresh ? "refresh=1" : ""].filter(Boolean).join("&");
    data = await api(`/api/prs${qs ? `?${qs}` : ""}`);
  } catch (err) {
    return `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
  pickerHtml.last = data;
  const knownKeys = new Set(data.known.map((p) => `${p.owner}/${p.repo}#${p.number}`));
  const open = data.open.filter((p) => !knownKeys.has(`${p.owner}/${p.repo}#${p.number}`));
  const requested = data.requested.filter((p) => !knownKeys.has(`${p.owner}/${p.repo}#${p.number}`));
  return `
    <div class="picker">
      <form class="pr-open" id="pr-open-form"><input type="text" id="pr-open-input" placeholder="Paste a PR URL or owner/repo#123…" autofocus /><button class="primary">Open</button>
        <span class="sp"></span><label class="muted">repo <input type="text" id="pr-repo-input" value="${escapeHtml(data.repo || "")}" placeholder="owner/repo" style="width:200px" /></label></form>
      ${data.error ? `<div class="rel-warn">GitHub lookup failed: ${escapeHtml(data.error)}</div>` : ""}
      <div class="muted picker-meta">${data.cachedAt ? `GitHub list ${data.refreshing ? "refreshing… showing results from " : "as of "}${ago(data.cachedAt)}` : ""} <button class="ghost tb" id="pr-refresh" title="Re-fetch open PRs from GitHub">↻ refresh</button></div>
      ${data.known.length ? `<h3>Continue reviewing</h3><div class="pr-grid">${data.known.map((p) => prCard(p, { known: true })).join("")}</div>` : ""}
      ${requested.length ? `<h3>Review requested from you</h3><div class="pr-grid">${requested.map((p) => prCard(p)).join("")}</div>` : ""}
      ${open.length ? `<h3>Open in ${escapeHtml(data.repo || "")}</h3><div class="pr-grid">${open.map((p) => prCard(p)).join("")}</div>` : data.repo ? "" : `<p class="muted">Set a repository above (or <code>defaultRepo</code> in sift.config.json) to list its open pull requests.</p>`}
    </div>`;
}
function wirePicker(root) {
  const rerender = async (opts) => {
    const holder = root.querySelector(".picker").parentElement;
    const html = await pickerHtml(root.querySelector("#pr-repo-input")?.value.trim() || undefined, opts);
    holder.innerHTML = html;
    wirePicker(holder);
  };
  root.querySelector("#pr-refresh")?.addEventListener("click", () => rerender({ refresh: true }));
  // stale-while-revalidate: if the server is refreshing in the background, pick up the fresh list shortly
  if (pickerHtml.last?.refreshing && !root.dataset.revalidating) {
    root.dataset.revalidating = "1";
    setTimeout(() => rerender({}), 4000);
  }
  root.querySelector("#pr-open-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = root.querySelector("#pr-open-input").value.trim();
    if (!v) return;
    try {
      const res = await api("/api/prs/open", { method: "POST", body: { pr: v.replace(/#/, "/").replace(/^([^/]+)\/([^/]+)\/(\d+)$/, "$1/$2/$3"), url: v } });
      location.href = res.path;
    } catch (err) {
      toast(err.message, "err");
    }
  });
  root.querySelector("#pr-repo-input")?.addEventListener("change", () => rerender({}));
}
async function renderPickerPage() {
  document.title = "Sift";
  $(".pr-ref").textContent = "";
  $("#filterbar").hidden = true;
  $("#actionbar").hidden = true;
  $(".lenses").hidden = true;
  $("#progress").hidden = true;
  $("#btn-sync").hidden = true;
  const main = $("#lens");
  main.innerHTML = `<div class="picker-page"><div class="loading">Loading pull requests…</div></div>`;
  main.querySelector(".picker-page").innerHTML = await pickerHtml();
  wirePicker(main);
  main.querySelector("#pr-open-input")?.focus();
}
async function showPrPicker() {
  dialog({ title: "Switch pull request", body: `<div class="loading">Loading…</div>`, buttons: [{ label: "Close" }] });
  const body = $("#overlay .d-body");
  body.innerHTML = await pickerHtml();
  wirePicker(body);
  body.querySelector("#pr-open-input")?.focus();
}


// ============================================================================
// review threads (existing conversations on this PR and its sub-PRs)
// ============================================================================

async function loadThreads({ refresh = false } = {}) {
  try {
    const d = await api(`/api/threads${refresh ? "?refresh=1" : ""}`);
    const byPath = new Map();
    for (const t of d.threads) {
      if (!t.inPr) continue;
      if (!byPath.has(t.path)) byPath.set(t.path, []);
      byPath.get(t.path).push(t);
    }
    const counts = { humanOpen: 0, botOpen: 0, resolved: 0, total: d.threads.length };
    for (const t of d.threads) {
      if (t.resolved) counts.resolved++;
      else if (t.bot) counts.botOpen++;
      else counts.humanOpen++;
    }
    S.threads = { ...d, counts };
    S.threadsByPath = byPath;
    S.queueCache = null;
    S.tour.list = null;
    renderHeader();
    renderFilterBar();
    if (S.lens === "deck" && S.current) {
      renderRail();
      renderPaneHead();
      renderSide();
      if (S.detail && !S.view.inter && !altView(S.current)?.on) injectThreads($(".pane-body"), S.current);
    } else if (S.lens === "map") renderMap($("#lens"));
    else if (S.lens === "ledger") renderLedger($("#lens"));
  } catch {}
}
function visibleThreads(path) {
  return (S.threadsByPath.get(path) || []).filter((t) => S.showBotThreads || !t.bot);
}
function threadBadge(path) {
  const t = S.threads?.byFile?.[path];
  if (!t) return "";
  const open = S.showBotThreads ? t.open : t.human;
  if (!open && !t.resolved) return "";
  return `<span class="th-badge" title="${t.human} human · ${t.bot} bot · ${t.resolved} resolved">💬${open ? open : ""}${t.resolved && !open ? "✓" : ""}</span>`;
}
function threadChip(path) {
  const t = S.threads?.byFile?.[path];
  if (!t) return "";
  const parts = [];
  if (t.human) parts.push(`<b>${t.human}</b> human`);
  if (t.bot) parts.push(`${t.bot} bot`);
  if (t.resolved) parts.push(`${t.resolved} resolved`);
  return `<button class="pill th-chip" data-act="threads-side" title="Existing review threads on this file (from this PR and the sub-PRs). Click to list them.">💬 ${parts.join(" · ")}</button>`;
}
function threadRowHtml(t, { compact = false } = {}) {
  const first = t.comments[0];
  const replies = t.comments.slice(1);
  const who = (c) => `<span class="th-author ${c.bot ? "bot" : ""}">${c.bot ? "🤖 " : ""}@${escapeHtml(c.author)}</span>`;
  const origin = t.pr ? `<span class="pill tiny" title="${escapeHtml(t.prTitle || "")}">#${t.pr}</span>` : "";
  const flags = `${t.resolved ? '<span class="pill tiny ok">resolved</span>' : ""}${t.outdated ? '<span class="pill tiny">outdated</span>' : ""}${t.approx ? '<span class="pill tiny" title="The code moved since this comment; anchored by matching the commented snippet">≈ line</span>' : ""}`;
  const collapsed = compact || t.resolved || (t.bot && S.threadCollapseBots !== false);
  return `<div class="thread ${t.resolved ? "resolved" : "open"} ${t.bot ? "bot" : "human"}" data-thread="${escapeHtml(t.id)}">
    <details ${collapsed ? "" : "open"}>
      <summary><span class="th-dot"></span>${who(first)} ${origin}${flags}<span class="th-summary">${escapeHtml(t.summary || "")}</span><span class="muted th-time">${ago(first.at)}${replies.length ? ` · ${replies.length} repl${replies.length > 1 ? "ies" : "y"}` : ""}</span><a class="th-link" href="${t.url}" target="_blank" rel="noopener" title="Open on GitHub">↗</a></summary>
      <div class="th-body">${renderMarkdownLite(first.body)}</div>
      ${replies.map((c) => `<div class="th-reply">${who(c)} <span class="muted th-time">${ago(c.at)}</span><div class="th-body">${renderMarkdownLite(c.body)}</div></div>`).join("")}
    </details>
  </div>`;
}
function injectThreads(body, path) {
  if (!body) return;
  body.querySelectorAll("tr.thread-row").forEach((r) => r.remove());
  const list = visibleThreads(path).filter((t) => t.line != null);
  if (!list.length) return;
  const cols = S.view.mode === "split" ? 4 : 3;
  const byLine = new Map();
  for (const t of list) {
    const k = `${t.side || "RIGHT"}:${t.line}`;
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push(t);
  }
  for (const [k, arr] of byLine) {
    const [side, line] = k.split(":");
    let td = body.querySelector(`td.gl[data-side="${side}"][data-line="${line}"]`) || body.querySelector(`td.gl[data-side="RIGHT"][data-line="${line}"]`);
    if (!td) continue;
    const tr = td.closest("tr");
    // place after any note/composer rows that follow the same line
    let anchor = tr;
    while (anchor.nextElementSibling && (anchor.nextElementSibling.classList.contains("note-row") || anchor.nextElementSibling.classList.contains("composer"))) anchor = anchor.nextElementSibling;
    const row = el(`<tr class="thread-row"><td colspan="${cols}">${arr.map((t) => threadRowHtml(t)).join("")}</td></tr>`);
    anchor.after(row);
  }
}
function threadsSideHtml(path) {
  const list = visibleThreads(path);
  const all = S.threadsByPath.get(path) || [];
  if (!all.length) return "";
  return `<div class="side-sec th-sec"><h3><span>Threads <span class="muted">· ${list.length}${all.length !== list.length ? ` of ${all.length}` : ""}</span></span><label class="muted" style="font-weight:400;text-transform:none;letter-spacing:0"><input type="checkbox" id="toggle-bots" ${S.showBotThreads ? "checked" : ""}/> bots</label></h3>
    <div class="th-list">${list
      .sort((a, b) => Number(a.resolved) - Number(b.resolved) || Number(a.bot) - Number(b.bot) || (a.line || 0) - (b.line || 0))
      .map((t) => `<div class="th-item ${t.resolved ? "resolved" : ""}" data-thread-goto="${escapeHtml(t.id)}" title="${escapeHtml(t.summary || "")}"><span class="th-dot ${t.resolved ? "res" : t.bot ? "bot" : "open"}"></span><span class="th-item-text"><span class="th-author ${t.bot ? "bot" : ""}">@${escapeHtml(t.comments[0].author)}</span>${t.pr ? `<span class="muted"> #${t.pr}</span>` : ""} ${escapeHtml((t.summary || "").slice(0, 70))}</span><span class="ln">${t.line != null ? `L${t.line}` : "—"}</span></div>`)
      .join("")}</div></div>`;
}
function scrollToThread(id) {
  const t = (S.threadsByPath.get(S.current) || []).find((x) => x.id === id);
  if (!t) return;
  if (altView(S.current)?.on) {
    S.outlineMode = false;
    S.surfaceMode = false;
    renderPaneHead();
    renderBody().then(() => setTimeout(() => scrollToThread(id), 50));
    return;
  }
  const rowEl = $(`.pane-body .thread[data-thread="${CSS.escape(id)}"]`);
  if (!rowEl) {
    if (t.line != null) return scrollToLine(t.line, t.side || "RIGHT");
    return toast("Thread line is not in this view", "warn");
  }
  rowEl.querySelector("details").open = true;
  const body = $(".pane-body");
  body.scrollTop = Math.max(0, rowEl.closest("tr").offsetTop + tableOffset(rowEl.closest("tr"), body) - body.clientHeight / 3);
  rowEl.classList.add("flash");
  setTimeout(() => rowEl.classList.remove("flash"), 1500);
}
function showThreadsDialog() {
  const d = S.threads;
  if (!d) return toast("Threads not loaded yet");
  const byPr = {};
  for (const t of d.threads) byPr[t.pr] = (byPr[t.pr] || 0) + 1;
  const prLabel = (n) => (n ? `#${n} ${escapeHtml((storyMeta(n)?.title || "").slice(0, 60))}` : "this PR");
  const summaries = d.prLevel.filter((p) => p.kind === "review" && p.body.length > 40).sort((a, b) => b.at.localeCompare(a.at));
  const humanComments = d.prLevel.filter((p) => !p.bot).sort((a, b) => b.at.localeCompare(a.at));
  dialog({
    title: "Review threads & bot reviews",
    body: `<p><b>${d.counts.humanOpen}</b> open human threads · ${d.counts.botOpen} open bot threads · ${d.counts.resolved} resolved · across ${d.prs.length} PRs (this one + merged sub-PRs). Fetched ${ago(d.fetchedAt)}. <button class="ghost tb" data-x="refresh">↻ refresh</button></p>
      <h4>Where</h4><ul>${Object.entries(byPr).sort((a, b) => b[1] - a[1]).map(([pr, n]) => `<li>${prLabel(Number(pr))} — ${n} thread${n > 1 ? "s" : ""}</li>`).join("")}</ul>
      ${humanComments.length ? `<h4>Human comments on the conversation</h4>${humanComments.slice(0, 10).map((p) => `<details class="th-pr"><summary>@${escapeHtml(p.author)} on ${prLabel(p.pr)} · ${ago(p.at)}${p.state ? ` · ${p.state.toLowerCase()}` : ""} <a href="${p.url}" target="_blank" rel="noopener">↗</a></summary><div class="th-body">${renderMarkdownLite(p.body)}</div></details>`).join("")}` : ""}
      ${summaries.length ? `<h4>Review summaries (${summaries.length}, mostly bots)</h4>${summaries.slice(0, 12).map((p) => `<details class="th-pr"><summary>${p.bot ? "🤖 " : ""}@${escapeHtml(p.author)} on ${prLabel(p.pr)} · ${ago(p.at)} · ${escapeHtml(p.state?.toLowerCase() || "")} <a href="${p.url}" target="_blank" rel="noopener">↗</a></summary><div class="th-body">${renderMarkdownLite(p.body.slice(0, 6000))}</div></details>`).join("")}` : ""}
      <p class="muted">Inline threads appear under their lines in the diff; use the <b>Has threads</b> filter to sweep files with open conversations.</p>`,
    buttons: [{ label: "Close" }],
  });
  $("#overlay [data-x=refresh]")?.addEventListener("click", async () => {
    closeOverlay();
    toast("Refreshing threads…");
    await loadThreads({ refresh: true });
    toast("Threads refreshed", "ok");
  });
}

// ============================================================================
// moved code (verbatim moves within the PR)
// ============================================================================

async function loadMoves() {
  try {
    S.moves = await api("/api/moves");
    S.queueCache = null;
    if (S.lens === "deck" && S.current) {
      renderPaneHead();
      if (S.detail && !S.view.inter) renderBody();
    }
  } catch {}
}
function moveChip(f) {
  const m = S.moves?.summary?.[f.path];
  if (!m) return "";
  const srcs = (arr) => arr.slice(0, 2).map((x) => `<span class="mono">${escapeHtml(x.path.split("/").pop())}</span>`).join(", ") + (arr.length > 2 ? ` +${arr.length - 2}` : "");
  const parts = [];
  if (m.moved) parts.push(`<button class="pill mv-chip" data-mv="from" title="${m.moved} of ${m.added} added lines are verbatim copies of lines deleted elsewhere in this PR: ${escapeHtml(m.from.map((x) => `${x.path} (${x.lines})`).join(", "))}">⇄ ${m.pct}% moved from ${srcs(m.from)}</button>`);
  if (m.deleted) {
    const label = m.outPct >= 60 ? `${m.outPct}% of this file lives on in` : m.outPct >= 20 ? `only ${m.outPct}% reused in` : `rewrite — ${m.outPct}% reused in`;
    parts.push(`<button class="pill mv-chip ${m.outPct < 20 ? "warn" : ""}" data-mv="to" title="${m.movedOut} of ${m.deleted} deleted lines reappear verbatim in: ${escapeHtml(m.to.map((x) => `${x.path} (${x.lines})`).join(", "))}">⇄ ${label} ${srcs(m.to)}</button>`);
  }
  return parts.join("");
}
async function loadMoveLines(path) {
  if (!S.moves?.summary?.[path]?.moved) return null;
  if (!S.moveLines.has(path)) {
    const d = await api(`/api/moves?path=${encodeURIComponent(path)}`);
    S.moveLines.set(path, d.lines || {});
  }
  return S.moveLines.get(path);
}
/** Dim moved lines and fold long runs into one row; works for unified and split tables. */
async function applyMoves(body, path) {
  const map = await loadMoveLines(path);
  if (!map || S.current !== path) return;
  const rows = [...body.querySelectorAll("tr.line")];
  const info = rows.map((tr) => {
    const td = tr.querySelector("td.gl.new") || tr.querySelector("td.gl[data-side=RIGHT]");
    const n = td && td.dataset.line ? Number(td.dataset.line) : null;
    const isAdd = tr.classList.contains("add") || tr.querySelector("td.code.add");
    return { tr, n, mv: isAdd && n != null ? map[n] : null };
  });
  for (const r of info) if (r.mv) r.tr.classList.add("moved");
  if (!S.foldMoved) return;
  const cols = S.view.mode === "split" ? 4 : 3;
  let i = 0;
  while (i < info.length) {
    if (!info[i].mv) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < info.length && info[j + 1].mv && info[j + 1].mv.from === info[i].mv.from) j++;
    const run = info.slice(i, j + 1);
    if (run.length >= 4) {
      const from = run[0].mv.from;
      const l1 = run[0].mv.line;
      const l2 = run[run.length - 1].mv.line;
      const fold = el(`<tr class="fold-row"><td colspan="${cols}"><span class="fold-toggle">▸ ${run.length} lines moved verbatim from <span class="mono">${escapeHtml(from)}</span> L${l1}–${l2}</span><button class="tb" data-peek="${escapeHtml(from)}" data-line="${l1}">⧉ peek source</button><span class="muted">L${run[0].n}–${run[run.length - 1].n} here · click to expand</span></td></tr>`);
      run[0].tr.before(fold);
      run.forEach((r) => r.tr.classList.add("folded"));
      fold.querySelector(".fold-toggle").addEventListener("click", () => {
        const open = fold.classList.toggle("open");
        run.forEach((r) => r.tr.classList.toggle("folded", !open));
        fold.querySelector(".fold-toggle").innerHTML = `${open ? "▾" : "▸"} ${run.length} lines moved verbatim from <span class="mono">${escapeHtml(from)}</span> L${l1}–${l2}`;
      });
      fold.querySelector("[data-peek]").addEventListener("click", (e) => {
        e.stopPropagation();
        peek(from, { line: l1, side: "LEFT" });
      });
    }
    i = j + 1;
  }
}


// ============================================================================
// reviewer lint (findings)
// ============================================================================

async function loadLint({ refresh = false } = {}) {
  try {
    const d = await api(`/api/lint${refresh ? "?refresh=1" : ""}`);
    const byPath = new Map();
    for (const x of d.findings) {
      if (!byPath.has(x.path)) byPath.set(x.path, []);
      byPath.get(x.path).push(x);
    }
    S.lint = d;
    S.lintByPath = byPath;
    S.queueCache = null;
    S.tour.list = null;
    renderHeader();
    renderFilterBar();
    if (S.lens === "deck" && S.current) {
      renderRail();
      renderPaneHead();
      renderSide();
      if (S.detail && !S.view.inter && !altView(S.current)?.on) injectLint($(".pane-body"), S.current);
    } else if (S.lens === "map") renderMap($("#lens"));
    else if (S.lens === "ledger") renderLedger($("#lens"));
  } catch {}
}
const LEVEL_ICON = { error: "⛔", warn: "⚠", info: "ⓘ" };
/**
 * Stable key for a finding: path + rule + message + ordinal among identical ones. Line numbers shift
 * when the author pushes, so they are deliberately not part of the key — a dismissal survives a sync.
 */
function findingKey(x) {
  if (x._key) return x._key;
  const same = (S.lintByPath.get(x.path) || []).filter((y) => y.rule === x.rule && y.message === x.message).sort((a, b) => a.line - b.line);
  const ord = Math.max(0, same.indexOf(x));
  x._key = `finding|${x.path}|${x.rule}|${x.message}|${ord}`;
  return x._key;
}
function isDismissed(x) {
  return Boolean(S.dismissed[findingKey(x)]);
}
function activeFindings(path) {
  return (S.lintByPath.get(path) || []).filter((x) => !isDismissed(x));
}
function lintCounts(path) {
  const c = { error: 0, warn: 0, info: 0, dismissed: 0 };
  for (const x of S.lintByPath.get(path) || []) {
    if (isDismissed(x)) c.dismissed++;
    else c[x.level]++;
  }
  return c;
}
function hasActiveFindings(path) {
  const c = S.lint ? lintCounts(path) : null;
  return Boolean(c && (c.error || c.warn));
}
async function dismissFinding(x, { reason = "" } = {}) {
  const key = findingKey(x);
  const onTour = S.tour.idx >= 0 && S.tour.list?.[S.tour.idx]?.kind === "finding" && findingKey(S.tour.list[S.tour.idx].ref) === key;
  try {
    const { dismissed } = await api("/api/dismiss", { method: "POST", body: { key, reason } });
    S.dismissed[key] = dismissed;
    S.queueCache = null;
    S.tour.list = null;
    toast(`Dismissed · ${x.rule}`, "", reason ? reason : onTour ? "Moving on to the next signal." : "Restore it from the Findings list in the inspector.");
    refreshLintViews(x.path);
    if (onTour) {
      // the list just lost this item, so the next signal now sits at the same index
      S.tour.idx -= 1;
      tourStep(1);
    }
  } catch (err) {
    toast(`Could not dismiss: ${err.message}`, "err");
  }
}
async function undismissFinding(key) {
  try {
    await api("/api/dismiss", { method: "DELETE", body: { key } });
    delete S.dismissed[key];
    S.queueCache = null;
    S.tour.list = null;
    const p = key.split("|")[1];
    toast("Finding restored");
    refreshLintViews(p);
  } catch (err) {
    toast(`Could not restore: ${err.message}`, "err");
  }
}
function refreshLintViews(path) {
  renderHeader();
  renderFilterBar();
  if (S.lens === "deck" && S.current) {
    renderRail();
    renderPaneHead();
    renderSide();
    if (path === S.current && S.detail && !S.view.inter && !altView(S.current)?.on) injectLint($(".pane-body"), S.current);
  } else if (S.lens === "map") renderMap($("#lens"));
  else if (S.lens === "ledger") renderLedger($("#lens"));
}
function lintBadge(path) {
  if (!S.lint) return "";
  const l = lintCounts(path);
  if (!l.error && !l.warn) return "";
  return `<span class="lint-badge" title="${l.error} errors · ${l.warn} warnings · ${l.info} info${l.dismissed ? ` · ${l.dismissed} dismissed` : ""}">${l.error ? `<span class="lv-error">⛔${l.error}</span>` : ""}${l.warn ? `<span class="lv-warn">⚠${l.warn}</span>` : ""}</span>`;
}
function lintChip(path) {
  if (!S.lint || !(S.lintByPath.get(path) || []).length) return "";
  const l = lintCounts(path);
  const parts = [];
  if (l.error) parts.push(`<span class="lv-error">⛔ ${l.error}</span>`);
  if (l.warn) parts.push(`<span class="lv-warn">⚠ ${l.warn}</span>`);
  if (l.info) parts.push(`<span class="lv-info">ⓘ ${l.info}</span>`);
  if (!parts.length) parts.push(`<span class="muted">✓ ${l.dismissed} dismissed</span>`);
  return `<button class="pill lint-chip" data-act="lint-side" title="Reviewer-lint findings on the lines this PR adds. Click to list.">${parts.join(" ")}</button>`;
}
function injectLint(body, path) {
  if (!body) return;
  body.querySelectorAll("tr.lint-row").forEach((r) => r.remove());
  body.querySelectorAll("tr.has-finding").forEach((r) => r.classList.remove("has-finding"));
  const list = activeFindings(path).filter((x) => x.line > 1 || !/^(large-file|no-related-test|i18n-unused-new-key|permission-unused-new|large-generated|i18n-removed-key-used)$/.test(x.rule));
  if (!list.length) return;
  const cols = S.view.mode === "split" ? 4 : 3;
  const byLine = new Map();
  for (const x of list) {
    if (!byLine.has(x.line)) byLine.set(x.line, []);
    byLine.get(x.line).push(x);
  }
  for (const [line, arr] of byLine) {
    const td = body.querySelector(`td.gl[data-side="RIGHT"][data-line="${line}"]`);
    if (!td) continue;
    const tr = td.closest("tr");
    tr.classList.add("has-finding");
    const row = el(`<tr class="lint-row"><td colspan="${cols}">${arr.map((x) => `<div class="finding lv-${x.level}" data-fkey="${escapeHtml(findingKey(x))}"><span class="fi">${LEVEL_ICON[x.level]}</span><span class="fr">${escapeHtml(x.rule)}</span><span class="fm">${escapeHtml(x.message)}</span><button class="fx" data-dismiss="${escapeHtml(findingKey(x))}" title="Dismiss: I looked, it's fine (⇧-click to add a reason)">✕</button></div>`).join("")}</td></tr>`);
    row.querySelectorAll("[data-dismiss]").forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const x = arr.find((y) => findingKey(y) === b.dataset.dismiss);
        if (!x) return;
        if (e.shiftKey) {
          const reason = await promptDialog(`Why is "${x.rule}" fine here?`, "");
          if (reason == null) return;
          return dismissFinding(x, { reason });
        }
        dismissFinding(x);
      }),
    );
    tr.after(row);
  }
}
function lintSideHtml(path) {
  const all = S.lintByPath.get(path) || [];
  if (!all.length) return "";
  const list = all.filter((x) => !isDismissed(x));
  const gone = all.filter(isDismissed);
  const order = { error: 0, warn: 1, info: 2 };
  return `<div class="side-sec lint-sec"><h3><span>Findings <span class="muted">· ${list.length}${gone.length ? ` <span title="dismissed">(+${gone.length} dismissed)</span>` : ""}</span></span></h3><div class="th-list">${[...list]
    .sort((a, b) => order[a.level] - order[b.level] || a.line - b.line)
    .map((x) => `<div class="th-item" data-lint-goto="${x.line}" title="${escapeHtml(x.message)}"><span class="fi lv-${x.level}">${LEVEL_ICON[x.level]}</span><span class="th-item-text"><b>${escapeHtml(x.rule)}</b> ${escapeHtml(x.message.slice(0, 80))}</span><span class="ln">L${x.line}</span><button class="fx" data-dismiss-side="${escapeHtml(findingKey(x))}" title="Dismiss (⇧-click to add a reason)">✕</button></div>`)
    .join("")}${gone.length ? `<details class="dismissed-list"><summary class="muted">${gone.length} dismissed</summary>${gone.map((x) => `<div class="th-item dismissed" title="${escapeHtml(S.dismissed[findingKey(x)]?.reason || "")}"><span class="fi muted">✓</span><span class="th-item-text muted"><b>${escapeHtml(x.rule)}</b> ${escapeHtml((S.dismissed[findingKey(x)]?.reason || x.message).slice(0, 70))}</span><span class="ln">L${x.line}</span><button class="fx" data-undismiss="${escapeHtml(findingKey(x))}" title="Restore this finding">↶</button></div>`).join("")}</details>` : ""}</div></div>`;
}
function gotoLine(line) {
  if (altView(S.current)?.on) {
    S.outlineMode = false;
    S.surfaceMode = false;
    renderPaneHead();
    renderBody().then(() => setTimeout(() => scrollToLine(line, "RIGHT"), 50));
    return;
  }
  if (!scrollToLine(line, "RIGHT", { quiet: true })) {
    S.pendingScroll = { line, side: "RIGHT" };
    applyPendingScroll();
  }
}
function showLintDialog() {
  const d = S.lint;
  if (!d) return toast("Findings not loaded yet");
  const active = d.findings.filter((x) => !isDismissed(x));
  const dismissedN = d.findings.length - active.length;
  const byRule = {};
  for (const x of active) (byRule[x.rule] ||= []).push(x);
  const lvl = (rule) => byRule[rule][0].level;
  const order = { error: 0, warn: 1, info: 2 };
  const rules = Object.keys(byRule).sort((a, b) => order[lvl(a)] - order[lvl(b)] || byRule[b].length - byRule[a].length);
  const link = (x) => `<a data-open-finding="${escapeHtml(x.path)}" data-line="${x.line}" class="mono">${escapeHtml(x.path.replace(/^src\//, ""))}:${x.line}</a> <span class="muted">${escapeHtml(x.message.slice(0, 90))}</span>`;
  dialog({
    title: "Findings by rule",
    body: `<p><b>${active.length}</b> findings on lines this PR adds · ${active.filter((x) => x.level === "error").length} errors · ${active.filter((x) => x.level === "warn").length} warnings${dismissedN ? ` · <span class="muted">${dismissedN} dismissed by you</span>` : ""}. Heuristics, not verdicts — each one is a question worth 10 seconds; press <kbd>✕</kbd> on a finding once you've answered it. <button class="ghost tb" data-x="refresh">↻ re-run</button></p>
      ${rules.map((r) => `<details class="ci-cluster" ${lvl(r) === "error" ? "open" : ""}><summary><span class="fi lv-${lvl(r)}">${LEVEL_ICON[lvl(r)]}</span> <b>${byRule[r].length}×</b> ${escapeHtml(d.rules?.[r] || r)} <span class="muted mono">${r}</span></summary><ul>${byRule[r].slice(0, 60).map((x) => `<li>${link(x)}</li>`).join("")}${byRule[r].length > 60 ? `<li class="muted">…and ${byRule[r].length - 60} more</li>` : ""}</ul></details>`).join("")}
      ${d.i18n?.path ? `<h4>i18n · ${escapeHtml(d.i18n.path)}</h4><p class="muted">${d.i18n.catalogSize} keys in catalog · ${d.i18n.added} added · ${d.i18n.removed} removed by this PR${d.i18n.unusedNew.length ? ` · <b>${d.i18n.unusedNew.length} new keys never referenced via t()</b> in changed files` : ""}${d.i18n.removedButUsed.length ? ` · <b style="color:var(--stale)">${d.i18n.removedButUsed.length} removed keys still used</b>` : ""}</p>${d.i18n.unusedNew.length ? `<details><summary class="muted">unused new keys</summary><div class="mono" style="font-size:11.5px;line-height:1.6">${d.i18n.unusedNew.map(escapeHtml).join(", ")}</div></details>` : ""}` : ""}`,
    buttons: [{ label: "Close" }],
  });
  const ov = $("#overlay");
  ov.querySelectorAll("[data-open-finding]").forEach((a) =>
    a.addEventListener("click", () => {
      closeOverlay();
      jumpTo(a.dataset.openFinding, { line: Number(a.dataset.line), side: "RIGHT" });
    }),
  );
  ov.querySelector("[data-x=refresh]")?.addEventListener("click", async () => {
    closeOverlay();
    toast("Re-running reviewer lint…");
    await loadLint({ refresh: true });
    showLintDialog();
  });
}

// ============================================================================
// incremental context: ↑ / ↓ 20 lines around a hunk without switching to the whole file
// ============================================================================

const CTX_STEP = 20;
function wireContextExpanders(body, f, d) {
  if (!body || !d?.hunks?.length || S.view.inter || S.view.full || f.status === "added" || f.status === "removed") return;
  const hunks = d.hunks;
  const split = S.view.mode === "split";
  // per-hunk expansion frontier (new-side line numbers), tracked per render
  const topOf = hunks.map((h) => h.newStart); // first revealed new line at/above hunk i
  let bottom = hunks[hunks.length - 1].newStart + hunks[hunks.length - 1].newLines; // first unrevealed line after the last hunk
  let lines = null;
  const getLines = async () => {
    if (!lines) lines = (await loadContent(f.path)).replace(/\n$/, "").split("\n");
    return lines;
  };
  const rowHtml = (n, o, html) =>
    split
      ? `<tr class="line ctx-x"><td class="gl old ctx" data-side="LEFT" data-line="${o}">${o}</td><td class="code ctx" data-side="LEFT" data-line="${o}">${html}</td><td class="gl new ctx" data-side="RIGHT" data-line="${n}">${n}</td><td class="code ctx" data-side="RIGHT" data-line="${n}">${html}</td></tr>`
      : `<tr class="line ctx ctx-x" data-side="RIGHT" data-line="${n}"><td class="gl old" data-side="LEFT" data-line="${o}">${o}</td><td class="gl new" data-side="RIGHT" data-line="${n}">${n}</td><td class="code"><span class="sign"> </span>${html}</td></tr>`;
  const rowsFor = (from, to, delta) => {
    // new-side lines [from, to], old = new + delta
    const chunk = lines.slice(from - 1, to);
    const hl = highlightToLines(chunk.join("\n"), f.language);
    return chunk.map((t, i) => rowHtml(from + i, from + i + delta, hl[i] ?? escapeHtml(t))).join("");
  };
  const gapAbove = (hi) => topOf[hi] - (hi === 0 ? 1 : hunks[hi - 1].newStart + hunks[hi - 1].newLines);
  const label = (hi) => {
    const head = body.querySelector(`tr.hunk[data-hunk="${hi}"] .hunk-head`);
    if (!head) return;
    head.querySelector(".ctx-ex")?.remove();
    const gap = gapAbove(hi);
    const last = hi === hunks.length - 1;
    const parts = [];
    if (gap > 0) parts.push(`<button class="tb" data-ex="up" data-h="${hi}" title="Show ${Math.min(CTX_STEP, gap)} more lines above">↑ ${Math.min(CTX_STEP, gap)}</button>${gap > CTX_STEP ? `<button class="tb" data-ex="all" data-h="${hi}" title="Show all ${gap} unchanged lines between the hunks">↕ all ${gap}</button>` : ""}`);
    if (last && bottom != null) parts.push(`<button class="tb" data-ex="down" data-h="${hi}" title="Show ${CTX_STEP} more lines below the last hunk">↓ ${CTX_STEP}</button>`);
    if (!parts.length) return;
    head.insertAdjacentHTML("beforeend", `<span class="ctx-ex">${parts.join("")}${gap > 0 ? `<span class="muted">${gap} unchanged line${gap === 1 ? "" : "s"} hidden</span>` : ""}</span>`);
  };
  hunks.forEach((_, hi) => label(hi));
  if (body._ctxHandler) body.removeEventListener("click", body._ctxHandler);
  body._ctxHandler = async (e) => {
    const b = e.target.closest("button[data-ex]");
    if (!b) return;
    e.stopPropagation();
    const hi = Number(b.dataset.h);
    const h = hunks[hi];
    await getLines();
    if (S.current !== f.path) return;
    const head = body.querySelector(`tr.hunk[data-hunk="${hi}"]`);
    if (!head) return;
    if (b.dataset.ex === "down") {
      const from = bottom;
      const to = Math.min(lines.length, bottom + CTX_STEP - 1);
      if (from > lines.length) {
        bottom = null;
        return label(hi);
      }
      const delta = h.oldStart + h.oldLines - (h.newStart + h.newLines);
      const tbody = head.closest("tbody");
      const last = [...tbody.querySelectorAll("tr")].pop();
      last.insertAdjacentHTML("afterend", rowsFor(from, to, delta));
      bottom = to + 1 > lines.length ? null : to + 1;
      return label(hi);
    }
    const gap = gapAbove(hi);
    if (gap <= 0) return;
    const take = b.dataset.ex === "all" ? gap : Math.min(CTX_STEP, gap);
    const to = topOf[hi] - 1;
    const from = to - take + 1;
    const delta = h.oldStart - h.newStart;
    // earlier lines are inserted later, so "right after the header" keeps the file order
    head.insertAdjacentHTML("afterend", rowsFor(from, to, delta));
    topOf[hi] = from;
    label(hi);
  };
  body.addEventListener("click", body._ctxHandler);
}

// ============================================================================
// hunk coverage: "reviewed" should mean every hunk was actually on screen
// ============================================================================

function seenSet(f) {
  const key = `${f.path}:${f.sha}`;
  if (!S.seenLocal.has(key)) S.seenLocal.set(key, new Set(f.review?.seen?.sha === f.sha ? f.review.seen.hunks : []));
  return S.seenLocal.get(key);
}
function coverageOf(path) {
  const f = S.byPath.get(path);
  if (!f) return null;
  const c = S.detailCache.get(path);
  const total = (c && c.sha === f.sha ? c.detail.hunks?.length : null) ?? f.review?.seen?.total ?? 0;
  if (!total) return null;
  const seen = Math.min(total, seenSet(f).size);
  return { seen, total, unseen: total - seen };
}
function coverageHtml(path) {
  const c = coverageOf(path);
  if (!c) return "";
  const pct = Math.round((100 * c.seen) / c.total);
  return `<span class="hunk-cov ${c.unseen ? "" : "done"}" title="${c.seen} of ${c.total} hunks have been on screen${c.unseen ? ` — ${c.unseen} not yet` : ""}. Scroll through a hunk to mark it seen."><i style="--pct:${pct}%"></i><span>${c.seen}/${c.total} seen</span></span>`;
}
/** Watch sentinel rows per patch hunk; a hunk counts as seen once its first, last and every 25th row were visible. */
function observeHunks(body, f, hunks) {
  S.seenObserver?.disconnect();
  S.seenObserver = null;
  if (!body || !hunks?.length || S.view.inter) return;
  const local = seenSet(f);
  const rows = [...body.querySelectorAll("tr.line")];
  const inHunk = (r) => {
    const right = r.querySelector('td.gl[data-side="RIGHT"]')?.dataset.line;
    const left = r.querySelector('td.gl[data-side="LEFT"]')?.dataset.line;
    const n = right ? Number(right) : null;
    const o = left ? Number(left) : null;
    for (let i = 0; i < hunks.length; i++) {
      const h = hunks[i];
      if (n != null && h.newLines > 0 && n >= h.newStart && n < h.newStart + h.newLines) return i;
      if (n == null && o != null && o >= h.oldStart && o < h.oldStart + h.oldLines) return i;
    }
    return -1;
  };
  const byHunk = new Map();
  for (const r of rows) {
    const hi = inHunk(r);
    if (hi < 0) continue;
    if (!byHunk.has(hi)) byHunk.set(hi, []);
    byHunk.get(hi).push(r);
  }
  const sentinels = new Map(); // element -> hunk index
  const need = new Map(); // hunk index -> sentinels still unseen
  for (let hi = 0; hi < hunks.length; hi++) {
    if (local.has(hi)) continue;
    const rs = byHunk.get(hi) || [];
    if (!rs.length) {
      local.add(hi); // nothing rendered for it (e.g. folded entirely) — nothing to see
      continue;
    }
    const picks = new Set([0, rs.length - 1]);
    for (let i = 25; i < rs.length - 1; i += 25) picks.add(i);
    let count = 0;
    for (const i of picks) {
      let elx = rs[i];
      if (elx.classList.contains("folded")) {
        // moved-code fold: seeing the fold row counts as seeing the lines it hides
        let p = elx.previousElementSibling;
        while (p && !p.classList.contains("fold-row")) p = p.previousElementSibling;
        if (p) elx = p;
      }
      if (sentinels.has(elx)) continue;
      sentinels.set(elx, hi);
      count++;
    }
    need.set(hi, count);
  }
  updateCoverageUi(f.path);
  if (!sentinels.size) return;
  const io = new IntersectionObserver(
    (entries) => {
      let changed = false;
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const hi = sentinels.get(en.target);
        if (hi == null) continue;
        io.unobserve(en.target);
        sentinels.delete(en.target);
        const left = (need.get(hi) || 1) - 1;
        need.set(hi, left);
        if (left <= 0 && !local.has(hi)) {
          local.add(hi);
          changed = true;
        }
      }
      if (changed) {
        updateCoverageUi(f.path);
        queueSeenSave(f, hunks.length);
      }
    },
    { root: body, threshold: 0.4 },
  );
  for (const elx of sentinels.keys()) io.observe(elx);
  S.seenObserver = io;
}
function updateCoverageUi(path) {
  if (path !== S.current) return;
  const slot = $(".pane-head .cov-slot");
  if (slot) slot.innerHTML = coverageHtml(path);
}
function queueSeenSave(f, total) {
  clearTimeout(S.seenTimer);
  S.seenPending = { path: f.path, sha: f.sha, total };
  S.seenTimer = setTimeout(flushSeen, 1500);
}
async function flushSeen() {
  clearTimeout(S.seenTimer);
  const p = S.seenPending;
  if (!p) return;
  S.seenPending = null;
  const f = S.byPath.get(p.path);
  if (!f || f.sha !== p.sha) return;
  try {
    const res = await api("/api/seen", { method: "POST", body: { path: p.path, sha: p.sha, hunks: [...seenSet(f)], total: p.total } });
    if (res.file) {
      // keep the local set authoritative for this tab; the server copy is the union
      const keep = S.seenLocal.get(`${p.path}:${p.sha}`);
      updateFile(res.file);
      if (keep) S.seenLocal.set(`${p.path}:${p.sha}`, keep);
    }
  } catch {}
}
window.addEventListener("pagehide", () => {
  const p = S.seenPending;
  if (!p) return;
  const f = S.byPath.get(p.path);
  if (!f) return;
  navigator.sendBeacon?.(withPr("/api/seen"), new Blob([JSON.stringify({ path: p.path, sha: p.sha, hunks: [...seenSet(f)], total: p.total })], { type: "application/json" }));
});

// ============================================================================
// attention tour: ⇧J / ⇧K hop across everything that wants a human decision
// (active findings, open threads, failing tests, stale files) in queue order
// ============================================================================

const TOUR_KINDS = [
  ["finding", "findings"],
  ["human", "human threads"],
  ["bot", "bot threads"],
  ["test", "failing tests"],
  ["stale", "stale files"],
];
function tourKinds() {
  return S.tourKinds || (S.tourKinds = { finding: true, human: true, bot: false, test: true, stale: true, ...(prefs.tourKinds || {}) });
}
function tourList() {
  const kinds = tourKinds();
  const key = [S.order, JSON.stringify(S.filter), S.showBotThreads, JSON.stringify(kinds), S.ci?.run?.id || "", S.lint?.headSha || "", S.threads?.fetchedAt || "", Object.keys(S.dismissed).length].join("|");
  if (S.tour.list && S.tour.key === key) return S.tour.list;
  const q = queue();
  const pos = new Map(q.map((f, i) => [f.path, i]));
  const items = [];
  const seen = new Set();
  const push = (s) => {
    const k = `${s.kind}:${s.path}:${s.line ?? ""}:${s.id ?? ""}`;
    if (seen.has(k) || !pos.has(s.path)) return;
    seen.add(k);
    items.push({ ...s, pos: pos.get(s.path) });
  };
  const failingByFile = new Map();
  for (const c of S.ci?.clusters || []) for (const t of c.tests) (failingByFile.get(t.file) || failingByFile.set(t.file, []).get(t.file)).push(t);
  for (const f of q) {
    if (kinds.stale && f.stale) push({ kind: "stale", path: f.path, line: null, label: "changed since your review", level: "warn" });
    if (kinds.finding) for (const x of activeFindings(f.path)) if (x.level !== "info") push({ kind: "finding", path: f.path, line: x.line, side: "RIGHT", label: `${x.rule} — ${x.message}`, level: x.level, ref: x });
    for (const t of visibleThreads(f.path)) {
      if (t.resolved || t.line == null || !(t.bot ? kinds.bot : kinds.human)) continue;
      push({ kind: "thread", path: f.path, line: t.line, side: t.side || "RIGHT", id: t.id, label: `@${t.comments[0].author}: ${(t.summary || "").slice(0, 90)}`, level: t.bot ? "info" : "warn" });
    }
    if (kinds.test) {
      const c = S.ci?.byFile?.[f.path];
      if (c && (c.failed || c.flaky)) {
        // one signal per spec: the outline opens with every failing test expanded
        const first = (failingByFile.get(f.path) || []).sort((a, b) => a.line - b.line)[0];
        push({ kind: "test", path: f.path, line: first?.line ?? null, label: `${c.failed ? `${c.failed} failed` : ""}${c.failed && c.flaky ? " · " : ""}${c.flaky ? `${c.flaky} flaky` : ""}${first ? ` — ${first.title}` : ""}`, level: c.failed ? "error" : "warn", test: true });
      }
    }
  }
  items.sort((a, b) => a.pos - b.pos || (a.line ?? -1) - (b.line ?? -1) || a.kind.localeCompare(b.kind));
  S.tour.list = items;
  S.tour.key = key;
  if (S.tour.idx >= items.length) S.tour.idx = -1;
  return items;
}
const SIGNAL_ICON = { finding: "⚠", thread: "💬", test: "✗", stale: "⟲" };
function tourStep(dir) {
  const list = tourList();
  if (!list.length) return toast("No signals in this queue", "ok", "Findings, open threads, failing tests and stale files are all clear here.");
  let idx = S.tour.idx;
  if (idx < 0) {
    // start from the current file: the first signal in it or after it
    const cp = S.current ? queueIndex(S.current) : -1;
    const curLine = currentTopLine();
    idx = list.findIndex((s) => s.pos > cp || (s.pos === cp && (s.line ?? 0) >= curLine));
    if (idx < 0) idx = 0;
    if (dir < 0) idx = (idx - 1 + list.length) % list.length;
  } else {
    idx += dir;
    if (idx >= list.length) {
      idx = 0;
      toast("Back to the first signal", "", `${list.length} in this queue`);
    } else if (idx < 0) idx = list.length - 1;
  }
  S.tour.idx = idx;
  gotoSignal(list[idx]);
  renderTourBar();
}
/** Approximate top visible new-side line of the diff, so the tour starts where the eyes are. */
function currentTopLine() {
  const body = $(".pane-body");
  if (!body) return 0;
  const top = body.getBoundingClientRect().top;
  for (const td of body.querySelectorAll('td.gl[data-side="RIGHT"]')) {
    if (td.getBoundingClientRect().bottom > top && td.dataset.line) return Number(td.dataset.line);
  }
  return 0;
}
function gotoSignal(s) {
  if (!S.byPath.has(s.path)) return;
  const here = S.lens === "deck" && s.path === S.current && S.detail?.path === s.path;
  if (s.kind === "test") {
    S.outlineMode = true;
    S.pendingScroll = s.line != null ? { line: s.line, test: true } : null;
    if (!here) return navigate("deck", s.path);
    if (altView(s.path)?.on && S.bodyKey === bodyKey(S.detail)) return applyPendingScroll();
    renderPaneHead();
    return renderBody();
  }
  if (s.kind === "stale") {
    if (!here) navigate("deck", s.path);
    return;
  }
  if (s.kind === "thread") {
    if (here) return scrollToThread(s.id);
    S.pendingScroll = { line: s.line, side: s.side, thread: s.id };
    return navigate("deck", s.path);
  }
  S.pendingScroll = { line: s.line, side: s.side || "RIGHT" };
  if (here) return applyPendingScroll();
  navigate("deck", s.path);
}
function renderTourBar() {
  const pane = $(".pane");
  if (!pane) return;
  let bar = pane.querySelector(".tour-bar");
  const list = S.tour.idx >= 0 ? tourList() : [];
  const s = S.tour.idx >= 0 ? list[S.tour.idx] : null;
  if (!s) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = el(`<div class="tour-bar"></div>`);
    pane.appendChild(bar);
  }
  bar.innerHTML = `<span class="tb-n">⚡ ${S.tour.idx + 1}/${list.length}</span><span class="tb-sig lv-${s.level}">${SIGNAL_ICON[s.kind]} ${escapeHtml(s.label.slice(0, 110))}</span>${s.line != null ? `<span class="muted">L${s.line}</span>` : ""}<span class="sp"></span><button class="ghost" data-x="prev" title="Previous signal (⇧K)">⇧K</button><button class="ghost" data-x="next" title="Next signal (⇧J)">⇧J</button><button class="ghost" data-x="list" title="All signals in this queue">list</button><button class="ghost" data-x="close" title="Leave the tour (Esc)">✕</button>`;
  bar.querySelector("[data-x=prev]").addEventListener("click", () => tourStep(-1));
  bar.querySelector("[data-x=next]").addEventListener("click", () => tourStep(1));
  bar.querySelector("[data-x=list]").addEventListener("click", showTourDialog);
  bar.querySelector("[data-x=close]").addEventListener("click", endTour);
}
function endTour() {
  S.tour.idx = -1;
  renderTourBar();
}
function showTourDialog() {
  const list = tourList();
  const kinds = tourKinds();
  const byKind = { finding: 0, thread: 0, test: 0, stale: 0 };
  for (const s of list) byKind[s.kind]++;
  const groups = [];
  let last = null;
  for (const [i, s] of list.entries()) {
    if (s.path !== last) {
      groups.push({ path: s.path, items: [] });
      last = s.path;
    }
    groups[groups.length - 1].items.push([i, s]);
  }
  const scoped = S.filter.status !== "all" || S.filter.story != null || S.filter.tier != null || S.filter.area || S.filter.q;
  dialog({
    title: `⚡ Attention list · ${list.length} signal${list.length === 1 ? "" : "s"} in this queue`,
    body: `<p class="muted">${byKind.finding} findings · ${byKind.thread} open threads · ${byKind.test} specs with failures · ${byKind.stale} stale files — in queue order${scoped ? ", scoped by the current filters" : ""}. <kbd>⇧J</kbd>/<kbd>⇧K</kbd> walk through them from wherever you are; dismiss findings with ✕ once answered.</p>
      <div class="tour-kinds">${TOUR_KINDS.map(([k, l]) => `<label><input type="checkbox" data-kind="${k}" ${kinds[k] ? "checked" : ""}/> ${l}</label>`).join("")}</div>
      ${list.length ? groups.map((g) => `<div class="tour-grp"><div class="tour-file mono">${escapeHtml(g.path)} <span class="muted">· ${g.items.length}</span></div>${g.items.map(([i, s]) => `<div class="th-item ${i === S.tour.idx ? "cur" : ""}" data-tour-idx="${i}"><span class="fi lv-${s.level}">${SIGNAL_ICON[s.kind]}</span><span class="th-item-text">${escapeHtml(s.label.slice(0, 120))}</span><span class="ln">${s.line != null ? `L${s.line}` : "file"}</span></div>`).join("")}</div>`).join("") : `<div class="empty-state"><h2>All clear</h2>Nothing in this queue is asking for attention${Object.values(kinds).every(Boolean) ? "" : " (with the kinds selected above)"}.</div>`}`,
    buttons: [{ label: "Close" }],
  });
  const ov = $("#overlay");
  ov.querySelectorAll("[data-kind]").forEach((cb) =>
    cb.addEventListener("change", () => {
      kinds[cb.dataset.kind] = cb.checked;
      S.tour.list = null;
      S.tour.idx = -1;
      savePrefs();
      renderHeader();
      renderTourBar();
      showTourDialog();
    }),
  );
  ov.querySelectorAll("[data-tour-idx]").forEach((n) =>
    n.addEventListener("click", () => {
      closeOverlay();
      S.tour.idx = Number(n.dataset.tourIdx);
      gotoSignal(list[S.tour.idx]);
      renderTourBar();
    }),
  );
}

// ============================================================================
// surface view (API shape of a source file), i18n keys view, go-to-definition
// ============================================================================

async function loadSurface(path) {
  const f = S.byPath.get(path);
  const key = `${path}:${f.sha}`;
  if (!S.surfaceCache.has(key)) S.surfaceCache.set(key, await api(`/api/surface?path=${encodeURIComponent(path)}`));
  return S.surfaceCache.get(key);
}
async function renderSurfaceBody(body, f) {
  body.innerHTML = `<div class="loading">Reading module…</div>`;
  let sf;
  let rel = null;
  try {
    [sf, rel] = await Promise.all([loadSurface(f.path), S.relatedCache.get(`${f.path}@${S.snap.pr.headSha}`) || api(`/api/related?path=${encodeURIComponent(f.path)}`).catch(() => null)]);
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h2>Couldn't build surface</h2>${escapeHtml(err.message)}<br/><br/><button data-act="outline:off">Show code</button></div>`;
    body.querySelector("[data-act]").addEventListener("click", () => runAction("outline:off"));
    return;
  }
  if (S.current !== f.path) return;
  if (!sf.ok) {
    body.innerHTML = `<div class="empty-state"><h2>Couldn't parse this file</h2>${escapeHtml(sf.error || "")}<br/><br/><button data-act="outline:off">Show code</button></div>`;
    body.querySelector("[data-act]").addEventListener("click", () => runAction("outline:off"));
    return;
  }
  const usedBy = new Map();
  if (rel?.status === "ready") for (const u of rel.usedBy) for (const n of u.names) usedBy.set(n, (usedBy.get(n) || 0) + 1);
  const chg = (c) => (c === "new" ? '<span class="chg new">new</span>' : c === "modified" ? '<span class="chg mod">modified</span>' : "");
  const item = (line, html, extra = "") => `<div class="sf-item" data-line="${line}" title="L${line} — click to peek, ⌘-click to open the code here"><span class="sf-t">${html}</span>${extra}<span class="ln">L${line}</span></div>`;
  const sec = (title, n, inner, { open = true, hint = "" } = {}) => (n ? `<details class="rel-group sf-group" ${open ? "open" : ""}><summary>${title} <span class="n">${n}</span>${hint ? `<span class="muted hint">${hint}</span>` : ""}</summary>${inner}</details>` : "");
  const exportsHtml = sf.exports
    .map((e) => {
      const name = e.kind === "default" ? `<i>default</i> ${escapeHtml(e.name)}` : escapeHtml(e.name);
      const sig = e.props ? ` <span class="sf-props">{ ${e.props.slice(0, 10).map(escapeHtml).join(", ")}${e.props.length > 10 ? ", …" : ""} }</span>` : e.propsType ? ` <span class="sf-props">: ${escapeHtml(e.propsType)}</span>` : e.params ? ` <span class="sf-props">(${e.params.map(escapeHtml).join(", ")})</span>` : e.members ? ` <span class="sf-props">{ ${e.members.slice(0, 8).map(escapeHtml).join(", ")}${e.members.length > 8 ? ", …" : ""} }</span>` : e.value ? ` <span class="sf-props">= ${escapeHtml(e.value)}</span>` : "";
      const uses = usedBy.get(e.kind === "default" ? "default" : e.name) || 0;
      return item(e.line, `<span class="sf-kind">${escapeHtml(e.kind)}</span> <b>${name}</b>${sig}`, `${chg(e.change)}<span class="pill tiny ${uses ? "" : "unused"}" title="files in this PR importing this symbol">×${uses}</span>`);
    })
    .join("");
  const internals = sf.functions.filter((fn) => !fn.exported);
  const internalsHtml = internals.map((fn) => item(fn.line, `<span class="sf-kind">${fn.kind}</span> ${escapeHtml(fn.name)}${fn.params?.length ? ` <span class="sf-props">(${fn.params.map(escapeHtml).join(", ")})</span>` : ""}`, chg(fn.change))).join("");
  const hooks = Object.entries(sf.hooksUsed).sort((a, b) => Number(a[1].builtin) - Number(b[1].builtin) || b[1].count - a[1].count);
  const hooksHtml = hooks.map(([h, v]) => item(v.lines[0], `${v.builtin ? "" : '<span class="sf-kind">custom</span> '}${escapeHtml(h)} <span class="muted">×${v.count}</span>`)).join("");
  const effectsHtml = sf.effects.map((e) => item(e.line, `useEffect`)).join("");
  const dataHtml = [...sf.queries.map((q) => item(q.line, `<span class="sf-kind">query</span> <span class="mono">${escapeHtml(q.text)}</span>`)), ...sf.mutations.map((q) => item(q.line, `<span class="sf-kind">mutation</span> <span class="mono">${escapeHtml(q.text)}</span>`)), ...Object.entries(sf.apis).map(([k, v]) => item(v.line, `<span class="sf-kind">api</span> <span class="mono">${escapeHtml(k)}</span> <span class="muted">×${v.count}</span>`))].join("");
  const i18n = Object.entries(sf.i18nKeys);
  const i18nHtml = i18n.map(([k, v]) => item(v.line, `<span class="mono">${escapeHtml(k)}</span>${v.count > 1 ? ` <span class="muted">×${v.count}</span>` : ""}`)).join("");
  const renders = /\.(tsx|jsx)$/.test(f.path) ? sf.renders : [];
  const rendersHtml = renders.length ? `<div class="rel-exports">${renders.map((r) => `<span class="sym">${escapeHtml(r.name)}<span class="n">×${r.count}</span></span>`).join("")}</div>` : "";
  const typesHtml = sf.types.filter((t) => !t.exported).map((t) => item(t.line, `<span class="sf-kind">${t.kind}</span> ${escapeHtml(t.name)} <span class="sf-props">{ ${t.members.slice(0, 8).map(escapeHtml).join(", ")}${t.memberCount > 8 ? ", …" : ""} }</span>`)).join("");
  const routesHtml = sf.routes.map((r) => item(r.line, `<span class="mono">${escapeHtml(r.route)}</span>`)).join("");
  const permsHtml = sf.permissions.map((r) => item(r.line, `<span class="mono">${escapeHtml(r.name)}</span>`)).join("");
  const testIdsHtml = sf.testIds.map((r) => item(r.line, `<span class="mono">${escapeHtml(r.id)}</span>`)).join("");
  const todosHtml = sf.todos.map((r) => item(r.line, escapeHtml(r.text))).join("");

  body.innerHTML = `<div class="outline surface">
    <div class="ol-bar"><b>${sf.lines}</b> lines · ${sf.exports.length} export${sf.exports.length === 1 ? "" : "s"} · ${sf.components.length} component${sf.components.length === 1 ? "" : "s"} · ${sf.functions.length} function${sf.functions.length === 1 ? "" : "s"} · ${sf.imports} imports · ${hooks.filter(([, v]) => !v.builtin).length} custom hooks · ${sf.effects.length} effect${sf.effects.length === 1 ? "" : "s"}<span class="sp"></span><span class="muted">click an item to peek its code · ⌥-click any identifier in the diff to peek its definition</span></div>
    ${sec("Exports", sf.exports.length, exportsHtml, { hint: "×N = importers in this PR" })}
    ${rendersHtml ? `<div class="rel-group-static"><div class="rel-title">Renders</div>${rendersHtml}</div>` : ""}
    ${sec("Data access", sf.queries.length + sf.mutations.length + Object.keys(sf.apis).length, dataHtml)}
    ${sec("Hooks", hooks.length, hooksHtml, { open: hooks.some(([, v]) => !v.builtin) })}
    ${sec("Effects", sf.effects.length, effectsHtml, { hint: "review hotspots" })}
    ${sec("Internal functions", internals.length, internalsHtml, { open: internals.length <= 12 })}
    ${sec("Internal types", sf.types.filter((t) => !t.exported).length, typesHtml, { open: false })}
    ${sec("i18n keys", i18n.length, i18nHtml, { open: false })}
    ${sec("Routes", sf.routes.length, routesHtml)}
    ${sec("Permissions", sf.permissions.length, permsHtml)}
    ${sec("Test ids", sf.testIds.length, testIdsHtml, { open: false })}
    ${sec("TODOs", sf.todos.length, todosHtml)}
  </div>`;
  body.scrollTop = 0;
  body.onclick = (e) => {
    const it = e.target.closest(".sf-item");
    if (!it) return;
    const line = Number(it.dataset.line);
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      S.surfaceMode = false;
      S.pendingScroll = { line, side: "RIGHT" };
      savePrefs();
      renderPaneHead();
      renderBody();
    } else peek(f.path, { line, side: "RIGHT" });
  };
}

async function renderKeysBody(body, f) {
  body.innerHTML = `<div class="loading">Reading keys…</div>`;
  let d;
  try {
    const key = `${f.path}:${f.sha}`;
    if (!S.keysCache.has(key)) S.keysCache.set(key, await api(`/api/i18n?path=${encodeURIComponent(f.path)}`));
    d = S.keysCache.get(key);
  } catch (err) {
    body.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (S.current !== f.path) return;
  const groups = new Map();
  for (const e of d.entries) {
    const g = e.key.split(/[_.]/)[0] || "(other)";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const counts = { new: 0, changed: 0, removed: 0, unused: 0 };
  for (const e of d.entries) {
    counts[e.status]++;
    if (e.status === "new" && !e.uses.length) counts.unused++;
  }
  const row = (e) => `<tr class="k-${e.status} ${e.status !== "removed" && !e.uses.length ? "unused" : ""}"><td class="mono k">${escapeHtml(e.key)}</td><td class="st"><span class="chg ${e.status === "new" ? "new" : e.status === "changed" ? "mod" : "rem"}">${e.status}</span></td><td class="v">${e.status === "changed" ? `<s class="muted">${escapeHtml(e.old)}</s> → ` : ""}${e.value != null ? escapeHtml(e.value) : `<s class="muted">${escapeHtml(e.old)}</s>`}</td><td class="u">${e.uses.length ? e.uses.slice(0, 3).map((u) => `<a data-path="${escapeHtml(u.path)}" data-line="${u.line}" title="${escapeHtml(u.path)}:${u.line}">${escapeHtml(u.path.split("/").pop())}:${u.line}</a>`).join(" ") + (e.uses.length > 3 ? ` <span class="muted">+${e.uses.length - 3}</span>` : "") : e.status === "removed" ? '<span class="muted" title="Searched only the files changed by this PR">no use found in changed files</span>' : '<span class="lv-warn" title="Searched only the files changed by this PR">no use found in changed files</span>'}</td></tr>`;
  body.innerHTML = `<div class="outline keys">
    <div class="ol-bar"><b>${d.entries.length}</b> keys touched · <span class="chg new">${counts.new} new</span> <span class="chg mod">${counts.changed} changed</span> <span class="chg rem">${counts.removed} removed</span>${counts.unused ? ` · <span class="lv-warn">${counts.unused} new keys without a t() use in changed files</span>` : ""}<span class="sp"></span><span class="muted">grouped by prefix · click a usage to jump</span></div>
    ${[...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([g, arr]) => `<details class="rel-group" open><summary>${escapeHtml(g)} <span class="n">${arr.length}</span></summary><table class="keys-table"><thead><tr><th>key</th><th></th><th>value</th><th>used in</th></tr></thead><tbody>${arr.map(row).join("")}</tbody></table></details>`).join("")}
  </div>`;
  body.scrollTop = 0;
  body.onclick = (e) => {
    const a = e.target.closest("a[data-path]");
    if (!a) return;
    if (e.shiftKey) return peek(a.dataset.path, { line: Number(a.dataset.line), side: "RIGHT" });
    jumpTo(a.dataset.path, { line: Number(a.dataset.line), side: "RIGHT" });
  };
}

function wordAtPoint(x, y) {
  let range = null;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    range = { node: pos.offsetNode, offset: pos.offset };
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (!r) return null;
    range = { node: r.startContainer, offset: r.startOffset };
  }
  if (!range || range.node.nodeType !== Node.TEXT_NODE) return null;
  const text = range.node.textContent;
  const isId = (c) => /[\w$]/.test(c);
  let a = range.offset;
  let b = range.offset;
  while (a > 0 && isId(text[a - 1])) a--;
  while (b < text.length && isId(text[b])) b++;
  // identifiers can span adjacent highlight spans; extend across siblings
  let word = text.slice(a, b);
  if (a === 0) {
    let prev = range.node.previousSibling || range.node.parentNode?.previousSibling;
    while (prev && prev.textContent && isId(prev.textContent.slice(-1))) {
      const m = prev.textContent.match(/[\w$]+$/);
      word = m[0] + word;
      if (m[0].length < prev.textContent.length) break;
      prev = prev.previousSibling;
    }
  }
  if (b === text.length) {
    let next = range.node.nextSibling || range.node.parentNode?.nextSibling;
    while (next && next.textContent && isId(next.textContent[0])) {
      const m = next.textContent.match(/^[\w$]+/);
      word += m[0];
      if (m[0].length < next.textContent.length) break;
      next = next.nextSibling;
    }
  }
  return /^[A-Za-z_$][\w$]*$/.test(word) ? word : null;
}
async function gotoDefinition(name, { jump = false } = {}) {
  if (!S.current) return;
  let d;
  try {
    d = await api(`/api/def?path=${encodeURIComponent(S.current)}&name=${encodeURIComponent(name)}`);
  } catch (err) {
    return toast(err.message, "err");
  }
  const r = d.results[0];
  if (!r) return toast(`No definition of "${name}" found in this PR`, "warn");
  if (r.kind === "local") {
    if (jump) return gotoLine(r.line);
    return peek(S.current, { line: r.line, side: "RIGHT" });
  }
  if (r.kind === "import" && !r.inPr) return peek(r.path, { line: r.line, side: "RIGHT" });
  if (jump) return jumpTo(r.path, { line: r.line, side: "RIGHT" });
  peek(r.path, { line: r.line, side: "RIGHT" });
  if (d.results.length > 1) toast(`${d.results.length} candidates for "${name}" — showing ${r.path.split("/").pop()}`);
}


// ============================================================================
// local git extras: churn + repo-wide impact
// ============================================================================

async function loadGitx(path) {
  let d = S.gitx.get(path);
  if (!d) {
    try {
      d = await api(`/api/gitx?path=${encodeURIComponent(path)}`);
      S.gitx.set(path, d);
    } catch {
      return;
    }
  }
  if (S.current !== path) return;
  const slot = $("#gitx-slot");
  if (!slot || !d.available) return;
  const churn = d.churn;
  const churnHtml = churn
    ? `<div class="rel-group-static"><div class="rel-title">History <span class="muted hint">on the base branch, last 6 months</span></div><div class="gitx-churn ${churn.commits >= 8 ? "hot" : ""}">${churn.commits >= 8 ? "🔥 " : ""}${churn.commits} commit${churn.commits === 1 ? "" : "s"} by ${churn.authors.length} author${churn.authors.length === 1 ? "" : "s"}${churn.last ? ` · last touched ${ago(churn.last)}` : ""}<div class="muted" style="font-size:11px">${churn.authors.slice(0, 5).map(escapeHtml).join(", ")}${churn.authors.length > 5 ? ` +${churn.authors.length - 5}` : ""}</div></div></div>`
    : S.byPath.get(path)?.status === "added"
      ? ""
      : `<div class="rel-group-static"><div class="rel-title">History</div><div class="muted" style="font-size:12px">No commits on the base branch in the last 6 months — stable code being changed.</div></div>`;
  const impactHtml = d.impact?.length
    ? `<details class="rel-group" open><summary>Repo impact <span class="n">${d.impact.reduce((n, x) => n + x.count, 0)}</span><span class="muted hint">references outside this PR to symbols this file exports</span></summary>${d.impact
        .map((x) => `<div class="gitx-sym"><span class="mono">${escapeHtml(x.name)}</span> <span class="muted">· ${x.count} ref${x.count > 1 ? "s" : ""} in ${x.files} unchanged file${x.files > 1 ? "s" : ""}</span><div class="gitx-hits">${x.hits.slice(0, 8).map((h) => `<a data-repo-path="${escapeHtml(h.path)}" data-line="${h.line}" title="${escapeHtml(h.text)}">${escapeHtml(h.path.replace(/^src\//, ""))}:${h.line}</a>`).join(" ")}${x.hits.length > 8 ? ` <span class="muted">+${x.hits.length - 8}</span>` : ""}</div></div>`)
        .join("")}</details>`
    : d.impact && (S.byPath.get(path)?.status === "modified" || S.byPath.get(path)?.status === "renamed")
      ? `<div class="rel-group-static"><div class="rel-title">Repo impact</div><div class="muted" style="font-size:12px">No references to this file's exports outside the PR.</div></div>`
      : "";
  slot.innerHTML = churnHtml + impactHtml;
  slot.querySelectorAll("[data-repo-path]").forEach((a) => a.addEventListener("click", () => peek(a.dataset.repoPath, { line: Number(a.dataset.line), side: "RIGHT" })));
  const chipHolder = $(".pane-head .ph-row:nth-child(2)");
  if (chipHolder && churn && churn.commits >= 8 && !chipHolder.querySelector(".hot-chip")) {
    const c = el(`<span class="pill hot-chip" title="${churn.commits} commits by ${churn.authors.length} authors on the base branch in the last 6 months — frequently changed code">🔥 hot file</span>`);
    chipHolder.querySelector(".sp")?.before(c);
  }
}


// ============================================================================
// NOTES lens — everything you've written, across files
// ============================================================================

const NOTE_FILTERS = [["all", "All"], ["unpublished", "Unpublished"], ["published", "Published"], ["issue", "Issues"], ["question", "Questions"], ["changed", "File changed since"], ["line", "Line-anchored"], ["file", "File-level"], ["flagged", "On flagged files"]];
S.notesFilter = S.notesFilter || "all";
S.notesQuery = S.notesQuery || "";
S.notesSort = S.notesSort || "path";

function renderNotes(main) {
  const droppedFiles = (S.snap.dropped || []).filter((d) => d.review?.notes?.length).map((d) => ({ ...d, review: { ...d.review, noteCount: d.review.notes.length }, dropped: true, sha: d.sha || "", additions: d.additions || 0, deletions: d.deletions || 0 }));
  const files = [...S.snap.files.filter((f) => f.review?.notes?.length), ...droppedFiles];
  const allNotes = files.flatMap((f) => f.review.notes.map((n) => ({ ...n, file: f })));
  const q = S.notesQuery.trim().toLowerCase();
  const pass = (n) => {
    switch (S.notesFilter) {
      case "unpublished": if (n.publishedAt) return false; break;
      case "published": if (!n.publishedAt) return false; break;
      case "line": if (n.line == null) return false; break;
      case "file": if (n.line != null) return false; break;
      case "flagged": if (statusOf(n.file) !== "flagged") return false; break;
      case "issue": if (n.kind !== "issue") return false; break;
      case "question": if (n.kind !== "question") return false; break;
      case "changed": if (!changedSince(n, n.file)) return false; break;
      default: break;
    }
    if (q && !n.text.toLowerCase().includes(q) && !n.file.path.toLowerCase().includes(q)) return false;
    return true;
  };
  const visible = allNotes.filter(pass);
  const counts = { all: allNotes.length, unpublished: allNotes.filter((n) => !n.publishedAt).length, published: allNotes.filter((n) => n.publishedAt).length, line: allNotes.filter((n) => n.line != null).length, file: allNotes.filter((n) => n.line == null).length, flagged: allNotes.filter((n) => statusOf(n.file) === "flagged").length, issue: allNotes.filter((n) => n.kind === "issue").length, question: allNotes.filter((n) => n.kind === "question").length, changed: allNotes.filter((n) => changedSince(n, n.file)).length };
  const byFile = new Map();
  for (const n of visible) {
    if (!byFile.has(n.file.path)) byFile.set(n.file.path, []);
    byFile.get(n.file.path).push(n);
  }
  const groups = [...byFile.entries()].sort((a, b) => (S.notesSort === "recent" ? latest(b[1]).localeCompare(latest(a[1])) : S.notesSort === "story" ? storyRank(a[0]) - storyRank(b[0]) || a[0].localeCompare(b[0]) : a[0].localeCompare(b[0])));
  const flaggedNoNotes = S.snap.files.filter((f) => statusOf(f) === "flagged" && !f.review?.notes?.length);

  const noteItem = (n) => `<div class="nt-note ${n.publishedAt ? "pub" : ""}" data-path="${escapeHtml(n.file.path)}" data-id="${n.id}" ${n.line != null ? `data-line="${n.line}" data-side="${n.side || "RIGHT"}"` : ""}>
      <div class="nt-anchor">${n.line != null ? `<a class="mono" data-jump>L${n.line}${n.endLine && n.endLine !== n.line ? `–${n.endLine}` : ""}${n.side === "LEFT" ? " old" : ""}</a>` : `<span class="muted">file</span>`}<div>${kindBadge(n)}</div></div>
      <div class="nt-body">${noteHtml(n.text)}</div>
      <div class="nt-meta"><span class="muted">${ago(n.at)}${n.editedAt ? " · edited" : ""}</span>${n.publishedAt ? publishedBadge(n, "ci-ok") : '<span class="muted">draft</span>'}${changedSince(n, n.file) ? `<span class="lv-warn" title="The file changed after this note — maybe addressed">file changed since</span>` : ""}<span class="sp"></span><button class="ghost" data-edit>edit</button><button class="ghost" data-del>delete</button></div>
    </div>`;
  const fileGroup = (path, notes) => {
    const f = S.byPath.get(path) || notes[0]?.file;
    const [dir, base] = splitPath(path);
    return `<section class="nt-file ${f.dropped ? "nt-dropped" : ""}">
      <header ${f.dropped ? "" : `data-open="${escapeHtml(path)}"`}><span class="pill s-${statusOf(f)} ${f.stale ? "stale" : ""}">${f.dropped ? "no longer in PR" : f.stale ? "stale" : STATUS_LABEL[statusOf(f)]}</span><span class="ph-path"><span class="dir">${escapeHtml(dir)}</span><span class="base">${escapeHtml(base)}</span></span>${S.stories ? `<span class="muted">${escapeHtml(storyLabel(storyOf(path), { short: true }))}</span>` : ""}<span class="sp"></span><span class="pm"><span class="a">+${f.additions}</span> <span class="d">−${f.deletions}</span></span><span class="muted">${notes.length} note${notes.length === 1 ? "" : "s"}</span></header>
      ${notes.sort((a, b) => (a.line ?? -1) - (b.line ?? -1)).map(noteItem).join("")}
    </section>`;
  };

  main.innerHTML = `<section class="notes-lens">
    <div class="nt-bar">
      <input type="search" id="nt-q" placeholder="Search notes and paths…" value="${escapeHtml(S.notesQuery)}" />
      <div class="chips">${NOTE_FILTERS.map(([k, l]) => `<button class="chip ${S.notesFilter === k ? "on" : ""}" data-nf="${k}">${l}<span class="n">${counts[k]}</span></button>`).join("")}</div>
      <select id="nt-sort" title="Order"><option value="path" ${S.notesSort === "path" ? "selected" : ""}>by path</option><option value="recent" ${S.notesSort === "recent" ? "selected" : ""}>most recent first</option>${S.stories ? `<option value="story" ${S.notesSort === "story" ? "selected" : ""}>by story</option>` : ""}</select>
      <span class="sp"></span>
      <span class="muted">${visible.length} of ${allNotes.length} notes · ${files.length} files${counts.unpublished ? ` · <b>${counts.unpublished}</b> unpublished` : ""}</span>
      <button data-act="export">⇩ Export .md</button>
      <button class="primary" data-act="publish" ${counts.unpublished ? "" : "disabled"}>↑ Publish ${counts.unpublished || ""} to GitHub</button>
    </div>
    ${groups.length ? groups.map(([p, ns]) => fileGroup(p, ns)).join("") : `<div class="empty-state"><h2>${allNotes.length ? "No notes match" : "No notes yet"}</h2>${allNotes.length ? "Try another filter." : "In the Deck, click a line number to anchor a note, or press <kbd>C</kbd> for a file-level note. Flagging a file (<kbd>F</kbd>) asks you why."}</div>`}
    ${flaggedNoNotes.length ? `<section class="nt-file nt-warn"><header><span class="pill s-flagged">Flagged</span><b>${flaggedNoNotes.length} flagged file${flaggedNoNotes.length > 1 ? "s" : ""} without a note</b><span class="muted"> — future you will not remember why</span></header>${flaggedNoNotes.map((f) => `<div class="nt-note"><div class="nt-anchor"></div><div class="nt-body mono" style="font-size:12px"><a data-open="${escapeHtml(f.path)}">${escapeHtml(f.path)}</a></div><div class="nt-meta"><span class="muted">${f.review?.at ? ago(f.review.at) : ""}</span></div></div>`).join("")}</section>` : ""}
  </section>`;

  main.querySelector("#nt-q").addEventListener("input", debounce((e) => { S.notesQuery = e.target.value; renderNotes(main); const i = main.querySelector("#nt-q"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 150));
  main.querySelectorAll("[data-nf]").forEach((b) => b.addEventListener("click", () => { S.notesFilter = b.dataset.nf; renderNotes(main); }));
  main.querySelector("#nt-sort").addEventListener("change", (e) => { S.notesSort = e.target.value; renderNotes(main); });
  main.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => runAction(b.dataset.act)));
  main.querySelectorAll(".nt-file > header[data-open], a[data-open]").forEach((h) => h.addEventListener("click", () => openFile(h.dataset.open)));
  main.querySelectorAll(".nt-note").forEach((el2) => {
    const path = el2.dataset.path;
    const id = el2.dataset.id;
    el2.querySelector("[data-jump]")?.addEventListener("click", (e) => { e.stopPropagation(); jumpTo(path, { line: Number(el2.dataset.line), side: el2.dataset.side }); });
    el2.querySelector("[data-edit]")?.addEventListener("click", (e) => { e.stopPropagation(); editNote(id, path); });
    el2.querySelector("[data-del]")?.addEventListener("click", (e) => { e.stopPropagation(); deleteNote(id, path); });
    el2.querySelector(".nt-body")?.addEventListener("click", () => (el2.dataset.line ? jumpTo(path, { line: Number(el2.dataset.line), side: el2.dataset.side }) : openFile(path)));
  });
}
function latest(notes) {
  return notes.reduce((m, n) => (n.at > m ? n.at : m), "");
}
