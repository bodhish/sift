// Playwright spec outline: turns a spec file into scenarios (tests → steps) using a real AST,
// so reviewers can read what a test does instead of how it is written.
import { parse } from "@babel/parser";

const ACTION_VERBS = {
  click: "Click", dblclick: "Double-click", fill: "Fill", type: "Type", press: "Press", check: "Check", uncheck: "Uncheck",
  selectOption: "Select", hover: "Hover", focus: "Focus", blur: "Blur", clear: "Clear", tap: "Tap", dragTo: "Drag", setInputFiles: "Upload",
  scrollIntoViewIfNeeded: "Scroll to", selectText: "Select text in", pressSequentially: "Type", setChecked: "Set checked",
};
const LOCATOR_FNS = new Set(["getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId", "getByTitle", "getByAltText", "locator", "frameLocator", "first", "last", "nth", "filter", "and", "or", "getByRoleName"]);
const WAIT_FNS = { waitForTimeout: "hard wait", waitForURL: "Wait for URL", waitForSelector: "Wait for selector", waitForLoadState: "Wait for load", waitForResponse: "Wait for response", waitForRequest: "Wait for request", waitForFunction: "Wait for condition", waitForEvent: "Wait for event", waitFor: "Wait for" };
const MATCHERS = {
  toBeVisible: "visible", toBeHidden: "hidden", toBeAttached: "attached", toBeEnabled: "enabled", toBeDisabled: "disabled", toBeChecked: "checked", toBeEditable: "editable", toBeEmpty: "empty", toBeFocused: "focused", toBeInViewport: "in viewport",
  toHaveText: "to have text", toContainText: "to contain text", toHaveValue: "to have value", toHaveValues: "to have values", toHaveCount: "to have count", toHaveAttribute: "to have attribute", toHaveClass: "to have class", toHaveCSS: "to have css", toHaveId: "to have id", toHaveURL: "to have URL", toHaveTitle: "to have title", toHaveScreenshot: "to match screenshot", toHaveAccessibleName: "to have accessible name", toHaveRole: "to have role",
  toBe: "to be", toEqual: "to equal", toStrictEqual: "to strictly equal", toBeTruthy: "truthy", toBeFalsy: "falsy", toBeNull: "null", toBeDefined: "defined", toBeUndefined: "undefined", toBeGreaterThan: ">", toBeGreaterThanOrEqual: "≥", toBeLessThan: "<", toBeLessThanOrEqual: "≤", toContain: "to contain", toContainEqual: "to contain", toHaveLength: "to have length", toMatch: "to match", toMatchObject: "to match object", toHaveProperty: "to have property", toThrow: "to throw", toBeCloseTo: "≈", toBeInstanceOf: "instance of", toHaveBeenCalled: "called", toPass: "to pass",
};

