# Sift

A local, keyboard-first workbench for reviewing **very large pull requests** — the ones where GitHub's
Files tab gives up (300+ files, 50k+ lines) and you lose track of what you've actually read.

Sift pulls a PR down once, keeps your review state on disk, and gives you three *lenses* on the same
queue of files:

| Lens | Key | What it's for |
|------|-----|---------------|
| **Map** | `1` | *Where am I?* A heat-map of every file, grouped by reading tier → area, coloured by status and sized by lines changed. Progress, pace/ETA, commits. |
| **Deck** | `2` | *Do the work.* One file at a time. Read, press a status key, auto-advance to the next pending file. Rail on the left, notes on the right. |
| **Ledger** | `3` | *Triage & manage.* A table with filters and bulk actions — e.g. filter to `tests/`, `A` select all, `D` defer them all. |
| **Notes** | `4` | *What have I said?* Every note across the PR in one place — filter by kind, published/unpublished, "file changed since", on flagged files; flagged files that still have no note; export or publish from here. |

## Why it's different

- **Many PRs, one workbench.** `sift` with no arguments opens a picker: PRs you've started, PRs where
  your review is requested, open PRs in the repo. Each PR keeps its own state, index and CI results;
  switch with `⌘P` or the `⇄` button. URLs are per PR (`/pr/owner/repo/123/`), so tabs don't fight.
- **Stories: review by sub-PR, not by file.** Umbrella branches are decomposed into the pull requests
  that were merged into them (stacked PRs included, via first-parent history in your local clone, or
  the API). Each story carries its title, description, linked issues, author, review-comment count and
  **exactly the files its own commits touched**. Filter the queue to one story, order the queue by
  story, see per-story progress on the Map.
- **What's already been said.** Review threads from this PR *and* every merged sub-PR — humans and
  bots (Copilot, CARE PR Reviewer, Codex…) — are re-anchored to current lines and shown inline under the
  code, with resolved/outdated state. Bot threads are collapsed and can be hidden. A dialog lists the bot
  review summaries so you read them once instead of per file.
- **Moved code is folded.** Added lines that are verbatim copies of lines deleted elsewhere in the PR
  are detected (3-line shingles, boilerplate-aware) and folded into one row — "▸ 23 lines moved verbatim
  from X L40–62 · peek source". Deleted files tell you how much of them lives on ("rewrite — 8% reused").
  Order the queue by *Most new code first*.
- **Reviewer lint.** Cheap, high-signal checks on the lines the PR adds: `console.log`, `debugger`,
  `any`, `@ts-ignore`, `eslint-disable`, empty catch, index keys, hard-coded credentials, `.only` in
  tests, hard waits, hard-coded UI text, **i18n keys used but missing from `en.json`** (plural-aware),
  **new keys never used**, **removed keys still used**, undefined/unused permission constants, new
  components with no related spec. Inline under the line, in a side list, and as "Findings by rule".
- **Surface & Keys views.** `O` on a source file shows its API shape instead of the diff — exports with
  props and importer counts, data access (queries/mutations/API calls), hooks and effects, i18n keys,
  routes, permissions, test ids — each clickable to peek the code. On `en.json`, `O` turns the 2,000-line
  JSON diff into a key table grouped by prefix with the places each key is used.
- **Go to definition.** `⌥-click` any identifier in a diff to peek where it's defined (imports resolved
  through the index, local declarations, or any PR export). `⌥⇧-click` jumps.
