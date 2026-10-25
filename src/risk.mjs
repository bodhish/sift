// Structural risk: where a mistake would hurt, judged by the shape of the change rather than its size.
// Uses the cross-reference graph (who imports what, which specs exercise what) plus cheap path/status cues.
import { isSource, isTest } from "./xref.mjs";

const SENSITIVE_RE = /(auth|permission|security|token|session|secret|crypto|payment|billing|consent|audit)/i;
const WIRING_RE = /(\/Routers?\/|\/routes\/|\/config\/|^vite\.config|^package\.json$|^\.github\/)/i;

/**
 * Returns { ready, headSha, byPath: { path: { score, reasons, importers, exports, tests } } }.
 * Scores are 0–100-ish; ≥ 40 is "read this one twice".
 */
export function computeRisk(ctx) {
  const { store, xref } = ctx;
  const g = xref?.graph;
  if (!g) return { ready: false };
  const byPath = {};
  for (const f of Object.values(store.files)) {
    const p = f.path;
    const reasons = [];
    let score = 0;
    const node = g.files[p];
    const importers = (g.usedBy[p] || []).length;
    const former = (g.formerImporters[p] || []).length;
    const exports = node ? node.exports.length : 0;
    const tests = (g.tests[p] || []).length;
    const src = isSource(p) && !isTest(p);
    const changes = f.changes || 0;

    if (src) {
      if (importers) {
        score += Math.log2(1 + importers) * 12;
        reasons.push(`imported by ${importers} changed file${importers === 1 ? "" : "s"}`);
      }
      if (exports && f.status !== "removed") {
        score += Math.min(exports, 10) * 1.5;
        if (exports >= 4) reasons.push(`${exports} exports`);
      }
      if (f.status === "removed") {
        if (former) {
          score += 20;
          reasons.push(`deleted, ${former} file${former === 1 ? " still imported" : "s still imported"} it before`);
        } else reasons.push("deleted");
      }
      if (!tests && importers > 0 && f.status !== "removed" && !/(^|\/)types?\/|\.d\.ts$/.test(p)) {
        score += 15;
        reasons.push("no related spec");
      } else if (tests) reasons.push(`${tests} related spec${tests === 1 ? "" : "s"}`);
    }
    if (SENSITIVE_RE.test(p)) {
      score += 15;
      reasons.push("security-sensitive path");
    }
    if (WIRING_RE.test(p)) {
      score += 10;
      reasons.push("wiring / config");
    }
    if (f.status === "modified" && f.deletions >= 50 && f.deletions > f.additions) {
      score += 8;
      reasons.push("deletes more than it adds");
    }
    if (changes >= 200) {
      score += Math.min(changes / 100, 15);
      reasons.push(`${changes.toLocaleString("en-US")} lines`);
    }
    if (!src && /\.(json|md|mdx|ya?ml|svg|png|lock)$/i.test(p)) score *= 0.5;
    byPath[p] = { score: Math.round(score), reasons, importers, exports, tests };
  }
  return { ready: true, headSha: g.headSha, byPath };
}