export function parseSpec(text, { addedLines = null } = {}) {
  let ast;
  try {
    ast = parse(text, { sourceType: "module", plugins: ["typescript", "jsx", "decorators-legacy", "topLevelAwait"], errorRecovery: true, attachComment: false });
  } catch (err) {
    return { ok: false, error: err.message, tests: [], describes: [], smells: [], imports: [] };
  }
  const out = { ok: true, tests: [], hooks: [], config: [], smells: [], imports: [], fixtures: new Set(), helpers: new Set(), totalLines: text.split("\n").length };
  const helperNames = new Set();
  for (const node of ast.program.body) {
    if (node.type === "ImportDeclaration") {
      const spec = node.source.value;
      const names = node.specifiers.map((s) => s.local.name);
      out.imports.push({ spec, names, line: node.loc.start.line });
      if (!/^@playwright\/test$/.test(spec) && !/^@faker-js|^node:|^[a-z@][\w./-]*$/.test(spec) || /tests?\/|helper|support|fixture|utils|page-?object/i.test(spec)) names.forEach((n) => helperNames.add(n));
    }
  }
  // Also treat locally declared functions as helpers.
  for (const node of ast.program.body) {
    if (node.type === "FunctionDeclaration" && node.id) helperNames.add(node.id.name);
    if (node.type === "VariableDeclaration") for (const d of node.declarations) if (d.id.type === "Identifier" && d.init && /Function/.test(d.init.type)) helperNames.add(d.id.name);
  }

  const visit = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "ExpressionStatement") {
      const call = node.expression.type === "AwaitExpression" ? node.expression.argument : node.expression;
      if (call?.type === "CallExpression") {
        const callee = calleeChain(call.callee); // e.g. ["test"], ["test","describe"], ["test","describe","only"]
        if (callee[0] === "test" || callee[0] === "it" || callee[0] === "describe") {
          const chain = callee[0] === "describe" ? ["test", "describe", ...callee.slice(1)] : callee;
          const kind = chain[1];
          const mods = chain.slice(2);
          if (kind === "describe" || (callee[0] === "describe" && chain.length >= 2)) {
            const title = argString(call.arguments[0]) ?? "(describe)";
            const fn = call.arguments.find((a) => /Function/.test(a.type));
            const d = { title, line: node.loc.start.line, mods: mods.filter((m) => m !== "describe") };
            if (fn?.body?.type === "BlockStatement") for (const s of fn.body.body) visit(s, [...path, d]);
            else if (fn?.body) visit(fn.body, [...path, d]);
            return;
          }
          if (kind === "use") {
            out.config.push({ kind: "use", text: `test.use(${exprSummary(call.arguments[0], 80)})`, line: node.loc.start.line });
            return;
          }
          if (kind === "beforeEach" || kind === "afterEach" || kind === "beforeAll" || kind === "afterAll") {
            const fn = call.arguments.find((a) => /Function/.test(a.type));
            const steps = fn ? extractSteps(fn, helperNames, out) : [];
            out.hooks.push({ kind, line: node.loc.start.line, endLine: node.loc.end.line, scope: path.map((p) => p.title), steps, fixtures: fixtureNames(fn) });
            return;
          }
          if (kind === "setTimeout" || kind === "slow" || kind === "skip" && call.arguments.length && !call.arguments.some((a) => /Function/.test(a.type))) {
            out.config.push({ kind, text: `test.${kind}(${call.arguments.map((a) => exprSummary(a, 40)).join(", ")})`, line: node.loc.start.line, scope: path.map((p) => p.title) });
            return;
          }
          if (chain[1] === "describe" || chain[1] === "step") return;
          // test(...) possibly with modifiers: test.skip / test.only / test.fixme / test.fail
          const title = argString(call.arguments[0]);
          const fn = call.arguments.find((a) => /Function/.test(a.type));
          if (title == null && !fn) return;
          const modifiers = [kind, ...mods].filter((m) => m && ["skip", "only", "fixme", "fail", "slow"].includes(m));
          const t = {
            title: title ?? "(dynamic title)",
            line: node.loc.start.line,
            endLine: node.loc.end.line,
            scope: path.map((p) => p.title),
            modifiers,
            tags: (title?.match(/@[\w-]+/g) || []),
            fixtures: fixtureNames(fn),
            steps: fn ? extractSteps(fn, helperNames, out) : [],
          };
          t.assertions = countAssertions(fn);
          t.hardWaits = t.steps.filter((s) => s.kind === "hardwait").length + nestedCount(t.steps, "hardwait");
          if (addedLines) t.change = classifyChange(t.line, t.endLine, addedLines);
          out.tests.push(t);
          return;
        }
        if (callee[0] === "test" && callee[1] === "describe") return;
      }
    }
    if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") return visit(node.declaration, path);
  };
  for (const node of ast.program.body) visit(node, []);

  // smells
  const only = out.tests.filter((t) => t.modifiers.includes("only"));
  if (only.length) out.smells.push({ kind: "only", level: "error", text: `${only.length} test${only.length > 1 ? "s" : ""} use .only — CI would run just ${only.length > 1 ? "those" : "that one"}`, lines: only.map((t) => t.line) });
  const skipped = out.tests.filter((t) => t.modifiers.includes("skip") || t.modifiers.includes("fixme"));
  if (skipped.length) out.smells.push({ kind: "skipped", level: "warn", text: `${skipped.length} skipped/fixme test${skipped.length > 1 ? "s" : ""}`, lines: skipped.map((t) => t.line) });
  const noAssert = out.tests.filter((t) => t.assertions === 0 && !t.modifiers.includes("skip"));
  if (noAssert.length) out.smells.push({ kind: "no-assert", level: "warn", text: `${noAssert.length} test${noAssert.length > 1 ? "s" : ""} without an expect()`, lines: noAssert.map((t) => t.line) });
  const waits = out.tests.reduce((n, t) => n + t.hardWaits, 0);
  if (waits) out.smells.push({ kind: "hardwait", level: "warn", text: `${waits} hard wait${waits > 1 ? "s" : ""} (waitForTimeout)`, lines: out.tests.filter((t) => t.hardWaits).map((t) => t.line) });
  if (/page\.pause\(\)/.test(text)) out.smells.push({ kind: "pause", level: "error", text: "page.pause() left in", lines: [] });
  const long = out.tests.filter((t) => t.endLine - t.line > 120);
  if (long.length) out.smells.push({ kind: "long", level: "info", text: `${long.length} very long test${long.length > 1 ? "s" : ""} (>120 lines)`, lines: long.map((t) => t.line) });

  out.fixtures = [...new Set(out.tests.flatMap((t) => t.fixtures))];
  out.helpers = [...new Set(out.tests.flatMap((t) => flatSteps(t.steps).filter((s) => s.kind === "helper").map((s) => s.name)))];
  return out;
}

