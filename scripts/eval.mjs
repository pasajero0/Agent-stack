#!/usr/bin/env node
// Eval runner: runs the regression tasks through the driver. Plain Node ESM, built-ins only. Never builds.
// The parts live in scripts/eval/: checks, child (spawn and stop), try, report.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { checkTasks, parseArgs, pickTasks } from "./eval/checks.mjs";
import { handleSignals } from "./eval/child.mjs";
import { plural, refuse } from "./eval/common.mjs";
import { repoState, report, taskResult, tryLine } from "./eval/report.mjs";
import { oneTry } from "./eval/try.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The checks before any try, in the Contract's order (AC-1).
const opts = parseArgs(process.argv.slice(2));
const tasksDir = opts.tasksDir ?? join(REPO_ROOT, "evals", "tasks");
for (const id of opts.tasks) {
  if (!existsSync(join(tasksDir, id, "task.json"))) refuse(`--task ${id}: no ${id}/task.json in ${tasksDir}`);
}
if (!existsSync(join(REPO_ROOT, "dist", "index.js"))) refuse("dist/ is missing: run pnpm build first");
const picked = pickTasks(tasksDir, opts.tasks);
checkTasks(tasksDir, picked);

// Estimate and start question (AC-2, AC-11).
const tries = picked.length * opts.k;
const estimate =
  `${plural(picked.length, "task", "tasks")} × ${plural(opts.k, "try", "tries")} = ${plural(tries, "try", "tries")}, ` +
  `about $${(tries * 0.1).toFixed(2)} with the real claude.`;

function readAnswer() {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin });
    rl.once("line", (line) => {
      resolveAnswer(line);
      rl.close();
    });
    rl.once("close", () => resolveAnswer(""));
  });
}

if (opts.yes) {
  process.stdout.write(`${estimate}\n`);
} else {
  const isTerminal = Boolean(process.stdin.isTTY) || process.env.AGENT_STACK_EVAL_TTY === "1";
  if (!isTerminal) {
    process.stdout.write(`${estimate}\n`);
    refuse("not started");
  }
  process.stdout.write(`${estimate} Start? [y/N]\n`);
  const answer = (await readAnswer()).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") refuse("not started");
}

handleSignals(opts.keep);

// The try loop: eval tasks in order of id, their tries one after another, 1 to k.
const tryOpts = { cli: join(REPO_ROOT, "bin", "cli.mjs"), timeoutMin: opts.timeoutMin, keep: opts.keep };
const startedAt = new Date();
const { commit, dirty } = await repoState(REPO_ROOT);
const taskResults = [];
for (const id of picked) {
  const taskDir = join(tasksDir, id);
  const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
  const done = [];
  for (let n = 1; n <= opts.k; n++) {
    const { result, kept } = await oneTry(taskDir, task, n, tryOpts);
    done.push(result);
    process.stdout.write(`${tryLine(id, result, opts.k, kept)}\n`);
  }
  taskResults.push(taskResult(id, task.expect, done, opts.k));
}
const finishedAt = new Date();

report({
  repoRoot: REPO_ROOT,
  outDir: opts.out ?? join(REPO_ROOT, "evals", "results"),
  k: opts.k,
  taskResults,
  startedAt,
  finishedAt,
  commit,
  dirty,
});
process.exitCode = 0;