- **Suggestion comments.** In a line note, *Suggest edit* pre-fills a GitHub ```` ```suggestion ````
  block with the selected lines; it publishes as a real suggestion.
- **Local clone superpowers.** If a checkout of the repo is found (`~/code/<repo>`, etc., or
  `--repo-path` / `repoPath` in config), Sift adds per-file **history** (commits/authors in the last
  6 months, "🔥 hot file") and **repo impact** — references outside the PR to symbols a modified file
  exports.

- **Attention tour.** `⇧J` / `⇧K` hop across everything that wants a human decision — lint findings,
  open review threads, specs with failing tests, files that changed since you reviewed them — in queue
  order, across files, without you hunting for them. `⇧L` lists them all; the header shows the count
  (`⚡ 70`). Pick which kinds take part (bot threads are off by default). Finished with a finding?
  Dismiss it with ✕ (⇧-click to say why): it leaves the counts, the tour and the filters, survives syncs,
  and can be restored from the inspector.
- **Hunk coverage.** The toolbar shows `4/9 seen`: how many of the file's hunks have actually been on
  screen (first, last and every 25th row of each). Marking a file *Reviewed* with hunks you never
  scrolled past says so in the toast — "reviewed" should mean you saw it.
- **A brief before the code.** The Map opens with what the author says this is: description, author,
  branches, **merge conflicts** if GitHub reports them, labels, linked/closed issues, the author's
  checklist progress, screenshots count — and an honest nudge when the description is empty.
- **Sitting planner.** "Last sitting: 14 files · 3,800 lines · 38 min · stopped at X" and "Next 30 min →
  7 files" at your measured pace (a default until Sift has learned yours), with the list and a start
  button. Review in deliberate chunks instead of until you drop.
- **Context on demand.** `↑ 20` / `↕ all` / `↓ 20` on any hunk header reveal more unchanged lines right
  there, with correct line numbers on both sides — no need to flip to the whole file.
- **Repro in one click.** Every failing test carries `⧉ copy repro command`:
  `npx playwright test <file>:<line> -g '<title>' --project=… --trace on --video on --retries 0`.
- **History across runs.** Sift reads the JSON report of the last six Playwright runs on the PR's commits
  (seconds each — artifacts are range-read, never downloaded) and shows every test's outcome sequence
  `··✗✗✗✗` with a verdict: **newly broken** (passed last run), **broken since run #N**, failing in every
  run (fixture/environment, not this change), flaky across runs, recovered. Per test in the outline, per
  spec in the CI bar, grouped in the CI dialog.
- **Structural risk, not line counts.** Once the cross-reference index is built, each file gets a score
  from how many changed files import it, how many exports it has, whether any spec exercises it,
  security-sensitive paths, wiring/config, heavy deletions — `risk 89 · imported by 20 changed files · no
  related spec · security-sensitive path`. The riskiest files sit on the Map; *Risk first* orders the
  queue by it.
- **Published notes stay yours.** Publishing records the GitHub comment id for every inline note. Edit a
  note in Sift and the comment on GitHub is updated; delete it and Sift asks whether to delete it there
  too. File-level notes live in the review body, which is rebuilt on edit. Published badges link straight
  to the comment.
- **Note templates.** Flag a file (`F`) or click a line number and the composer offers your templates:
  press `1`–`9`, `0` to insert one (it also sets the note kind), `/` to search them, or just start typing.
  Edit the list from the composer's *edit…* or the palette — one per line, `kind: text`. Shared across PRs.
- **Your history is safe.** State is written atomically, backed up on every change (every backup from
  the last 24 h, then one a day for 60 days, plus one whenever the record count *drops* and one on exit),
  and every save first merges whatever is on disk — so a second Sift process, a stray edit or a wiped
  file can never erase records. If the state ever looks emptier than a backup, the Map shows a banner
  with one-click restore (`sift <pr> --backups` / `--restore latest` from the CLI). Two instances on the
  same data directory warn each other.
- **Panels you can drag.** Resize the rail and the inspector; double-click an edge to reset.
- **Big files don't block.** Tables over ~2,000 rows render progressively — the first screens
  immediately, the rest in idle frames — so a 7,700-row locale file opens as fast as a small one.

- **Honest statuses, not a checkbox.** `Reviewed` (read carefully) · `Skimmed` (glanced, low-risk) ·
  `Flagged` (has concerns — add notes) · `Deferred` (come back later). Progress counts what you've
  actually covered.
- **Stale detection + "since my review".** Every status records the file's blob SHA. When you `↻ Sync`
  and the author has pushed, files you already covered turn **stale**, and one key (`I`) shows *only the
  diff between the version you reviewed and the current one* — not the whole PR diff again.
  Works across force-pushes because it diffs blobs, not commits.
- **Foundations-first queue.** Instead of alphabetical order, files are queued by tier:
  config → types → utils/hooks/state → components → pages → routing → docs/locale → tests, and within an
  area by contracts → helpers → UI → barrels. You read the vocabulary before the prose. Other orders:
  path, largest/smallest, risk, stale-first, recently touched.
- **Notes that go somewhere.** File-level or line-anchored (click a line number; ⇧-click to extend a
  range), each with a kind — *issue · question · suggestion · nitpick · praise · thought* — following
  [Conventional Comments](https://conventionalcomments.org), so the author can tell blocking from
  optional at a glance. Export as Markdown, or publish as a GitHub review: a **pending** draft you finish
  on github.com, or submit straight away as *Comment / Approve / Request changes* with a summary.
  Before posting, Sift tells you which notes sit outside the diff hunks (GitHub can't anchor those —
  they go in as file-level text) and which anchor to a file that changed after you wrote them, with an
  option to hold those back.
- **Search the diff, not the repo.** `⌘⇧F` (or `/` in the palette) greps every added/removed line in
  the PR — "where did `usePermissions` go?" — with hits grouped by file and jumping straight to the line.
- **Undo that actually undoes.** `Z` restores the exact previous record — status, reviewed SHA,
  timestamp — so undoing a mis-key never erases staleness or notes. Works for bulk actions too.
- **Related changes, one click away.** Sift indexes every import in the PR (resolving `@/`-style
  aliases from `tsconfig.json`) and shows, per file: its **exports with how many PR files use each**, who
  **uses** it (with the exact usage lines), what it **imports** (changed files first, unchanged repo files
  collapsed), **tests** that likely exercise it (matched through test ids and the i18n strings the spec
  asserts on), **former importers** of deleted files, and folder siblings. Click to jump straight to the
  usage line (`B` brings you back), or ⇧-click / ⧉ to **peek** it in a split pane under the current diff so
  you can check the definition and the call site side by side. New files nobody imports get a nudge.
- **Tests as scenarios, not code.** Spec files open as an **Outline**: each test becomes a readable
  sequence — *Go to … → Click button "Apply policy" → Fill "Start date" with … → Expect dialog "Record
  immunization" visible* — parsed from the real AST, every step linked to its line (click to peek the
  code). It flags `.only`, skipped/fixme tests, tests without an `expect()`, hard waits, and for modified
  specs tells you which tests are **new vs changed**. Press `O` for the raw diff.
- **CI results, without the 700 MB download.** Sift finds the latest Playwright run on one of the PR's
  commits, reads just `test-results.json` out of each shard artifact with HTTP range requests (seconds,
  not minutes), and overlays ✓ / ✗ / flaky / skipped + duration on every test, with the error, the failing
  line (jump to it, even in a helper), and **▶ video · 🔍 trace viewer · screenshot · page snapshot**
  streamed from the artifact only when you click. A run-level view clusters failures by cause (one broken
  fixture → 34 red tests), lists the slowest tests, and lets you switch between runs.
- **Diffs that cope.** GitHub omits patches for huge files — Sift fetches both blobs and diffs locally.
  Unified or split, syntax highlighting, word-level change marks, full-file mode for modified files,
  hunk navigation (`J`/`K`).
- **Pace.** After a handful of files, the header shows an ETA based on your actual lines-per-minute.
- **Everything is local.** State lives in `.review-data/<owner>__<repo>__<pr>/`. The only network calls
  are to GitHub via the `gh` CLI you already have authenticated.

## Configuration

`sift.config.json` next to the tool:

```json
{
  "defaultRepo": "ohcnetwork/care_fe",
  "repos": {
    "ohcnetwork/care_fe": {
      "repoPath": "~/code/care_fe",
      "i18n": ["public/locale/en.json"],
      "testDirs": ["tests"],
      "lint": { "disable": [] }
    }
  }
}
```

## Install

Requires Node ≥ 20 and an authenticated [`gh`](https://cli.github.com) (`gh auth status`).

```sh
cd github_review
npm install
npm link            # optional: puts `sift` on your PATH
```

## Use

```sh
sift https://github.com/ohcnetwork/care_fe/pull/17002
# or
sift ohcnetwork/care_fe#17002
sift 17002 --repo ohcnetwork/care_fe