// ---------- steps ----------

function extractSteps(fn, helperNames, out, depth = 0) {
  const body = fn.body?.type === "BlockStatement" ? fn.body.body : fn.body ? [{ type: "ExpressionStatement", expression: fn.body, loc: fn.body.loc }] : [];
  const steps = [];
  for (const st of body) collect(st, steps, helperNames, out, depth);
  return steps;
}

function collect(st, steps, helperNames, out, depth) {
  if (!st || depth > 4) return;
  const line = st.loc?.start.line;
  switch (st.type) {
    case "ExpressionStatement": {
      const s = describeExpr(st.expression, helperNames, out, depth, line);
      if (s) steps.push(s);
      return;
    }
    case "VariableDeclaration": {
      for (const d of st.declarations) {
        if (!d.init) continue;
        const s = describeExpr(d.init, helperNames, out, depth, line);
        if (s) {
          s.assign = d.id.type === "Identifier" ? d.id.name : d.id.type === "ObjectPattern" ? `{ ${d.id.properties.map((p) => p.key?.name || "…").join(", ")} }` : "…";
          steps.push(s);
        } else if (d.id.type === "Identifier" && d.init.type !== "ArrowFunctionExpression") {
          steps.push({ kind: "data", text: `${d.id.name} = ${exprSummary(d.init, 60)}`, line });
        }
      }
      return;
    }
    case "ReturnStatement":
      if (st.argument) {
        const s = describeExpr(st.argument, helperNames, out, depth, line);
        if (s) steps.push(s);
      }
      return;
    case "IfStatement": {
      const s = { kind: "branch", text: `if ${exprSummary(st.test, 60)}`, line, children: [] };
      collectBlock(st.consequent, s.children, helperNames, out, depth + 1);
      if (st.alternate) {
        const e = { kind: "branch", text: "else", line: st.alternate.loc.start.line, children: [] };
        collectBlock(st.alternate, e.children, helperNames, out, depth + 1);
        steps.push(s, e);
      } else steps.push(s);
      return;
    }
    case "ForStatement":
    case "ForOfStatement":
    case "ForInStatement":
    case "WhileStatement":
    case "DoWhileStatement": {
      const head = st.type === "ForOfStatement" ? `for each ${exprSummary(st.left, 30)} of ${exprSummary(st.right, 40)}` : st.type === "WhileStatement" ? `while ${exprSummary(st.test, 40)}` : "loop";
      const s = { kind: "loop", text: head, line, children: [] };
      collectBlock(st.body, s.children, helperNames, out, depth + 1);
      steps.push(s);
      return;
    }
    case "TryStatement": {
      const s = { kind: "branch", text: "try", line, children: [] };
      collectBlock(st.block, s.children, helperNames, out, depth + 1);
      steps.push(s);
      if (st.handler) {
        const c = { kind: "branch", text: "catch", line: st.handler.loc.start.line, children: [] };
        collectBlock(st.handler.body, c.children, helperNames, out, depth + 1);
        steps.push(c);
      }
      return;
    }
    case "BlockStatement":
      for (const x of st.body) collect(x, steps, helperNames, out, depth);
      return;
    default:
      return;
  }
}
function collectBlock(node, into, helperNames, out, depth) {
  if (!node) return;
  if (node.type === "BlockStatement") for (const x of node.body) collect(x, into, helperNames, out, depth);
  else collect(node, into, helperNames, out, depth);
}

