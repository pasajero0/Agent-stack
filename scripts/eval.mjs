#!/usr/bin/env node
// Eval runner: runs the regression tasks through the driver. Plain Node ESM, built-ins only. Never builds.
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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

// The try loop (AC-3, AC-4, AC-6, AC-7, AC-13, AC-21).
const CLI = join(REPO_ROOT, "bin", "cli.mjs");
const DROPPED_ENV = ["AGENT_STACK_GATE_INPUT", "AGENT_STACK_RUN", "AGENT_STACK_EVAL_TTY"];
const shown = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
const round2 = (x) => Math.round(x * 100) / 100;
const pad2 = (n) => String(n).padStart(2, "0");
const clock = (sec) => `${Math.floor(sec / 60)}:${pad2(sec % 60)}`;
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Local time with its offset, whole seconds: 2026-11-24T15:30:00+03:00. */
function stamp(d) {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${localDate(d)}T${time}${off >= 0 ? "+" : "-"}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

/** The eval runner's env minus the driver's seams and every GIT_* variable, so git never acts on this repo. */
function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!DROPPED_ENV.includes(key) && !key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

/** One child: an argv array, no shell, its own process group, stdin ignored. */
function runChild(cmd, args, cwd) {
  return new Promise((done) => {
    const r = { code: null, stdout: "", stderr: "" };
    let ended = false;
    const end = () => {
      if (!ended) done(r);
      ended = true;
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: childEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      r.stderr = String(e);
      end();
      return;
    }
    child.stdout.on("data", (d) => (r.stdout += d));
    child.stderr.on("data", (d) => (r.stderr += d));
    child.on("error", (e) => {
      r.stderr += String(e);
      end();
    });
    child.on("close", (code) => {
      r.code = code;
      end();
    });
  });
}

/** Makes the temp copy; `failed` names the prepare part that failed, else null. */
async function prepare(taskDir, fixture) {
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "agent-stack-eval-"));
    cpSync(join(taskDir, fixture), dir, { recursive: true });
  } catch {
    return { dir, failed: "copy" };
  }
  const parts = [
    ["git", "git", ["init", "-q", "-b", "main"]],
    ["git", "git", ["config", "--local", "user.name", "agent-stack eval"]],
    ["git", "git", ["config", "--local", "user.email", "eval@agent-stack.invalid"]],
    ["git", "git", ["config", "--local", "commit.gpgsign", "false"]],
    ["generate", process.execPath, [CLI, "generate"]],
    ["commit", "git", ["add", "-A"]],
    ["commit", "git", ["commit", "-q", "--no-verify", "-m", "chore: eval fixture"]],
  ];
  for (const [part, cmd, args] of parts) {
    if ((await runChild(cmd, args, dir)).code !== 0) return { dir, failed: part };
  }
  return { dir, failed: null };
}

/** The error of a driver exit other than 0 or 3 (AC-12). */
function crashText(r) {
  const last = (text, skip) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !skip.test(l)).pop();
  return last(r.stderr, /^Node\.js v[0-9]/) ?? last(r.stdout, /^$/) ?? `exit ${r.code}`;
}

/** The outcome by the Contract's Outcome table, with the run id and the cost from the run file. */
function readOutcome(dir, r) {
  const runs = join(dir, ".claude", "tmp", "runs");
  let folders = [];
  try {
    folders = readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    folders = [];
  }
  let run = null;
  if (folders.length === 1) {
    try {
      const v = JSON.parse(readFileSync(join(runs, folders[0], "run.json"), "utf8"));
      if (v !== null && typeof v === "object" && !Array.isArray(v)) run = v;
    } catch {
      run = null;
    }
  }
  const base = {
    runId: folders.length === 1 ? folders[0] : null,
    costUsd: typeof run?.costUsd === "number" && Number.isFinite(run.costUsd) && run.costUsd >= 0 ? run.costUsd : 0,
    costUnknownCalls: Number.isInteger(run?.costUnknownCalls) && run.costUnknownCalls > 0 ? run.costUnknownCalls : 0,
    error: null,
  };
  const error = (text) => ({ ...base, outcome: "error", error: text });
  if (r.code !== 0 && r.code !== 3) return error(crashText(r));
  if (folders.length > 1) return error("more than one run folder");
  if (run === null) return error("no run file");
  if (r.code === 0 && (run.status === "finished" || run.status === "cancelled")) return { ...base, outcome: run.status };
  if (r.code === 3 && run.status === "waiting" && typeof run.next === "string") {
    if (run.next === "gate:limit") return { ...base, outcome: `gate:limit ${run.limitReason ?? "unknown"}` };
    if (run.next.startsWith("gate:")) return { ...base, outcome: run.next };
  }
  return error("unexpected driver state");
}

