// Diff parsing + rendering. No framework; emits HTML strings for speed on 3k-line files.

export function parsePatch(text) {
  const hunks = [];
  if (!text) return hunks;
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline is not a context line
  let h = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
      if (!m) continue;
      h = {
        header: raw,
        context: m[5] || "",
        oldStart: Number(m[1]),
        oldLines: m[2] == null ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] == null ? 1 : Number(m[4]),
        lines: [],
      };
      oldNo = h.oldStart;
      newNo = h.newStart;
      hunks.push(h);
      continue;
    }
    if (!h) continue;
    if (raw.startsWith("\\")) {
      const last = h.lines[h.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    const c = raw[0];
    const text = raw.slice(1);
    if (c === "+") h.lines.push({ type: "add", text, oldNo: null, newNo: newNo++ });
    else if (c === "-") h.lines.push({ type: "del", text, oldNo: oldNo++, newNo: null });
    else if (c === " " || raw === "") h.lines.push({ type: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
  }
  return hunks;
}

// ---------- syntax highlighting with stable per-line output ----------

const hl = () => (typeof window !== "undefined" && window.hljs) || null;

export function highlightToLines(text, language) {
  const lib = hl();
  if (!text) return [];
  const plain = text.split("\n").map(escapeHtml);
  if (!lib || !language || language === "plaintext" || text.length > 1_500_000) return plain;
  let html;
  try {
    html = lib.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return plain;
  }
  const out = [];
  const open = [];
  let cur = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      const end = html.indexOf(">", i);
      const tag = html.slice(i, end + 1);
      if (tag.startsWith("</")) open.pop();
      else open.push(tag);
      cur += tag;
      i = end + 1;
    } else if (ch === "\n") {
      cur += "</span>".repeat(open.length);
      out.push(cur);
      cur = open.join("");
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  cur += "</span>".repeat(open.length);
  out.push(cur);
  return out.length === plain.length ? out : plain;
}

// ---------- word-level change marks ----------

function pairChanges(lines) {
  // Within a hunk, group consecutive del lines followed by add lines; pair the i-th of each.
  const pairs = new Map(); // index -> {other, ranges}
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "del") {
      i++;
      continue;
    }
    const dels = [];
    while (i < lines.length && lines[i].type === "del") dels.push(i++);
    const adds = [];
    while (i < lines.length && lines[i].type === "add") adds.push(i++);
    const n = Math.min(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const a = lines[dels[k]].text;
      const b = lines[adds[k]].text;
      if (a.length + b.length > 4000) continue;
      const r = wordRanges(a, b);
      if (!r) continue;
      pairs.set(dels[k], r.del);
      pairs.set(adds[k], r.add);
    }
  }
  return pairs;
}

function wordRanges(a, b) {
  const D = typeof window !== "undefined" && window.Diff;
  if (!D) return null;
  const parts = D.diffWordsWithSpace(a, b);
  const del = [];
  const add = [];
  let pa = 0;
  let pb = 0;
  let changed = 0;
  for (const p of parts) {
    const len = p.value.length;
    if (p.added) {
      add.push([pb, pb + len]);
      pb += len;
      changed += len;
    } else if (p.removed) {
      del.push([pa, pa + len]);
      pa += len;
      changed += len;
    } else {
      pa += len;
      pb += len;
    }
  }
  // If nearly everything changed, marks are noise.
  if (changed > 0.75 * (a.length + b.length)) return null;
  return { del: merge(del), add: merge(add) };
}