sift <pr> --sync       # re-fetch before opening
sift <pr> --export     # print the Markdown notes report
sift <pr> --port 5000 --no-open
sift <pr> --playwright-results ./care_fe/test-results-dir   # use a local Playwright run instead of CI
sift <pr> --backups    # list the automatic backups of this PR's review state
sift <pr> --restore latest   # merge a backup back in (never removes anything)
sift <pr> --data-dir /tmp/sift-scratch   # experiment on a separate data directory (or SIFT_DATA_DIR)
```

> Running two copies of Sift against the same data directory is safe (writes merge), but if you want to
> *try things* — a different PR, a hacked build — point the second one at its own `--data-dir`.

Without `npm link`: `node bin/sift.mjs <pr>`.

The first run fetches the PR (a few seconds for ~600 files) and opens `http://localhost:4777`. Later runs
start from the local cache instantly; press **↻ Sync** whenever you want to pick up new commits.

## A typical session

1. **Map** — read the **Brief** (what the author says, conflicts, linked issues), pick a sitting length,
   and get a feel for the shape of the change. Big tiles are big files; the tier headings are the
   suggested reading order. Click any tile to open it.
2. **Ledger** — do a triage pass. Filter `7. Tests`, `A`, `D` to defer them all. Filter `Docs & locale`,
   skim or defer. Now the queue is only code.