/** One line, at most 200 characters. */
function capError(text) {
  const line = String(text).replace(/\s*[\r\n]+\s*/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** One try: prepare, start, read, check, score, clean. Returns the try record and the kept path. */
async function oneTry(taskDir, task, n) {
  const answers = task.answers ?? [];
  const prep = await prepare(taskDir, task.fixture);
  let result;
  if (prep.failed !== null) {
    result = {
      n, outcome: "error", check: null, pass: false, runId: null, costUsd: 0, costUnknownCalls: 0,
      durationSec: 0, unusedAnswers: 0, error: `prepare: ${prep.failed} failed`,
    };
  } else {
    const started = Date.now();
    const o = readOutcome(prep.dir, await runChild(process.execPath, [CLI, "run", "quick", task.description], prep.dir));
    const check = (await runChild("/bin/sh", ["-c", task.check], prep.dir)).code;
    result = {
      n, outcome: o.outcome, check, pass: o.outcome === task.expect && check === 0, runId: o.runId,
      costUsd: o.costUsd, costUnknownCalls: o.costUnknownCalls, durationSec: Math.round((Date.now() - started) / 1000),
      unusedAnswers: answers.length, error: o.error === null ? null : capError(o.error),
    };
  }
  let kept = null;
  if (prep.dir !== null) {
    if (opts.keep) kept = prep.dir;
    else rmSync(prep.dir, { recursive: true, force: true });
  }
  return { result, kept };
}

const unknownCost = (u) => `${plural(u, "call", "calls")} with unknown cost`;

function tryLine(id, t, kept) {
  let line = `${shown(id)} ${t.n}/${opts.k}: ${shown(t.outcome)} · check ${t.check ?? "-"} · ${t.pass ? "pass" : "fail"} · `;
  line += `$${t.costUsd.toFixed(2)} · ${clock(t.durationSec)}`;
  if (t.costUnknownCalls > 0) line += ` · ${unknownCost(t.costUnknownCalls)}`;
  if (t.unusedAnswers > 0) line += ` · ${plural(t.unusedAnswers, "answer", "answers")} not used`;
  if (t.error !== null) line += ` · ${shown(t.error)}`;
  if (kept !== null) line += ` · kept ${kept}`;
  return line;
}

/** `commit` and `dirty` of the repo root; both null when git cannot tell. */
async function repoState() {
  const head = await runChild("git", ["rev-parse", "HEAD"], REPO_ROOT);
  const status = await runChild("git", ["--no-optional-locks", "status", "--porcelain"], REPO_ROOT);
  if (head.code !== 0 || status.code !== 0) return { commit: null, dirty: null };
  return { commit: head.stdout.trim(), dirty: status.stdout !== "" };
}

function agentStackVersion() {
  try {
    const v = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

const startedAt = new Date();
const { commit, dirty } = await repoState();
const taskResults = [];
for (const id of picked) {
  const taskDir = join(tasksDir, id);
  const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
  const done = [];
  for (let n = 1; n <= opts.k; n++) {
    const { result, kept } = await oneTry(taskDir, task, n);
    done.push(result);
    process.stdout.write(`${tryLine(id, result, kept)}\n`);
  }
  const passed = done.filter((t) => t.pass).length;
  taskResults.push({ id, expect: task.expect, tries: done, passed, pass1: round2(passed / opts.k), passK: passed === opts.k ? 1 : 0 });
}
const finishedAt = new Date();

const all = taskResults.flatMap((t) => t.tries);
const sum = (list, key) => list.reduce((s, t) => s + t[key], 0);
const totals = {
  tasks: taskResults.length,
  tries: all.length,
  passed: all.filter((t) => t.pass).length,
  pass1: round2(all.filter((t) => t.pass).length / all.length),
  passK: round2(taskResults.filter((t) => t.passK === 1).length / taskResults.length),
  costUsd: sum(all, "costUsd"),
  costUnknownCalls: sum(all, "costUnknownCalls"),
  triesWithUnknownCost: all.filter((t) => t.costUnknownCalls > 0).length,
  durationSec: sum(all, "durationSec"),
};

const rows = [["task", "expect", "tries", "passed", "pass@1", `pass^${opts.k}`, "cost", "time"]];
for (const t of taskResults) {
  const cells = [t.id, t.expect, t.tries.length, t.passed, t.pass1.toFixed(2), t.passK, `$${sum(t.tries, "costUsd").toFixed(2)}`];
  rows.push([...cells.map((c) => shown(c)), clock(sum(t.tries, "durationSec"))]);
}
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) process.stdout.write(`${r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()}\n`);
const unknownPart = totals.costUnknownCalls > 0 ? ` · ${unknownCost(totals.costUnknownCalls)}` : "";
process.stdout.write(
  `total: ${plural(totals.tasks, "task", "tasks")} · ${plural(totals.tries, "try", "tries")} · ${totals.passed} passed · ` +
    `pass@1 ${totals.pass1.toFixed(2)} · pass^${opts.k} ${totals.passK.toFixed(2)} · $${totals.costUsd.toFixed(2)} · ` +
    `${clock(totals.durationSec)}${unknownPart} · k ${opts.k} · ${localDate(startedAt)}\n`,
);

const resultsFile = {
  version: 1,
  startedAt: stamp(startedAt),
  finishedAt: stamp(finishedAt),
  k: opts.k,
  agentStack: agentStackVersion(),
  commit,
  dirty,
  claude: process.env.AGENT_STACK_CLAUDE ? basename(process.env.AGENT_STACK_CLAUDE) : "claude",
  tasks: taskResults.map((t) => ({ ...t, tries: t.tries.map((x) => ({ ...x, costUsd: round2(x.costUsd) })) })),
  totals: { ...totals, costUsd: round2(totals.costUsd) },
};
const outDir = opts.out ?? join(REPO_ROOT, "evals", "results");
const name = `${localDate(startedAt)}-${pad2(startedAt.getHours())}${pad2(startedAt.getMinutes())}${pad2(startedAt.getSeconds())}`;
let target = join(outDir, `${name}.json`);
try {
  mkdirSync(outDir, { recursive: true });
  // `wx` never overwrites: a taken name moves on to -2, -3, … (AC-21).
  for (let i = 2; ; i++) {
    try {
      writeFileSync(target, `${JSON.stringify(resultsFile, null, 2)}\n`, { flag: "wx" });
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      target = join(outDir, `${name}-${i}.json`);
    }
  }
} catch {
  refuse(`cannot write ${target}`);
}
process.stdout.write(`results: ${target}\n`);
process.exitCode = 0;
