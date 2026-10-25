// Surface outline for source files: what a module exposes and depends on — exports (with props for
// components), hooks/effects, data access, i18n keys, routes, permissions — so a reviewer can skim
// shape before reading bodies.
import { parse } from "@babel/parser";
import { exprSummary } from "./tests.mjs";

const REACT_HOOKS = new Set(["useState", "useEffect", "useLayoutEffect", "useMemo", "useCallback", "useRef", "useContext", "useReducer", "useId", "useTransition", "useDeferredValue", "useImperativeHandle", "useSyncExternalStore", "useInsertionEffect"]);

export function parseSurface(text, filePath) {
  let ast;
  try {
    ast = parse(text, { sourceType: "module", plugins: ["typescript", "jsx", "decorators-legacy", "topLevelAwait"], errorRecovery: true, attachComment: false });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const out = { ok: true, exports: [], components: [], hooksUsed: {}, effects: [], state: [], queries: [], mutations: [], apis: {}, i18nKeys: {}, routes: [], permissions: [], testIds: [], renders: {}, functions: [], types: [], todos: [], imports: 0, lines: text.split("\n").length };
  const typeMembers = new Map(); // type/interface name -> [member names]

  // top-level declarations & exports
  for (const node of ast.program.body) {
    if (node.type === "ImportDeclaration") out.imports++;
    const decl = node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration" ? node.declaration : node;
    const exported = node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration";
    const isDefault = node.type === "ExportDefaultDeclaration";
    if (!decl) {
      if (node.type === "ExportNamedDeclaration" && node.specifiers?.length) for (const sp of node.specifiers) out.exports.push({ name: sp.exported?.name || sp.exported?.value, kind: node.source ? "reexport" : "named", line: node.loc.start.line });
      continue;
    }
    if (decl.type === "TSInterfaceDeclaration" || decl.type === "TSTypeAliasDeclaration") {
      const members = decl.type === "TSInterfaceDeclaration" ? decl.body.body : decl.typeAnnotation?.type === "TSTypeLiteral" ? decl.typeAnnotation.members : [];
      const names = (members || []).map((m) => (m.key ? (m.key.name || m.key.value) + (m.optional ? "?" : "") : null)).filter(Boolean);
      typeMembers.set(decl.id.name, names);
      out.types.push({ name: decl.id.name, kind: decl.type === "TSInterfaceDeclaration" ? "interface" : "type", exported, line: decl.loc.start.line, members: names.slice(0, 20), memberCount: names.length });
      if (exported) out.exports.push({ name: decl.id.name, kind: decl.type === "TSInterfaceDeclaration" ? "interface" : "type", line: decl.loc.start.line, members: names.slice(0, 20) });
      continue;
    }
    if (decl.type === "TSEnumDeclaration") {
      if (exported) out.exports.push({ name: decl.id.name, kind: "enum", line: decl.loc.start.line, members: decl.members.slice(0, 20).map((m) => m.id.name || m.id.value) });
      continue;
    }
    if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
      const name = decl.id?.name || (isDefault ? inferName(filePath) : "(anonymous)");
      recordFunction(out, name, decl, { exported, isDefault, line: decl.loc.start.line, text });
      continue;
    }
    if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (d.id.type !== "Identifier") continue;
        const init = d.init;
        const fnLike = init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression" || (init.type === "CallExpression" && /^(memo|forwardRef|observer|styled|React\.memo|React\.forwardRef)$/.test(exprSummary(init.callee, 40))));
        if (fnLike) {
          const fn = init.type === "CallExpression" ? init.arguments.find((a) => /Function/.test(a.type)) || init : init;
          recordFunction(out, d.id.name, fn, { exported, isDefault, line: d.loc.start.line, text, wrapper: init.type === "CallExpression" ? exprSummary(init.callee, 30) : null, typeAnnotation: d.id.typeAnnotation });
        } else if (exported) out.exports.push({ name: d.id.name, kind: "const", line: d.loc.start.line, value: init ? exprSummary(init, 60) : "" });
      }
      continue;
    }
    if (isDefault && decl.type === "Identifier") out.exports.push({ name: decl.name, kind: "default", line: node.loc.start.line });
    else if (isDefault) out.exports.push({ name: inferName(filePath), kind: "default", line: node.loc.start.line, value: exprSummary(decl, 60) });
  }
  // attach props member lists to components
  for (const c of out.components) if (c.propsType && typeMembers.has(c.propsType)) c.props = typeMembers.get(c.propsType);

  // whole-file scans (cheap, regex) for usage facts
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const n = i + 1;
    for (const m of line.matchAll(/\b(use[A-Z]\w*)\s*\(/g)) {
      const h = m[1];
      if (!out.hooksUsed[h]) out.hooksUsed[h] = { count: 0, lines: [], builtin: REACT_HOOKS.has(h) };
      out.hooksUsed[h].count++;
      if (out.hooksUsed[h].lines.length < 6) out.hooksUsed[h].lines.push(n);
      if (h === "useEffect" || h === "useLayoutEffect") out.effects.push({ line: n, deps: (line.match(/\]\s*\)\s*;?\s*$/) ? "inline" : null) });
      if (h === "useState") out.state.push({ line: n, name: (line.match(/\[\s*(\w+)\s*,/) || [])[1] || null });
      if (h === "useQuery" || h === "useInfiniteQuery" || h === "useSuspenseQuery") out.queries.push({ line: n, text: line.trim().slice(0, 100) });
      if (h === "useMutation") out.mutations.push({ line: n, text: line.trim().slice(0, 100) });
    }
    for (const m of line.matchAll(/\b([a-z]\w*Api)\.(\w+)\b/g)) {
      const k = `${m[1]}.${m[2]}`;
      if (!out.apis[k]) out.apis[k] = { count: 0, line: n };
      out.apis[k].count++;
    }
    for (const m of line.matchAll(/\bt\(\s*["']([a-zA-Z0-9_.:-]+)["']/g)) {
      if (!out.i18nKeys[m[1]]) out.i18nKeys[m[1]] = { count: 0, line: n };
      out.i18nKeys[m[1]].count++;
    }
    for (const m of line.matchAll(/(?:navigate\(|to=|href=|path:\s*|^\s*)["'`](\/[\w\-/:${}.]*)["'`]/g)) if (m[1].length > 1) out.routes.push({ route: m[1], line: n });
    for (const m of line.matchAll(/\bPERMISSION_[A-Z0-9_]+\b/g)) out.permissions.push({ name: m[0], line: n });
    for (const m of line.matchAll(/data-(?:testid|cy)=(?:["']([^"']+)["']|\{["']([^"']+)["']\})/g)) out.testIds.push({ id: m[1] || m[2], line: n });
    for (const m of line.matchAll(/<([A-Z][\w.]*)[\s/>]/g)) out.renders[m[1]] = (out.renders[m[1]] || 0) + 1;
    const todo = line.match(/\b(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)$/);
    if (todo) out.todos.push({ line: n, text: todo[2].slice(0, 100) });
  });
  out.permissions = dedupe(out.permissions, (x) => x.name);
  out.routes = dedupe(out.routes, (x) => x.route);
  out.testIds = dedupe(out.testIds, (x) => x.id);
  out.renders = Object.entries(out.renders).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count }));
  return out;
}

function recordFunction(out, name, fn, { exported, isDefault, line, text, wrapper = null, typeAnnotation = null }) {
  const params = (fn.params || []).map((p) => paramSummary(p));
  const isComponent = /^[A-Z]/.test(name) && (returnsJsx(fn, text, line) || /React\.FC|FC</.test(exprSummary(typeAnnotation?.typeAnnotation || {}, 40)) || Boolean(wrapper && /memo|forwardRef/.test(wrapper)));
  const isHook = /^use[A-Z]/.test(name);
  const first = fn.params?.[0];
  const propsType = first?.typeAnnotation?.typeAnnotation?.typeName?.name || (typeAnnotation?.typeAnnotation?.typeParameters?.params?.[0]?.typeName?.name ?? null);
  const inlineProps = first?.type === "ObjectPattern" ? first.properties.map((p) => p.key?.name || (p.type === "RestElement" ? "…" + (p.argument?.name || "") : "?")).filter(Boolean) : first?.typeAnnotation?.typeAnnotation?.type === "TSTypeLiteral" ? first.typeAnnotation.typeAnnotation.members.map((m) => m.key?.name).filter(Boolean) : null;
  const entry = { name, kind: isComponent ? "component" : isHook ? "hook" : fn.type === "ClassDeclaration" ? "class" : "function", exported, isDefault, line, endLine: fn.loc?.end.line || line, params, propsType, props: inlineProps, wrapper, async: Boolean(fn.async) };
  out.functions.push(entry);
  if (isComponent) out.components.push(entry);
  if (exported) out.exports.push({ name, kind: isDefault ? "default" : entry.kind, line, params, propsType, props: inlineProps, endLine: entry.endLine });
}
function paramSummary(p) {
  if (p.type === "Identifier") return p.name + (p.typeAnnotation ? `: ${exprSummaryType(p.typeAnnotation.typeAnnotation)}` : "");
  if (p.type === "ObjectPattern") return `{ ${p.properties.map((x) => x.key?.name || "…").slice(0, 8).join(", ")}${p.properties.length > 8 ? ", …" : ""} }`;
  if (p.type === "AssignmentPattern") return paramSummary(p.left) + " = …";
  if (p.type === "RestElement") return "..." + (p.argument?.name || "");
  return "…";
}
function exprSummaryType(t) {
  if (!t) return "";
  if (t.type === "TSTypeReference") return (t.typeName?.name || t.typeName?.right?.name || "T") + (t.typeParameters ? "<…>" : "");
  if (t.type === "TSStringKeyword") return "string";
  if (t.type === "TSNumberKeyword") return "number";
  if (t.type === "TSBooleanKeyword") return "boolean";
  if (t.type === "TSArrayType") return exprSummaryType(t.elementType) + "[]";
  if (t.type === "TSUnionType") return t.types.slice(0, 3).map(exprSummaryType).join(" | ") + (t.types.length > 3 ? " | …" : "");
  if (t.type === "TSTypeLiteral") return "{…}";
  if (t.type === "TSFunctionType") return "fn";
  return t.type.replace(/^TS|Keyword$|Type$/g, "").toLowerCase();
}
function returnsJsx(fn, text, line) {
  // cheap: does the function body contain JSX?
  const start = fn.start ?? 0;
  const end = fn.end ?? text.length;
  const body = text.slice(start, end);
  return /<[A-Za-z][\w.]*[\s/>]/.test(body) && /return\s*\(?\s*</.test(body) || /=>\s*\(?\s*</.test(body);
}
function inferName(p) {
  let base = p.split("/").pop().replace(/\.[^.]+$/, "");
  if (/^index$/i.test(base)) base = p.split("/").slice(-2, -1)[0] || base;
  return base.replace(/[^\w$]/g, "");
}
function dedupe(arr, keyFn) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