function describeExpr(expr, helperNames, out, depth, line) {
  if (!expr) return null;
  if (expr.type === "AwaitExpression") return describeExpr(expr.argument, helperNames, out, depth, line);
  if (expr.type === "AssignmentExpression") {
    const s = describeExpr(expr.right, helperNames, out, depth, line);
    if (s) s.assign = exprSummary(expr.left, 30);
    return s;
  }
  if (expr.type === "ArrayExpression" || expr.type === "TSAsExpression" || expr.type === "TSNonNullExpression") return describeExpr(expr.expression || expr.elements?.[0], helperNames, out, depth, line);
  if (expr.type !== "CallExpression") return null;

  const chain = callChain(expr); // [{name, args, node}] from root to leaf
  if (!chain.length) return null;
  const root = chain[0];
  const leaf = chain[chain.length - 1];

  // Promise.all([...]) → group of parallel steps
  if (root.name === "Promise" && chain.length === 2 && (leaf.name === "all" || leaf.name === "allSettled")) {
    const arr = leaf.args[0];
    const children = [];
    if (arr?.type === "ArrayExpression") for (const el of arr.elements) {
      const s = describeExpr(el, helperNames, out, depth + 1, el?.loc?.start.line ?? line);
      if (s) children.push(s);
    }
    return { kind: "group", text: "in parallel", line, children };
  }
  // test.step("title", async () => {...})
  if (root.name === "test" && chain.length === 2 && leaf.name === "step") {
    const title = argString(leaf.args[0]) ?? "(step)";
    const fn = leaf.args.find((a) => /Function/.test(a.type));
    return { kind: "step", text: title, line, children: fn ? extractSteps(fn, helperNames, out, depth + 1) : [] };
  }
  // expect(...)
  if (root.name === "expect" || (root.name === "expect" && chain[1]?.name === "soft")) {
    const subject = root.args[0];
    let i = 1;
    let soft = false;
    let negated = false;
    let poll = false;
    while (i < chain.length && ["soft", "not", "poll", "resolves", "rejects"].includes(chain[i].name)) {
      if (chain[i].name === "not") negated = true;
      if (chain[i].name === "soft") soft = true;
      if (chain[i].name === "poll") poll = true;
      i++;
    }
    const m = chain[i];
    const matcher = m ? MATCHERS[m.name] || m.name : "…";
    const arg = m?.args?.length ? ` ${m.args.map((a) => exprSummary(a, 50)).join(", ")}` : "";
    const subj = subject ? subjectSummary(subject) : "";
    return { kind: "expect", text: `Expect ${subj} ${negated ? "not " : ""}${matcher}${arg}`.replace(/\s+/g, " ").trim(), line, soft, poll };
  }
  // page.goto / page.waitFor* / page.reload / page.goBack
  const pageLike = ["page", "newPage", "context", "browser", "request", "frame", "popup", "dialog"];
  if (pageLike.includes(root.name) || /Page$|page$/i.test(root.name)) {
    if (leaf.name === "goto") return { kind: "nav", text: `Go to ${exprSummary(leaf.args[0], 80)}`, line };
    if (leaf.name === "reload") return { kind: "nav", text: "Reload page", line };
    if (leaf.name === "goBack") return { kind: "nav", text: "Go back", line };
    if (leaf.name === "waitForTimeout") return { kind: "hardwait", text: `Hard wait ${exprSummary(leaf.args[0], 20)} ms`, line };
    if (WAIT_FNS[leaf.name]) return { kind: "wait", text: `${WAIT_FNS[leaf.name]} ${leaf.args.map((a) => exprSummary(a, 50)).join(", ")}`.trim(), line };
    if (leaf.name === "route") return { kind: "mock", text: `Mock route ${exprSummary(leaf.args[0], 60)}`, line };
    if (leaf.name === "unroute") return { kind: "mock", text: `Unmock ${exprSummary(leaf.args[0], 60)}`, line };
    if (leaf.name === "evaluate") return { kind: "other", text: "Evaluate script in page", line };
    if (leaf.name === "screenshot") return { kind: "other", text: "Take screenshot", line };
    if (leaf.name === "setViewportSize") return { kind: "other", text: `Set viewport ${exprSummary(leaf.args[0], 40)}`, line };
    if (["get", "post", "put", "patch", "delete", "fetch"].includes(leaf.name) && (root.name === "request" || chain.some((c) => c.name === "request"))) return { kind: "api", text: `API ${leaf.name.toUpperCase()} ${exprSummary(leaf.args[0], 70)}`, line };
    if (leaf.name === "keyboard" || chain.some((c) => c.name === "keyboard")) return { kind: "action", text: `Keyboard ${leaf.name} ${leaf.args.map((a) => exprSummary(a, 30)).join(", ")}`, line };
    if (chain.some((c) => c.name === "mouse")) return { kind: "action", text: `Mouse ${leaf.name}`, line };
  }
  // bare locator (usually assigned): const dialog = page.getByRole("dialog", …)
  if (LOCATOR_FNS.has(leaf.name)) return { kind: "locator", text: subjectSummary({ type: "CallExpression", _chain: chain }), line };
  // locator action: <locator chain>.click()
  if (ACTION_VERBS[leaf.name]) {
    const target = subjectSummary({ type: "CallExpression", _chain: chain.slice(0, -1) });
    const arg = leaf.args.length && leaf.name !== "click" ? ` with ${leaf.args.map((a) => exprSummary(a, 50)).join(", ")}` : "";
    return { kind: "action", text: `${ACTION_VERBS[leaf.name]} ${target}${arg}`.replace(/\s+/g, " ").trim(), line, verb: leaf.name };
  }
  if (WAIT_FNS[leaf.name]) {
    const target = subjectSummary({ type: "CallExpression", _chain: chain.slice(0, -1) });
    return { kind: leaf.name === "waitForTimeout" ? "hardwait" : "wait", text: `${WAIT_FNS[leaf.name]} ${target} ${leaf.args.map((a) => exprSummary(a, 40)).join(", ")}`.replace(/\s+/g, " ").trim(), line };
  }
  // helper / fixture call
  if (chain.length === 1 && (helperNames.has(root.name) || /^[a-z]/.test(root.name))) {
    const isHelper = helperNames.has(root.name) || !["console", "setTimeout", "JSON", "Math", "String", "Number", "Array", "Object", "Date", "require"].includes(root.name);
    if (isHelper) return { kind: "helper", name: root.name, text: `${root.name}(${root.args.map((a) => exprSummary(a, 36)).join(", ")})`, line };
  }
  if (chain.length >= 2 && (helperNames.has(root.name) || /helper|api|fixture|util/i.test(root.name))) {
    return { kind: "helper", name: `${root.name}.${leaf.name}`, text: `${chain.map((c) => c.name).join(".")}(${leaf.args.map((a) => exprSummary(a, 30)).join(", ")})`, line };
  }
  if (leaf.name === "textContent" || leaf.name === "innerText" || leaf.name === "inputValue" || leaf.name === "count" || leaf.name === "getAttribute" || leaf.name === "isVisible" || leaf.name === "allTextContents" || leaf.name === "boundingBox" || leaf.name === "evaluate") {
    const target = subjectSummary({ type: "CallExpression", _chain: chain.slice(0, -1) });
    return { kind: "read", text: `Read ${leaf.name} of ${target}`, line };
  }
  return { kind: "other", text: `${chain.map((c) => c.name).join(".")}(${leaf.args.map((a) => exprSummary(a, 30)).join(", ")})`.slice(0, 120), line };
}

