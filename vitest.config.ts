import { defineConfig } from "vitest/config";

/**
 * Two groups (CONTRIBUTING.md → Tests). Slow tests spawn bash and git in temp repos; on a loaded CI runner many of
 * them at once made unrelated tests fail, so they run after the fast ones, and on CI in fewer processes.
 */
const SLOW = [
  "tests/hooks/**/*.test.ts",
  "tests/e2e/**/*.test.ts",
  "tests/run/engine-*.test.ts",
  "tests/run/e2e.test.ts",
  "tests/run/frozen.test.ts",
  "tests/run/git.test.ts",
  "tests/run/progress.test.ts",
  "tests/run/scout-prompts.test.ts",
  "tests/run/timing.test.ts",
  "tests/run/watch.test.ts",
  "tests/eval/**/*.test.ts",
  "tests/claude/sandbox-update.test.ts",
  "tests/claude/sandbox-merge.test.ts",
  "tests/claude/sandbox-lists.test.ts",
  "tests/claude/sandbox-tools.test.ts",
];

export default defineConfig({
  test: {
    globals: true,
    workspace: [
      {
        extends: true,
        test: { name: "fast", include: ["tests/**/*.test.ts"], exclude: SLOW },
      },
      {
        extends: true,
        // Fewer processes on CI come from the CLI (`--maxWorkers`): vitest takes it per run, not per project.
        // 20 s a test: a whole driver path spawns git and the fake many times, and passed 5.04 s under load.
        test: { name: "slow", include: SLOW, pool: "forks", testTimeout: 20_000 },
      },
    ],
  },
});
