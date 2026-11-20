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
        test: { name: "slow", include: SLOW, pool: "forks" },
      },
    ],
  },
});
