// One try (AC-3 to AC-6, AC-12 to AC-14): prepare the temp copy, run the driver, read the outcome, check, score.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChild, state } from "./child.mjs";

/** Makes the temp copy; `failed` names the prepare part that failed, else null; `timedOut` when the try timeout passed. */
async function prepare(cli, taskDir, fixture, deadline) {
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "agent-stack-eval-"));
    state.currentDir = dir;
    cpSync(join(taskDir, fixture), dir, { recursive: true });
  } catch {
    return { dir, failed: "copy", timedOut: false };
  }
  const parts = [
    ["git", "git", ["init", "-q", "-b", "main"]],
    ["git", "git", ["config", "--local", "user.name", "agent-stack eval"]],
    ["git", "git", ["config", "--local", "user.email", "eval@agent-stack.invalid"]],
    ["git", "git", ["config", "--local", "commit.gpgsign", "false"]],
    ["generate", process.execPath, [cli, "generate"]],
    ["commit", "git", ["add", "-A"]],
    ["commit", "git", ["commit", "-q", "--no-verify", "-m", "chore: eval fixture"]],
  ];
  for (const [part, cmd, args] of parts) {
    const r = await runChild(cmd, args, dir, { deadline });
    if (r.timedOut) return { dir, failed: null, timedOut: true };
    if (r.code !== 0) return { dir, failed: part, timedOut: false };
  }
  return { dir, failed: null, timedOut: false };
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

/**
 * One try: prepare, start, read, check, score, clean. `opts` holds `cli`, `timeoutMin` and `keep`.
 * Returns the try record and the kept path.
 */
export async function oneTry(taskDir, task, n, opts) {
  const cli = opts.cli;
  const answers = task.answers ?? [];
  // AC-14: the try timeout runs from the start of prepare to the end of the check.
  const deadline = Date.now() + (opts.timeoutMin ?? 30) * 60_000;
  const prep = await prepare(cli, taskDir, task.fixture, deadline);
  let result;
  if (prep.failed !== null || prep.timedOut) {
    result = {
      n, outcome: "error", check: null, pass: false, runId: null, costUsd: 0, costUnknownCalls: 0,
      durationSec: 0, unusedAnswers: 0, error: prep.timedOut ? "timeout" : `prepare: ${prep.failed} failed`,
    };
  } else {
    const started = Date.now();
    const driverRun = (args) => runChild(process.execPath, [cli, "run", ...args], prep.dir, { kind: "driver", deadline });
    let driver = await driverRun(
      task.cell === undefined ? ["quick", task.description] : ["quick", "--cell", task.cell, task.description],
    );
    let o = readOutcome(prep.dir, driver);
    // AC-5: at a gate (exit 3) each --resume gets one answer, in order; a refused --resume (exit 1) ends the loop (AC-12).
    let next = 0;
    while (!driver.timedOut && driver.code === 3 && o.outcome.startsWith("gate:") && o.runId !== null && next < answers.length) {
      driver = await driverRun(["--resume", o.runId, "--answer", answers[next++]]);
      o = readOutcome(prep.dir, driver);
    }
    const checked = driver.timedOut ? null : await runChild("/bin/sh", ["-c", task.check], prep.dir, { deadline });
    const timedOut = checked === null || checked.timedOut;
    const check = timedOut ? null : checked.code;
    result = {
      n, outcome: timedOut ? "error" : o.outcome, check, pass: !timedOut && o.outcome === task.expect && check === 0,
      runId: o.runId, costUsd: o.costUsd, costUnknownCalls: o.costUnknownCalls,
      durationSec: Math.round((Date.now() - started) / 1000), unusedAnswers: answers.length - next,
      error: timedOut ? "timeout" : o.error === null ? null : capError(o.error),
    };
  }
  let kept = null;
  if (prep.dir !== null) {
    if (opts.keep) kept = prep.dir;
    else rmSync(prep.dir, { recursive: true, force: true });
  }
  state.currentDir = null;
  return { result, kept };
}
