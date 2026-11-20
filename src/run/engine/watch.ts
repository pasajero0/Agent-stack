/**
 * `run --watch`: the run live, read only from its run folder. Spec: docs/specs/v04/SPEC.md, AC-82.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRun, runDir } from "../store.js";
import { resumeHint } from "./context.js";
import { clock, times } from "./timing.js";

/** Lines of progress.log shown under the step in progress. */
export const TAIL = 5;

/** The last lines of progress.log for `step`, without the step's own start line. */
function stepLines(dir: string, step: string): string[] {
  const file = join(dir, "progress.log");
  if (!existsSync(file)) return [];
  const out: string[] = [];
  for (const row of readFileSync(file, "utf8").split("\n")) {
    const [, s, text] = row.split("\t");
    if (s === step && text !== undefined && !text.startsWith("step ")) out.push(text);
  }
  return out.slice(-TAIL);
}

/** The view of run `id` (AC-82), or null when it does not exist. */
export function watchView(projectDir: string, id: string, now: Date = new Date()): string | null {
  const run = readRun(projectDir, id);
  if (!run) return null;
  const dir = runDir(projectDir, id);
  const { workSec } = times(run, now);
  const lines = [`run ${run.id} · ${run.mode} · ${run.status} · ${clock(workSec)} work · $${run.costUsd.toFixed(2)}`];
  const width = Math.max(12, ...run.steps.map((s) => s.step.length));
  for (const s of run.steps) {
    const sec = Math.max(0, Math.round(((s.end === null ? now.getTime() : Date.parse(s.end)) - Date.parse(s.start)) / 1000));
    if (s.end !== null) {
      // A gate's time is the human's, not the machine's work (AC-81).
      lines.push(`  ✓ ${s.step.padEnd(width)}  ${clock(sec)}${s.step.startsWith("gate:") ? " waiting for you" : ""}`);
    } else if (s.step.startsWith("gate:") && run.status === "waiting") {
      lines.push(`  ⏸ waiting at ${s.step} — answer: ${run.card?.hint ?? resumeHint(run.id)}`);
    } else {
      lines.push(`  ▶ ${s.step.padEnd(width)}  ${clock(sec)}`);
      for (const l of stepLines(dir, s.step)) lines.push(`      ${l}`);
    }
  }
  return lines.join("\n");
}
