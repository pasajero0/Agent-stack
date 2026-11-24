/**
 * `run --watch`: the run live, read only from its run folder. Spec: docs/specs/v04/SPEC.md, AC-82.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readLock, readRun, runDir } from "../store.js";
import { commandName } from "./command.js";
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

export interface WatchOptions {
  projectDir: string;
  id?: string;
  out?: (line: string) => void;
  isTTY?: boolean;
  signal?: AbortSignal;
  write?: (text: string) => void;
}

/**
 * `run --watch` (AC-82): the run live, read only. At a terminal it redraws once a second until the run is
 * finished or cancelled, or the signal aborts (Ctrl-C); without one it prints the view once. Always exit 0.
 */
export async function watchRun(o: WatchOptions): Promise<0> {
  const dir = o.projectDir;
  const out = o.out ?? ((line: string) => console.log(line));
  const id = o.id ?? readLock(dir)?.id;
  if (!id) {
    out(`No run holds the lock. Name one: ${commandName()} run --watch <run id>.`);
    return 0;
  }
  const first = watchView(dir, id);
  if (first === null) {
    out(`Run ${id} does not exist.`);
    return 0;
  }
  if (!(o.isTTY ?? Boolean(process.stdout.isTTY))) {
    out(first);
    return 0;
  }
  const write = o.write ?? ((text: string) => process.stdout.write(text));
  const signal = o.signal ?? new AbortController().signal;
  for (;;) {
    const view = watchView(dir, id) ?? first;
    // Clear the screen and draw from the top, so the view stays in one place.
    write(`\u001b[2J\u001b[H${view}\n`);
    const run = readRun(dir, id);
    if (!run || run.status === "finished" || run.status === "cancelled" || signal.aborted) return 0;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
    if (signal.aborted) return 0;
  }
}