/** Unwind a call/member chain into [{name,args}] from root to leaf. */
function callChain(expr) {
  const parts = [];
  let cur = expr;
  let pendingArgs = null;
  while (cur) {
    if (cur.type === "CallExpression") {
      pendingArgs = cur.arguments;
      cur = cur.callee;
    } else if (cur.type === "MemberExpression" || cur.type === "OptionalMemberExpression") {
      const name = cur.property.type === "Identifier" ? cur.property.name : cur.property.type === "StringLiteral" ? cur.property.value : "[…]";
      parts.unshift({ name, args: pendingArgs || [], node: cur });
      pendingArgs = null;
      cur = cur.object;
    } else if (cur.type === "Identifier" || cur.type === "ThisExpression") {
      parts.unshift({ name: cur.type === "ThisExpression" ? "this" : cur.name, args: pendingArgs || [], node: cur });
      break;
    } else if (cur.type === "AwaitExpression" || cur.type === "TSNonNullExpression" || cur.type === "TSAsExpression" || cur.type === "ParenthesizedExpression") {
      cur = cur.argument || cur.expression;
    } else {
      parts.unshift({ name: exprSummary(cur, 30), args: pendingArgs || [], node: cur });
      break;
    }
  }
  return parts;
}
function calleeChain(callee) {
  return callChain({ type: "CallExpression", callee, arguments: [] }).map((p) => p.name);
}

