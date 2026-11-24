// The report (AC-7, AC-15, AC-19 to AC-21, AC-23): try lines, the table, the totals line and the results file.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { runChild } from "./child.mjs";
import { clock, localDate, pad2, plural, refuse, round2, shown, stamp } from "./common.mjs";

const unknownCost = (u) => `${plural(u, "call", "calls")} with unknown cost`;
const sum = (list, key) => list.reduce((s, t) => s + t[key], 0);

export function tryLine(id, t, k, kept) {
  let line = `${shown(id)} ${t.n}/${k}: ${shown(t.outcome)} · check ${t.check ?? "-"} · ${t.pass ? "pass" : "fail"} · `;
  line += `$${t.costUsd.toFixed(2)} · ${clock(t.durationSec)}`;
  if (t.costUnknownCalls > 0) line += ` · ${unknownCost(t.costUnknownCalls)}`;
  if (t.unusedAnswers > 0) line += ` · ${plural(t.unusedAnswers, "answer", "answers")} not used`;
  if (t.error !== null) line += ` · ${shown(t.error)}`;
  if (kept !== null) line += ` · kept ${kept}`;
  return line;
}

/** `commit` and `dirty` of the repo root; both null when git cannot tell. */
export async function repoState(repoRoot) {
  const head = await runChild("git", ["rev-parse", "HEAD"], repoRoot);
  const status = await runChild("git", ["--no-optional-locks", "status", "--porcelain"], repoRoot);
  if (head.code !== 0 || status.code !== 0) return { commit: null, dirty: null };
  return { commit: head.stdout.trim(), dirty: status.stdout !== "" };
}

function agentStackVersion(repoRoot) {
  try {
    const v = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The record of one eval task from its scored tries. */
export function taskResult(id, expect, tries, k) {
  const passed = tries.filter((t) => t.pass).length;
  return { id, expect, tries, passed, pass1: round2(passed / k), passK: passed === k ? 1 : 0 };
}

function totalsOf(taskResults) {
  const all = taskResults.flatMap((t) => t.tries);
  return {
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
}

function printTable(taskResults, totals, k, startedAt) {
  const rows = [["task", "expect", "tries", "passed", "pass@1", `pass^${k}`, "cost", "time"]];
  for (const t of taskResults) {
    const cells = [t.id, t.expect, t.tries.length, t.passed, t.pass1.toFixed(2), t.passK, `$${sum(t.tries, "costUsd").toFixed(2)}`];
    rows.push([...cells.map((c) => shown(c)), clock(sum(t.tries, "durationSec"))]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) process.stdout.write(`${r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()}\n`);
  const unknownPart = totals.costUnknownCalls > 0 ? ` · ${unknownCost(totals.costUnknownCalls)}` : "";
  process.stdout.write(
    `total: ${plural(totals.tasks, "task", "tasks")} · ${plural(totals.tries, "try", "tries")} · ${totals.passed} passed · ` +
      `pass@1 ${totals.pass1.toFixed(2)} · pass^${k} ${totals.passK.toFixed(2)} · $${totals.costUsd.toFixed(2)} · ` +
      `${clock(totals.durationSec)}${unknownPart} · k ${k} · ${localDate(startedAt)}\n`,
  );
}

/** `wx` never overwrites: a taken name moves on to -2, -3, … (AC-21). Returns the path written. */
function writeResults(outDir, name, body) {
  let target = join(outDir, `${name}.json`);
  try {
    mkdirSync(outDir, { recursive: true });
    for (let i = 2; ; i++) {
      try {
        writeFileSync(target, body, { flag: "wx" });
        return target;
      } catch (e) {
        if (e?.code !== "EEXIST") throw e;
        target = join(outDir, `${name}-${i}.json`);
      }
    }
  } catch {
    refuse(`cannot write ${target}`);
  }
  return target;
}

/** Prints the table and the totals line, writes the results file and prints the `results:` line. */
export function report({ repoRoot, outDir, k, taskResults, startedAt, finishedAt, commit, dirty }) {
  const totals = totalsOf(taskResults);
  printTable(taskResults, totals, k, startedAt);
  const resultsFile = {
    version: 1,
    startedAt: stamp(startedAt),
    finishedAt: stamp(finishedAt),
    k,
    agentStack: agentStackVersion(repoRoot),
    commit,
    dirty,
    claude: process.env.AGENT_STACK_CLAUDE ? basename(process.env.AGENT_STACK_CLAUDE) : "claude",
    tasks: taskResults.map((t) => ({ ...t, tries: t.tries.map((x) => ({ ...x, costUsd: round2(x.costUsd) })) })),
    totals: { ...totals, costUsd: round2(totals.costUsd) },
  };
  const name = `${localDate(startedAt)}-${pad2(startedAt.getHours())}${pad2(startedAt.getMinutes())}${pad2(startedAt.getSeconds())}`;
  const target = writeResults(outDir, name, `${JSON.stringify(resultsFile, null, 2)}\n`);
  process.stdout.write(`results: ${target}\n`);
}
