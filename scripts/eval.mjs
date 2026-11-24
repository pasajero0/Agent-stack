#!/usr/bin/env node
// Eval runner: runs the regression tasks through the driver. Plain Node ESM, built-ins only. Never builds.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const VALUE_FLAGS = new Set(["--k", "--task", "--tasks-dir", "--out", "--timeout-min"]);
const BOOL_FLAGS = new Set(["--yes", "--keep"]);

function parseArgs(argv) {
  const o = { k: 3, tasks: [], tasksDir: null, out: null, timeoutMin: null, yes: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (BOOL_FLAGS.has(flag)) {
      o[flag.slice(2)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) refuse(`unknown flag: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) refuse(`${flag} needs a value`);
    i++;
    if (flag === "--k") {
      if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 20) {
        refuse(`--k must be an integer from 1 to 20, got: ${value}`);
      }
      o.k = Number(value);
    } else if (flag === "--timeout-min") {
      const n = Number(value);
      if (value.trim() === "" || !Number.isFinite(n) || n <= 0) refuse(`--timeout-min must be a number > 0, got: ${value}`);
      o.timeoutMin = n;
    } else if (flag === "--task") {
      if (!ID_PATTERN.test(value)) refuse(`--task value is not a valid task id: ${value}`);
      if (!o.tasks.includes(value)) o.tasks.push(value);
    } else if (flag === "--tasks-dir") {
      o.tasksDir = resolve(value);
    } else if (flag === "--out") {
      o.out = resolve(value);
    }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const tasksDir = opts.tasksDir ?? join(REPO_ROOT, "evals", "tasks");
for (const id of opts.tasks) {
  if (!existsSync(join(tasksDir, id, "task.json"))) refuse(`--task ${id}: no ${id}/task.json in ${tasksDir}`);
}
if (!existsSync(join(REPO_ROOT, "dist", "index.js"))) refuse("dist/ is missing: run pnpm build first");
