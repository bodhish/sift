// Heuristics that turn a flat file list into something a reviewer can reason about:
// areas (for grouping/progress), tiers (foundations-first reading order) and risk hints.

export const TIERS = [
  { id: 0, label: "Config & infra" },
  { id: 1, label: "Types & schemas" },
  { id: 2, label: "Utils, hooks & state" },
  { id: 3, label: "Components" },
  { id: 4, label: "Pages" },
  { id: 5, label: "Routing & wiring" },
  { id: 6, label: "Docs & locale" },
  { id: 7, label: "Tests" },
];

export function tierOf(path) {
  const p = path.toLowerCase();
  const base = p.split("/").pop();
  if (/^tests?\//.test(p) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(base) || /^cypress\//.test(p) || /^e2e\//.test(p)) return 7;
  if (/^docs\//.test(p) || /\.md$/.test(base) || /^public\/locale\//.test(p) || /\/locale\//.test(p) || /i18n/.test(p)) return 6;
  if (
    /^\.github\//.test(p) ||
    /^\.?env/.test(base) ||
    /^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json|vite\.config\.[cm]?[jt]s|.*\.config\.[cm]?[jt]s|\.gitignore|\.eslintrc.*|\.prettierrc.*|dockerfile|.*\.ya?ml)$/.test(base) ||
    /^(scripts|plugins|\.husky|\.vscode)\//.test(p)
  )
    return 0;
  // The top-level folder (after src/) decides the tier so an area's files stay together.
  const segs = p.split("/");
  const top = (segs[0] === "src" ? segs[1] : segs[0]) || "";
  if (segs.length === 1) return 0;
  if (/^(types?|schemas?)$/.test(top)) return 1;
  if (/^(routers?|routes|routing)$/.test(top) || (/^(app|main|index|pluginengine)\.[jt]sx?$/.test(base) && segs.length <= 2)) return 5;
  if (/^(utils?|lib|hooks?|context|atoms?|store|stores|common|config|providers?|api|services?|helpers?|request|state|queries?)$/.test(top)) return 2;
  if (/^(pages?|views?|screens?)$/.test(top)) return 4;
  if (/^(components?|ui|careui)$/.test(top)) return 3;
  if (/\.d\.ts$/.test(base) || /(^|\.)types?\.[jt]sx?$/.test(base)) return 1;
  return 3;
}

/** Reading order inside an area: contracts first, then helpers, then the UI, then wiring. */
export function rankOf(path) {
  const p = path.toLowerCase();
  const base = p.split("/").pop();
  if (/\.d\.ts$/.test(base) || /(^|\.)(types?|schemas?|constants?|enums?)\.[jt]sx?$/.test(base) || /\/(types?|schemas?)\//.test(p)) return 0;
  if (/^index\.[jt]sx?$/.test(base)) return 3;
  if (/\/(utils?|lib|hooks?|helpers?|context|store|api|services?|queries?|actions?)\//.test(p) || /^use[A-Z0-9]/.test(path.split("/").pop()) || /\.(utils?|helpers?|hooks?)\.[jt]sx?$/.test(base)) return 1;
  return 2;
}

/** A short, stable grouping key: strips `src/` and keeps up to two meaningful segments. */
export function areaOf(path) {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";
  let segs = parts.slice(0, -1);
  if (segs[0] === "src" && segs.length > 1) segs = segs.slice(1);
  const generic = new Set(["components", "pages", "tests", "test", "public", "docs", "utils", "lib", "hooks", "types"]);
  if (segs.length >= 2 && generic.has(segs[0].toLowerCase())) return segs.slice(0, 2).join("/");
  return segs.slice(0, 1).join("/") || "(root)";
}

const SENSITIVE = /(auth|permission|acl|role|token|session|secur|crypt|password|router|request|api|fetch|query|mutation|payment|billing|consent|env\b)/i;

export function riskOf(file) {
  const risks = [];
  const { path, status, additions = 0, deletions = 0 } = file;
  if (status === "removed") risks.push("deleted");
  if (SENSITIVE.test(path)) risks.push("sensitive");
  if (additions + deletions >= 500) risks.push("large");
  else if (additions + deletions >= 200) risks.push("big");
  if (status === "modified" && deletions >= 50 && deletions > additions) risks.push("heavy-deletion");
  if (/\.(json|lock|snap)$/.test(path) || /generated|__snapshots__|\.min\./.test(path)) risks.push("generated-ish");
  return risks;
}

export function languageOf(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const map = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", md: "markdown", mdx: "markdown", css: "css", scss: "scss", less: "less",
    html: "xml", xml: "xml", svg: "xml", yml: "yaml", yaml: "yaml", sh: "bash", bash: "bash", zsh: "bash",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", sql: "sql", toml: "ini", ini: "ini",
    env: "bash", gitignore: "plaintext", txt: "plaintext", graphql: "graphql", gql: "graphql",
  };
  return map[ext] || "plaintext";
}