function merge(ranges) {
  const out = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/** Wrap plain-text offset ranges inside already-escaped/highlighted HTML with <mark>. */
export function markRanges(html, ranges, cls) {
  if (!ranges || !ranges.length) return html;
  let out = "";
  let pos = 0;
  let ri = 0;
  let inMark = false;
  let i = 0;
  const openMark = () => {
    out += `<mark class="${cls}">`;
    inMark = true;
  };
  const closeMark = () => {
    out += "</mark>";
    inMark = false;
  };
  while (i < html.length) {
    while (ri < ranges.length && pos >= ranges[ri][1]) ri++;
    const r = ranges[ri];
    const ch = html[i];
    if (ch === "<") {
      const end = html.indexOf(">", i);
      const tag = html.slice(i, end + 1);
      if (inMark) closeMark();
      out += tag;
      if (r && pos >= r[0] && pos < r[1]) openMark();
      i = end + 1;
      continue;
    }
    let unit;
    if (ch === "&") {
      const end = html.indexOf(";", i);
      unit = end > i && end - i < 10 ? html.slice(i, end + 1) : ch;
    } else unit = ch;
    const shouldMark = r && pos >= r[0] && pos < r[1];
    if (shouldMark && !inMark) openMark();
    if (!shouldMark && inMark) closeMark();
    out += unit;
    pos++;
    i += unit.length;
  }
  if (inMark) closeMark();
  return out;
}

// ---------- rendering ----------

/**
 * opts: { mode: 'unified'|'split', language, words: bool, notes: [{id,line,side,endLine,text}], fullContent: string|null, fileStatus }
 * Returns { html, hunkCount }.
 */
export function renderDiff(hunks, opts) {
  const { mode = "unified", language = "plaintext", words = true, notes = [], fullContent = null, fileStatus } = opts;
  if (fullContent != null && fileStatus !== "added") hunks = expandToFullFile(hunks, fullContent, fileStatus);

  // Highlight each side as one document so multi-line tokens survive.
  const newText = [];
  const oldText = [];
  const newIdx = [];
  const oldIdx = [];
  hunks.forEach((h, hi) =>
    h.lines.forEach((l, li) => {
      if (l.type !== "del") {
        newIdx.push([hi, li]);
        newText.push(l.text);
      }
      if (l.type !== "add") {
        oldIdx.push([hi, li]);
        oldText.push(l.text);
      }
    }),
  );
  const newHtml = highlightToLines(newText.join("\n"), language);
  const oldHtml = highlightToLines(oldText.join("\n"), language);
  newIdx.forEach(([hi, li], k) => (hunks[hi].lines[li].html = newHtml[k] ?? escapeHtml(hunks[hi].lines[li].text)));
  oldIdx.forEach(([hi, li], k) => {
    const l = hunks[hi].lines[li];
    if (l.type === "del") l.html = oldHtml[k] ?? escapeHtml(l.text);
  });

  if (words) {
    for (const h of hunks) {
      const pairs = pairChanges(h.lines);
      for (const [idx, ranges] of pairs) {
        const l = h.lines[idx];
        l.html = markRanges(l.html, ranges, l.type === "del" ? "w-del" : "w-add");
      }
    }
  }

  const notesByKey = new Map();
  for (const n of notes) {
    if (n.line == null) continue;
    const key = `${n.side || "RIGHT"}:${n.endLine || n.line}`;
    if (!notesByKey.has(key)) notesByKey.set(key, []);
    notesByKey.get(key).push(n);
  }

  const t = mode === "split" ? renderSplit(hunks, notesByKey) : renderUnified(hunks, notesByKey);
  // `rows` lets the caller insert very large tables progressively (first screen now, the rest in idle chunks).
  return { html: t.open + t.rows.join("") + t.close, open: t.open, rows: t.rows, close: t.close, hunkCount: hunks.length };
}

function noteRow(notes, cols) {
  if (!notes || !notes.length) return "";
  return notes
    .map(
      (n) =>
        `<tr class="note-row" data-note-id="${n.id}"><td colspan="${cols}"><div class="inline-note">` +
        `<span class="inline-note-anchor">L${n.line}${n.endLine && n.endLine !== n.line ? `–${n.endLine}` : ""}${n.side === "LEFT" ? " old" : ""}${n.kind ? ` <span class="kind-badge k-${n.kind}">${n.kind}</span>` : ""}</span>` +
        `<div class="inline-note-text">${escapeHtml(n.text).replace(/```suggestion\n([\s\S]*?)```/g, '<div class="sugg"><div class="sugg-h">suggested change</div><pre>$1</pre></div>').replace(/```(\w*)\n([\s\S]*?)```/g, "<pre>$2</pre>")}</div>` +
        `<span class="inline-note-actions"><button data-act="edit-note" data-id="${n.id}" title="Edit">✎</button><button data-act="del-note" data-id="${n.id}" title="Delete">✕</button></span>` +
        `${n.publishedAt ? (n.remote?.url ? `<a class="inline-note-pub" href="${escapeHtml(n.remote.url)}" target="_blank" rel="noopener" title="Published to GitHub — open the comment">↑ published ↗</a>` : '<span class="inline-note-pub" title="Published to GitHub">↑ published</span>') : ""}` +
        `</div></td></tr>`,
    )
    .join("");
}

function renderUnified(hunks, notesByKey) {
  const parts = [];
  hunks.forEach((h, hi) => {
    parts.push(
      `<tr class="hunk${h.lead ? " lead" : ""}" data-hunk="${hi}"><td class="gl" colspan="2"></td><td class="hunk-head"><span class="hunk-range">${escapeHtml(h.header.replace(/ @@.*$/, " @@"))}</span><span class="hunk-ctx">${escapeHtml(h.context)}</span></td></tr>`,
    );
    for (const l of h.lines) {
      const side = l.type === "del" ? "LEFT" : "RIGHT";
      const no = l.type === "del" ? l.oldNo : l.newNo;
      parts.push(
        `<tr class="line ${l.type}" data-side="${side}" data-line="${no}">` +
          `<td class="gl old" data-side="LEFT" data-line="${l.oldNo ?? ""}">${l.oldNo ?? ""}</td>` +
          `<td class="gl new" data-side="RIGHT" data-line="${l.newNo ?? ""}">${l.newNo ?? ""}</td>` +
          `<td class="code"><span class="sign">${l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>${l.html}${l.noNewline ? '<span class="nonl" title="No newline at end of file">⏎̸</span>' : ""}</td></tr>`,
      );
      const nr = noteRow(notesByKey.get(`${side}:${no}`), 3);
      if (nr) parts.push(nr);
    }
  });
  return { open: '<table class="diff unified"><colgroup><col class="c-gl" /><col class="c-gl" /><col class="c-code" /></colgroup><tbody>', rows: parts, close: "</tbody></table>" };
}

function renderSplit(hunks, notesByKey) {
  // Explicit column widths: with table-layout: fixed the first row (a colspan hunk header) would
  // otherwise make the browser hand the right-hand gutter a full code-column width.
  const parts = [];
  hunks.forEach((h, hi) => {
    parts.push(
      `<tr class="hunk${h.lead ? " lead" : ""}" data-hunk="${hi}"><td class="gl"></td><td class="hunk-head" colspan="3"><span class="hunk-range">${escapeHtml(h.header.replace(/ @@.*$/, " @@"))}</span><span class="hunk-ctx">${escapeHtml(h.context)}</span></td></tr>`,
    );
    const rows = pairRows(h.lines);
    for (const [L, R] of rows) {
      const lc = L ? L.type : "empty";
      const rc = R ? R.type : "empty";
      parts.push(
        `<tr class="line">` +
          `<td class="gl old ${lc}" data-side="LEFT" data-line="${L?.oldNo ?? ""}">${L?.oldNo ?? ""}</td>` +
          `<td class="code ${lc}" data-side="LEFT" data-line="${L?.oldNo ?? ""}">${L ? L.html : ""}</td>` +
          `<td class="gl new ${rc}" data-side="RIGHT" data-line="${R?.newNo ?? ""}">${R?.newNo ?? ""}</td>` +
          `<td class="code ${rc}" data-side="RIGHT" data-line="${R?.newNo ?? ""}">${R ? R.html : ""}</td></tr>`,
      );
      const ln = L ? noteRow(notesByKey.get(`LEFT:${L.oldNo}`), 4) : "";
      const rn = R ? noteRow(notesByKey.get(`RIGHT:${R.newNo}`), 4) : "";
      if (ln) parts.push(ln);
      if (rn) parts.push(rn);
    }
  });
  return { open: '<table class="diff split"><colgroup><col class="c-gl" /><col class="c-code" /><col class="c-gl" /><col class="c-code" /></colgroup><tbody>', rows: parts, close: "</tbody></table>" };
}

function pairRows(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === "ctx") {
      rows.push([l, l]);
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push([dels[k] || null, adds[k] || null]);
    if (!dels.length && !adds.length) i++;
  }
  return rows;
}