3. **Deck** — press `.` to jump to the next pending file and work through it:
   `R` reviewed · `S` skimmed · `F` flag (type why, `⌘⏎` saves and advances) · `D` defer.
   Click a line number to leave an anchored note. `Z` undoes a mis-key. The toolbar's `n/m seen` tells you
   whether you've actually scrolled past every hunk; `↑ 20` on a hunk header shows more context.
   Reviewing a new component or API? Open **Related** in the right panel: click an export symbol or a
   *Used by* row to land on the call site, press `B` to come back; ⧉ peeks it underneath instead. The
   status dots on related rows tell you whether you've covered the other side yet.
   Short on time? `⇧J` walks the **attention tour** — findings, open threads, failing specs, stale files —
   so the signals get a decision even if every line doesn't get a read. Dismiss answered findings with ✕.
4. The author pushes. **↻ Sync** shows what moved: new commits, new files, and which of *your* reviewed
   files changed. Click **Re-review N stale** → each stale file opens with a banner and `I` shows just the
   delta since you last saw it. Re-press `R` when happy.
5. **Tests**: open any spec — the Outline shows what it covers; the CI bar shows whether it passed in the
   latest run on this PR. Red test? Read the error and failing line, hit ▶ for the retry video or 🔍 for
   the full trace. Use the **CI failing** filter chip to sweep all red specs, and "Failures by cause" on
   the Map to see whether they share one root cause.
6. **Notes** (`4`) — read everything you've written in one list, fix wording, check flagged files that
   still have no note, then **Export** for a write-up or **Publish** as a GitHub review (pending draft,
   or submit as comment / approve / request changes).

## Keyboard

```
Lenses       1 map · 2 deck · 3 ledger · 4 notes · ⌘K palette (files + commands) · ⌘⇧F search the diff · ? help
Tour         ⇧J ⇧K next/prev signal (findings · threads · failing specs · stale) · ⇧L list · ✕ dismiss a finding
Deck         → ] next · ← [ previous · . next pending · J K next/prev hunk · ↑20 ↓20 more context
             R reviewed · S skimmed · F flag · D defer · U clear · Z undo
             C file note · click line № (⇧-click = range) · ⌘⏎ save note · in a composer: 1–9,0 template · / search templates
             V split/unified · E full file · W wrap · I since-my-review · \ rail · N inspector · G open on GitHub
Views        O outline/surface/keys ↔ code · M fold moved code · ⌥-click identifier = peek definition
Tests        click step = peek code at that line · ▶ video · 🔍 trace · ▤ page snapshot
PRs          ⌘P switch pull request
Related      click row = jump to usage · ⇧-click or ⧉ = peek in split pane · B = back · Esc = close peek
Ledger       J K move · X select · A select all visible · ⏎ open · R S F D U apply to selection
Anywhere     T light/dark · Esc close
```

