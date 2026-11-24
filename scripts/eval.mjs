#!/usr/bin/env node
// Eval runner: runs the regression tasks through the driver. Plain Node ESM, built-ins only. Never builds.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
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

const EXPECT_REASONS = ["attempts", "blocked", "review-loop", "fuse", "decision", "test-conflict", "tests-changed"];
const KNOWN_KEYS = ["mode", "description", "fixture", "check", "expect", "answers"];

const isText = (v) => typeof v === "string" && v.trim() !== "";

/** True when `dir` holds no symlink at any depth (the dir itself is checked by the caller). */
function hasNoSymlink(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return false;
    if (entry.isDirectory() && !hasNoSymlink(join(dir, entry.name))) return false;
  }
  return true;
}

function fixtureOk(taskDir, fixture) {
  if (!isText(fixture) || isAbsolute(fixture)) return false;
  const parts = fixture.split(/[\\/]/);
  if (parts.includes("..") || parts.every((p) => p === "" || p === ".")) return false;
  try {
    const path = join(taskDir, fixture);
    if (lstatSync(path).isSymbolicLink()) return false;
    const real = realpathSync(path);
    const root = realpathSync(taskDir);
    if (!statSync(real).isDirectory() || !real.startsWith(root + sep)) return false;
    return hasNoSymlink(real);
  } catch {
    return false;
  }
}

/** Every problem of one task.json, as lines. */
function validateTask(id, taskDir) {
  const at = `${id}/task.json`;
  let data;
  try {
    data = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
  } catch {
    return [`${at}: not JSON`];
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [`${at}: not an object`];
  const problems = [];
  const rules = {
    mode: [(v) => v === "quick", 'mode: must be "quick"'],
    description: [(v) => isText(v) && !v.trim().startsWith("-") && !v.startsWith("-"), "description: must be a text that does not start with -"],
    fixture: [(v) => fixtureOk(taskDir, v), `fixture: must be a folder inside ${id}/ with no symlinks`],
    check: [isText, "check: must be a command"],
    expect: [
      (v) =>
        typeof v === "string" &&
        (["finished", "cancelled", "gate:accept"].includes(v) ||
          (v.startsWith("gate:limit ") && EXPECT_REASONS.includes(v.slice("gate:limit ".length)))),
      "expect: must be finished, cancelled, gate:accept or gate:limit <reason>",
    ],
  };
  for (const field of Object.keys(rules)) {
    if (!Object.hasOwn(data, field)) problems.push(`${at}: ${field}: missing`);
    else if (!rules[field][0](data[field])) problems.push(`${at}: ${rules[field][1]}`);
  }
  if (Object.hasOwn(data, "answers") && !(Array.isArray(data.answers) && data.answers.every((a) => typeof a === "string"))) {
    problems.push(`${at}: answers: must be a list of texts`);
  }
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.includes(key)) problems.push(`${at}: unknown key ${key.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")}`);
  }
  return problems;
}

// Pick the eval tasks: folders holding a task.json (or only the --task ids), sorted by id.
let picked = [];
let folders = [];
try {
  folders = readdirSync(tasksDir, { withFileTypes: true });
} catch {
  folders = [];
}
if (opts.tasks.length > 0) {
  picked = [...opts.tasks];
} else {
  for (const f of folders) {
    if (f.isDirectory() && existsSync(join(tasksDir, f.name, "task.json"))) picked.push(f.name);
  }
}
picked.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
if (picked.length === 0) refuse(`no eval tasks in ${tasksDir}`);

const problems = [];
for (const id of picked) {
  if (!ID_PATTERN.test(id)) {
    problems.push(`${tasksDir}/${id}: not a valid eval task id`);
    continue;
  }
  problems.push(...validateTask(id, join(tasksDir, id)));
}
if (problems.length > 0) refuse(problems.join("\n"));

// Estimate and start question.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
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
