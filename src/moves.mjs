// Moved-code detection: find added lines that are verbatim copies of lines deleted elsewhere in the
// same PR (file moves, splits, extractions) so reviewers can fold them and focus on genuinely new code.
import fs from "node:fs/promises";
import path from "node:path";

const K = 3; // shingle size in non-trivial lines
const MIN_BLOCK = 2;

export class Moves {
  constructor(ctx) {
    this.ctx = ctx;
    this.file = path.join(ctx.store.dir, "moves.json");
    this.data = null;
    this.building = null;
  }

  invalidate() {
    if (this.data && this.data.headSha !== this.ctx.store.state.pr?.headSha) this.data = null;
  }

  async load() {
    try {
      const d = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (d.version === 2 && d.headSha === this.ctx.store.state.pr?.headSha) this.data = d;
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
    const store = this.ctx.store;
    const files = Object.values(store.files);
    // Make sure every file has a patch (the 2–3 oversized ones are computed from blobs).
    for (const f of files) if (!f.patch) await store.patchFor(f.path).catch(() => null);

    const deleted = []; // per file: [{ path, lines: [{ no, text, norm }] }]
    const added = [];
    for (const f of files) {
      if (!f.patch) continue;
      const { dels, adds } = splitPatch(f.patch);
      if (dels.length) deleted.push({ path: f.path, lines: dels });
      if (adds.length) added.push({ path: f.path, lines: adds });
    }

    // index shingles of deleted lines; shingles that occur in many places are boilerplate, not moves
    const index = new Map(); // key -> [{ path, lines }]
    const occurrences = new Map();
    for (const d of deleted) {
      const nt = d.lines.filter((l) => !l.trivial);
      for (let i = 0; i + K <= nt.length; i++) {
        const key = nt[i].norm + "\n" + nt[i + 1].norm + "\n" + nt[i + 2].norm;
        occurrences.set(key, (occurrences.get(key) || 0) + 1);
        let arr = index.get(key);
        if (!arr) index.set(key, (arr = []));
        if (arr.length < 8) arr.push({ path: d.path, lines: [nt[i].no, nt[i + 1].no, nt[i + 2].no] });
      }
    }
    for (const [key, n] of occurrences) if (n > 3) index.delete(key);

    const summary = {};
    const lineMaps = {};
    const toward = {}; // deleted path -> { addedPath: count }
    for (const a of added) {
      const nt = a.lines.filter((l) => !l.trivial);
      const map = {}; // newNo -> { from, line }
      for (let i = 0; i + K <= nt.length; i++) {
        const key = nt[i].norm + "\n" + nt[i + 1].norm + "\n" + nt[i + 2].norm;
        const hits = index.get(key);
        if (!hits) continue;
        // prefer a hit that continues the previous mapping (same source, consecutive lines)
        const prev = map[nt[i].no - 1] || map[nt[i - 1]?.no];
        let hit = hits.find((h) => h.path !== a.path && prev && h.path === prev.from && h.lines[0] > prev.line && h.lines[0] - prev.line <= 4) || hits.find((h) => h.path !== a.path) || null;
        if (!hit) continue;
        for (let k = 0; k < K; k++) {
          const l = nt[i + k];
          if (!map[l.no]) map[l.no] = { from: hit.path, line: hit.lines[k] };
        }
      }
      // fill trivial lines sandwiched between moved lines from the same source
      const nos = a.lines.map((l) => l.no);
      for (let j = 1; j < nos.length - 1; j++) {
        const l = a.lines[j];
        if (!l.trivial || map[l.no]) continue;
        const before = map[nos[j - 1]];
        const after = map[nos[j + 1]];
        if (before && after && before.from === after.from && after.line - before.line >= 2 && after.line - before.line <= 6) map[l.no] = { from: before.from, line: before.line + 1, filled: true };
      }
      // keep only runs of ≥3 consecutive moved lines from the same source (drops incidental overlaps)
      const sortedNos = Object.keys(map).map(Number).sort((x, y) => x - y);
      let run = [];
      const flush = () => {
        if (run.length < 3) for (const n of run) delete map[n];
        run = [];
      };
      for (let j = 0; j < sortedNos.length; j++) {
        const n = sortedNos[j];
        const prevN = run[run.length - 1];
        if (prevN != null && (n !== prevN + 1 || map[n].from !== map[prevN].from || map[n].line <= map[prevN].line - 2 || map[n].line > map[prevN].line + 6)) flush();
        run.push(n);
      }
      flush();
      const movedNos = Object.keys(map).map(Number);
      const moved = movedNos.length;
      const total = a.lines.length;
      if (!moved) continue;
      const from = {};
      for (const n of movedNos) from[map[n].from] = (from[map[n].from] || 0) + 1;
      for (const [src, n] of Object.entries(from)) (toward[src] ||= {})[a.path] = ((toward[src] ||= {})[a.path] || 0) + n;
      summary[a.path] = { added: total, moved, pct: Math.round((100 * moved) / total), from: Object.entries(from).sort((x, y) => y[1] - x[1]).map(([p, n]) => ({ path: p, lines: n })) };
      lineMaps[a.path] = map;
    }
    for (const d of deleted) {
      const t = toward[d.path];
      if (!t) continue;
      const movedOut = Object.values(t).reduce((x, y) => x + y, 0);
      const s = (summary[d.path] ||= { added: 0, moved: 0, pct: 0, from: [] });
      s.deleted = d.lines.length;
      s.movedOut = movedOut;
      s.outPct = Math.round((100 * Math.min(movedOut, d.lines.length)) / Math.max(1, d.lines.length));
      s.to = Object.entries(t).sort((x, y) => y[1] - x[1]).map(([p, n]) => ({ path: p, lines: n }));
    }
    this.data = { version: 2, headSha: store.state.pr.headSha, builtAt: new Date().toISOString(), summary, lineMaps };
    await fs.writeFile(this.file, JSON.stringify(this.data));
    return this.data;
  }
}

function splitPatch(patch) {
  const dels = [];
  const adds = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      continue;
    }
    if (raw.startsWith("\\")) continue;
    const c = raw[0];
    const text = raw.slice(1);
    if (c === "-") {
      dels.push(mk(oldNo, text));
      oldNo++;
    } else if (c === "+") {
      adds.push(mk(newNo, text));
      newNo++;
    } else {
      oldNo++;
      newNo++;
    }
  }
  return { dels, adds };
}
function mk(no, text) {
  const norm = text.trim(); // re-indentation still matches; whitespace inside the line (e.g. string literals) must be identical
  const trivial = norm.length < 10 || /^(import\b|\} from ["']|export \* from|"use client")/.test(norm) || /^[{}()[\];,.]*$/.test(norm) || /^(\}|\);|\},|\];|\)\s*;?|else\s*\{|return;?|break;|continue;|<\/[\w.]+>|export \{|\/\/.*|\*\/|\/\*\*?)$/.test(norm);
  return { no, text, norm, trivial };
}
export { MIN_BLOCK };
