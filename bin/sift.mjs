#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { parsePrRef } from "../src/github.mjs";
import { Store, dataDirFor, defaultDataRoot } from "../src/store.mjs";
import { createServer } from "../src/server.mjs";
import { markdownReport } from "../src/publish.mjs";
import { loadConfig } from "../src/config.mjs";
import { Workspace } from "../src/workspace.mjs";
import "../src/features.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `sift — review huge pull requests locally, without losing your place

Usage:
  sift                         open the PR picker (recent + open PRs)
  sift <pr>                    open the review workbench for a PR
  sift <pr> --sync             re-fetch from GitHub before opening
  sift <pr> --export           print the Markdown notes report and exit

<pr> can be a URL (https://github.com/owner/repo/pull/123), owner/repo#123,
or a bare number together with --repo owner/repo.

Options:
  --repo owner/repo     repository for a bare PR number / the picker
  --repo-path <dir>     local clone of the repository (auto-detected when omitted)
  --port <n>            port to listen on (default 4777)
  --no-open             don't open the browser
  --data-dir <path>     where to keep state (default ./.review-data under the tool; also SIFT_DATA_DIR).
                        Use a separate directory for experiments so your review history is never touched.
  --backups             list the automatic backups of this PR's review state and exit
  --restore <name>      merge a backup (a name from --backups, or "latest") into the review state and exit
  --playwright-results <dir>
                        load a local Playwright run (folder with test-results.json and
                        test-results/) instead of CI artifacts; repeatable
  -h, --help            show this help

Per-repository settings live in sift.config.json next to the tool.
`;

function parseArgs(argv) {
  const opts = { positional: [], port: 4777, open: true, sync: false, export: false, repo: null, dataDir: null, pwResults: [], repoPath: null, backups: false, restore: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--sync") opts.sync = true;
    else if (a === "--export") opts.export = true;
    else if (a === "--no-open") opts.open = false;
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) opts.port = Number(a.slice(7));
    else if (a === "--repo") opts.repo = argv[++i];
    else if (a.startsWith("--repo=")) opts.repo = a.slice(7);
    else if (a === "--repo-path") opts.repoPath = argv[++i];
    else if (a.startsWith("--repo-path=")) opts.repoPath = a.slice(12);
    else if (a === "--backups") opts.backups = true;
    else if (a === "--restore") opts.restore = argv[++i] || "latest";
    else if (a.startsWith("--restore=")) opts.restore = a.slice(10);
    else if (a === "--data-dir") opts.dataDir = argv[++i];
    else if (a.startsWith("--data-dir=")) opts.dataDir = a.slice(11);
    else if (a === "--playwright-results") opts.pwResults.push(argv[++i]);
    else if (a.startsWith("--playwright-results=")) opts.pwResults.push(a.slice(21));
    else if (a.startsWith("-")) throw new Error(`Unknown option ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  const config = await loadConfig(ROOT);
  const repo = opts.repo || config.defaultRepo;
  const ref = opts.positional.length ? parsePrRef(opts.positional[0], repo) : null;

  const dataRoot = opts.dataDir ? path.resolve(opts.dataDir) : defaultDataRoot(ROOT);

  if (opts.export) {
    if (!ref) throw new Error("--export needs a PR reference");
    const store = await new Store({ dataDir: dataDirFor(dataRoot, ref), ref }).load({ lock: false });
    if (!store.hasData) throw new Error(`No local data for ${ref.owner}/${ref.repo}#${ref.number} yet — open it in Sift first.`);
    process.stdout.write(markdownReport(store) + "\n");
    return;
  }
  if (opts.backups || opts.restore) {
    if (!ref) throw new Error(`--${opts.backups ? "backups" : "restore"} needs a PR reference`);
    const store = await new Store({ dataDir: dataDirFor(dataRoot, ref), ref }).load({ lock: false });
    const list = await store.listBackups();
    if (opts.backups) {
      if (!list.length) console.log("No backups yet.");
      for (const b of list) console.log(`  ${b.name}  ${b.at}  ${b.records} files with status/notes · ${b.notes} notes · ${b.events} events`);
      return;
    }
    const target = opts.restore === "latest" ? list[0] : list.find((b) => b.name === opts.restore || b.name === `${opts.restore}.json`);
    if (!target) throw new Error(`No backup named ${opts.restore}. Run with --backups to list them.`);
    const r = await store.restoreBackup(target.name);
    console.log(`✓ merged ${target.name}: ${r.added} records added, ${r.updated} updated, ${r.notesAdded} notes added → ${Object.keys(store.state.review).length} records now`);
    return;
  }

  const workspace = new Workspace({ root: ROOT, config, log: console.log, dataRoot, options: { repoPath: opts.repoPath, pwResults: opts.pwResults, port: opts.port } });
  if (repo && !config.defaultRepo) config.defaultRepo = repo;

  let ctx = null;
  if (ref) {
    ctx = await workspace.open(ref, { sync: opts.sync });
    const st = ctx.store.stats();
    console.log(`\n  Sift · ${ctx.key} · "${ctx.store.state.pr.title}"`);
    console.log(`  ${st.done}/${st.total} files covered · ${st.byStatus.flagged} flagged · ${st.stale} stale${ctx.git ? ` · local clone ${ctx.git.dir}` : ""}`);
  }

  const server = createServer(workspace, { log: console.log });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  const base = `http://localhost:${server.address().port}`;
  const url = ref ? `${base}/pr/${ref.owner}/${ref.repo}/${ref.number}/` : `${base}/`;
  console.log(`\n  ${url}\n`);
  if (opts.open) openBrowser(url);

  if (ctx) {
    ctx.ci
      .ensureLoaded()
      .then(() => {
        const ci = ctx.ci;
        if (ci.state === "ready") {
          const st = ci.summary().stats;
          console.log(`✓ Playwright results: ${st.passed} passed · ${st.failed} failed · ${st.flaky} flaky · ${st.skipped} skipped${ci.run?.local ? " (local)" : ` (run #${ci.run.number} on ${ci.run.headSha.slice(0, 7)}${ci.run.behind ? `, ${ci.run.behind} commit${ci.run.behind > 1 ? "s" : ""} behind head` : ""})`}`);
        } else if (ci.state === "none") console.log("  No Playwright run found for commits in this PR.");
        else if (ci.state === "error") console.log(`! Playwright results: ${ci.error}`);
      })
      .catch(() => {});
    if (!ctx.xref.ready) {
      console.log("  Building cross-reference index (imports, usages, tests)…");
      ctx.xref
        .build()
        .then((st) => console.log(`✓ cross-reference index ready (${st.files} files)`))
        .catch((err) => console.log(`! cross-reference index failed: ${err.message}`));
    }
  }
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}

main().catch((err) => {
  console.error(`sift: ${err.message}`);
  process.exit(1);
});