/** Human description of a locator or expectation subject. */
function subjectSummary(node) {
  const chain = node._chain || (node.type === "CallExpression" || node.type === "MemberExpression" ? callChain(node) : null);
  if (!chain) return exprSummary(node, 50);
  let out = "";
  const join = (piece, loc) => {
    if (!out) out = piece;
    else if (loc) out += ` › ${piece}`;
    else out += piece.startsWith("(") ? ` ${piece}` : `.${piece}`;
  };
  for (const c of chain) {
    if (c.name === "page" || c.name === "this") continue;
    if (LOCATOR_FNS.has(c.name)) {
      const a = c.args;
      switch (c.name) {
        case "getByRole": {
          const role = argString(a[0]) ?? "element";
          const name = a[1]?.type === "ObjectExpression" ? propValue(a[1], "name") : null;
          const exact = a[1]?.type === "ObjectExpression" && propValue(a[1], "exact")?.text === "true";
          const extra = a[1]?.type === "ObjectExpression" ? objSummary(a[1], ["level", "checked", "pressed", "selected", "expanded"]) : "";
          join(`${role}${name ? ` ${name.text}` : ""}${exact ? " (exact)" : ""}${extra ? ` ${extra}` : ""}`, true);
          break;
        }
        case "getByText": join(`text ${exprSummary(a[0], 50)}`, true); break;
        case "getByLabel": join(`field ${exprSummary(a[0], 50)}`, true); break;
        case "getByPlaceholder": join(`placeholder ${exprSummary(a[0], 40)}`, true); break;
        case "getByTestId": join(`#${argString(a[0]) ?? exprSummary(a[0], 40)}`, true); break;
        case "getByTitle": join(`title ${exprSummary(a[0], 40)}`, true); break;
        case "getByAltText": join(`alt ${exprSummary(a[0], 40)}`, true); break;
        case "locator": join(`\`${argString(a[0]) ?? exprSummary(a[0], 50)}\``, true); break;
        case "first": join("(first)", false); break;
        case "last": join("(last)", false); break;
        case "nth": join(`(#${exprSummary(a[0], 10)})`, false); break;
        case "filter": join(`(filter ${a[0]?.type === "ObjectExpression" ? objSummary(a[0], ["hasText", "hasNotText", "has", "hasNot"]) : exprSummary(a[0], 30)})`, false); break;
        default: join(c.name, false);
      }
    } else {
      const piece = c.args?.length ? `${c.name}(${c.args.map((x) => exprSummary(x, 20)).join(", ")})` : c === chain[0] ? c.name : `${c.name}${c.node?.type === "MemberExpression" && c.node.parent?.type === "CallExpression" ? "()" : ""}`;
      join(piece, false);
    }
  }
  return out || exprSummary(node, 50);
}