/** Turn hunks + full new-side content into one hunk covering the whole file (context everywhere). */
export function expandToFullFile(hunks, content, fileStatus) {
  const lines = content.replace(/\n$/, "").split("\n");
  if (fileStatus === "removed") {
    return [{ header: `@@ -1,${lines.length} +0,0 @@`, context: "", oldStart: 1, newStart: 0, lines: lines.map((t, i) => ({ type: "del", text: t, oldNo: i + 1, newNo: null })) }];
  }
  const adds = new Map(); // newNo -> line
  const delsBefore = new Map(); // newNo -> [del lines] inserted before that new line
  const delsAtEnd = [];
  for (const h of hunks) {
    let pendingDels = [];
    let nextNew = h.newStart;
    for (const l of h.lines) {
      if (l.type === "del") pendingDels.push(l);
      else {
        if (pendingDels.length) {
          delsBefore.set(nextNew, (delsBefore.get(nextNew) || []).concat(pendingDels));
          pendingDels = [];
        }
        if (l.type === "add") adds.set(l.newNo, l);
        nextNew = l.newNo + 1;
      }
    }
    if (pendingDels.length) {
      if (nextNew <= lines.length) delsBefore.set(nextNew, (delsBefore.get(nextNew) || []).concat(pendingDels));
      else delsAtEnd.push(...pendingDels);
    }
  }
  const out = [];
  let oldNo = 1;
  const markers = [];
  let inChange = false;
  const mark = () => {
    if (!inChange) markers.push(out.length);
    inChange = true;
  };
  for (let n = 1; n <= lines.length; n++) {
    const d = delsBefore.get(n);
    if (d) {
      mark();
      for (const l of d) out.push({ type: "del", text: l.text, oldNo: oldNo++, newNo: null });
    }
    const a = adds.get(n);
    if (a) {
      mark();
      out.push({ type: "add", text: lines[n - 1], oldNo: null, newNo: n });
    } else {
      inChange = false;
      out.push({ type: "ctx", text: lines[n - 1], oldNo: oldNo++, newNo: n });
    }
  }
  if (delsAtEnd.length) {
    mark();
    for (const l of delsAtEnd) out.push({ type: "del", text: l.text, oldNo: oldNo++, newNo: null });
  }
  // One pseudo-hunk per change block so hunk navigation still works in full-file mode.
  const starts = dedupeConsecutive(markers);
  if (!starts.length) return [{ header: `@@ -1,${lines.length} +1,${lines.length} @@`, context: "whole file", oldStart: 1, newStart: 1, lines: out }];
  const result = [];
  if (starts[0] > 0) result.push({ header: "", context: "top of file", oldStart: 1, newStart: 1, lines: out.slice(0, starts[0]), lead: true });
  starts.forEach((s, idx) => {
    const seg = out.slice(s, idx + 1 < starts.length ? starts[idx + 1] : out.length);
    const first = seg[0];
    result.push({
      header: `@@ -${first.oldNo ?? "·"} +${first.newNo ?? "·"} @@`,
      context: "",
      oldStart: first.oldNo ?? 0,
      newStart: first.newNo ?? 0,
      lines: seg,
    });
  });
  return result;
}

function dedupeConsecutive(arr) {
  const out = [];
  for (const x of arr) if (out[out.length - 1] !== x) out.push(x);
  return out;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
