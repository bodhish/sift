// Tool + per-repository configuration (sift.config.json next to the tool).
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_REPO_CONFIG = {
  repoPath: null, // local clone; auto-detected when null
  i18n: ["public/locale/en.json", "src/locale/en.json", "public/locales/en.json"],
  testDirs: ["tests", "test", "e2e", "cypress"],
  helperDirs: ["tests/helper", "tests/support", "tests/fixtures", "tests/utils"],
  routesGlob: /\/Routers?\/routes\//i,
  permissionsFile: /Permissions\.tsx?$/,
  lint: { disable: [] },
  bots: ["copilot", "github-actions", "care-pr-reviewer", "coderabbitai", "sonarcloud", "codecov", "dependabot", "renovate"],
};

export async function loadConfig(root) {
  let user = {};
  try {
    user = JSON.parse(await fs.readFile(path.join(root, "sift.config.json"), "utf8"));
  } catch {}
  return {
    defaultRepo: user.defaultRepo || null,
    repos: user.repos || {},
    forRepo(owner, repo) {
      const key = `${owner}/${repo}`;
      const o = user.repos?.[key] || user.repos?.[key.toLowerCase()] || {};
      return { ...DEFAULT_REPO_CONFIG, ...o, lint: { ...DEFAULT_REPO_CONFIG.lint, ...(o.lint || {}) } };
    },
  };
}