function countAssertions(fn) {
  let n = 0;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "expect") n++;
    else if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.object?.type === "Identifier" && node.callee.object.name === "expect" && /^(soft|poll)$/.test(node.callee.property?.name || "")) n++;
    for (const k in node) if (k !== "loc" && k !== "range" && k !== "leadingComments" && k !== "trailingComments" && node[k] && typeof node[k] === "object") walk(node[k]);
  };
  walk(fn.body);
  return n;
}
function fixtureNames(fn) {
  const p = fn?.params?.[0];
  if (!p) return [];
  if (p.type === "ObjectPattern") return p.properties.map((x) => x.key?.name || x.argument?.name).filter(Boolean);
  if (p.type === "Identifier") return [p.name];
  return [];
}
function classifyChange(start, end, added) {
  let total = 0;
  let hit = 0;
  for (let l = start; l <= end; l++) {
    total++;
    if (added.has(l)) hit++;
  }
  if (!hit) return "unchanged";
  return hit >= total * 0.9 ? "new" : "modified";
}
function flatSteps(steps, acc = []) {
  for (const s of steps) {
    acc.push(s);
    if (s.children) flatSteps(s.children, acc);
  }
  return acc;
}
function nestedCount(steps, kind) {
  return flatSteps(steps.flatMap((s) => s.children || [])).filter((s) => s.kind === kind).length;
}

// ---------- expression printing ----------

function argString(n) {
  if (!n) return null;
  if (n.type === "StringLiteral") return n.value;
  if (n.type === "TemplateLiteral") return n.quasis.map((q, i) => q.value.cooked + (n.expressions[i] ? `\${${exprSummary(n.expressions[i], 20)}}` : "")).join("");
  return null;
}
function quote(s) {
  return `"${s}"`;
}
function propValue(obj, key) {
  const p = obj.properties.find((x) => x.key && (x.key.name === key || x.key.value === key));
  if (!p) return null;
  const v = argString(p.value);
  if (v != null) return { text: quote(v), literal: true };
  if (p.value.type === "RegExpLiteral") return { text: `/${p.value.pattern}/${p.value.flags}`, literal: true };
  return { text: `‹${exprSummary(p.value, 30)}›`, literal: false };
}
function objSummary(obj, keys) {
  const parts = [];
  for (const p of obj.properties) {
    const k = p.key?.name || p.key?.value;
    if (!k || (keys && !keys.includes(k))) continue;
    parts.push(`${k}: ${exprSummary(p.value, 30)}`);
  }
  return parts.length ? `{ ${parts.join(", ")} }` : "";
}
export function exprSummary(n, max = 40) {
  if (!n) return "";
  let s;
  switch (n.type) {
    case "StringLiteral": s = quote(n.value); break;
    case "TemplateLiteral": s = `\`${argString(n)}\``; break;
    case "NumericLiteral": s = String(n.value); break;
    case "BooleanLiteral": s = String(n.value); break;
    case "NullLiteral": s = "null"; break;
    case "RegExpLiteral": s = `/${n.pattern}/${n.flags}`; break;
    case "Identifier": s = n.name; break;
    case "ThisExpression": s = "this"; break;
    case "MemberExpression":
    case "OptionalMemberExpression": s = `${exprSummary(n.object, max)}.${n.property.type === "Identifier" && !n.computed ? n.property.name : `[${exprSummary(n.property, 20)}]`}`; break;
    case "CallExpression":
    case "OptionalCallExpression": s = `${exprSummary(n.callee, max)}(${n.arguments.map((a) => exprSummary(a, 20)).join(", ")})`; break;
    case "AwaitExpression": s = exprSummary(n.argument, max); break;
    case "ObjectExpression": s = objSummary(n, null) || "{}"; break;
    case "ArrayExpression": s = `[${n.elements.map((e) => exprSummary(e, 15)).join(", ")}]`; break;
    case "ArrowFunctionExpression":
    case "FunctionExpression": s = "fn"; break;
    case "UnaryExpression": s = `${n.operator}${exprSummary(n.argument, max)}`; break;
    case "BinaryExpression":
    case "LogicalExpression": s = `${exprSummary(n.left, 20)} ${n.operator} ${exprSummary(n.right, 20)}`; break;
    case "ConditionalExpression": s = `${exprSummary(n.test, 15)} ? … : …`; break;
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression": s = exprSummary(n.expression, max); break;
    case "SpreadElement": s = `...${exprSummary(n.argument, 20)}`; break;
    case "ObjectPattern": s = `{ ${n.properties.map((p) => p.key?.name || "…").join(", ")} }`; break;
    case "VariableDeclaration": s = n.declarations.map((d) => exprSummary(d.id, 20)).join(", "); break;
    case "NewExpression": s = `new ${exprSummary(n.callee, 20)}(…)`; break;
    default: s = n.type.replace(/Expression|Literal/g, "").toLowerCase() || "…";
  }
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