## How state works

- `files.json` — the PR's file list and patches at the last sync.
- `state.json` — your statuses (with the blob SHA + head commit at the time), notes, time spent per file,
  hunk coverage, dismissed findings, an event log (for pace and sittings), and sync history.
- `backups/` — rolling copies of `state.json` (`state-<local time>.json`, `-before-shrink`, `-exit`).
- `.locks/` — one heartbeat file per running Sift process, so instances can see each other.
- `../templates.json` — your note templates (data-root level, shared by every PR).
- `blobs/` — cached file contents, keyed by blob SHA.
- `graph.json` / `tree-<sha>.json` — the cross-reference index and repo tree for the current head
  (rebuilt automatically after a sync that moves the head).
- `ci/` — parsed Playwright results per run (`<run>.json`), compact outcome history for earlier runs
  (`hist-<run>.json`) and attachments extracted on demand.

### About test videos

Playwright only records what the config asks for. This repo uses `video: "on-first-retry"` and
`trace: "on-first-retry"`, so CI has recordings **only for tests that failed at least once** (the retry
attempt). Passing-first-time tests have no video. To review recordings of *every* test, run the suite
locally with recording on and point Sift at the output:

```sh
# in the care_fe checkout, with the backend running
npx playwright test --video=on --trace=on --reporter=json,html
# json goes to test-results.json (PLAYWRIGHT_JSON_OUTPUT_NAME to change), media under test-results/
sift ohcnetwork/care_fe#17002 --playwright-results /path/to/care_fe
```

Traces open in the hosted viewer (`trace.playwright.dev`) directly from Sift's local server — nothing is
uploaded; the viewer runs in your browser and fetches the trace from `localhost`.

Sift needs the JSON reporter in the artifacts (`["json", { outputFile: "test-results.json" }]`); the HTML
report alone isn't parsed.

A file is **stale** when its current blob SHA (or add/modify/delete status) differs from what you reviewed.
Files that disappear from the PR are kept in the ledger history but leave the queue.

## Layout

```
bin/sift.mjs       CLI
src/github.mjs     gh-backed GitHub API client
src/classify.mjs   tiers / areas / ranks / risk hints
src/store.mjs      persistence, sync + stale detection, fallback diffs, interdiff
src/publish.mjs    Markdown export, review builder + preflight, remote comment tracking (edit/delete follow-through)
src/xref.mjs       cross-reference index: imports/exports, usages, tests ↔ sources
src/tests.mjs      Playwright spec → scenario outline (AST-based)
src/ci.mjs         Playwright CI results: run discovery, range-read artifacts, media streaming, run history
src/zip.mjs        remote zip reader (central directory + per-entry extraction over HTTP ranges)
src/workspace.mjs  per-PR contexts, picker data (disk-cached PR list), config
src/config.mjs     sift.config.json: per-repo clone paths, aliases, lint options
src/stories.mjs    sub-PR decomposition (git first-parent walk / API fallback) + metadata
src/threads.mjs    review threads via GraphQL, re-anchored to current lines
src/moves.mjs      moved-code detection
src/lint.mjs       reviewer lint (generic + i18n/permissions rules)
src/risk.mjs       structural risk score per file (importers × exports × specs × sensitive paths)
src/surface.mjs    API-surface outline for source files
src/patchlines.mjs added-line numbers from a unified patch (shared by lint, test outlines, keys table)
src/git.mjs        local clone helper (history, grep, first-parent log)
src/features.mjs   route registrations for the above (stories, threads, moves, lint, surface, def, i18n, gitx, search)
src/server.mjs     HTTP + JSON API
web/               the UI (no build step; vanilla ES modules)
```
