/**
 * Seeing a run: one line per tool a role starts, `now.json` with the step in progress, and `progress.log`.
 * Spec: docs/specs/v04/SPEC.md, AC-78, AC-79.
 */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "../store.js";

/** The longest tool target shown, `…` included (AC-78). */
export const TARGET_MAX = 80;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `   · <tool> <target>`: the file path, the command or the pattern, on one line and cut to 80 (AC-78). */
export function toolLine(name: string, input: unknown): string {
  const i = isRecord(input) ? input : {};
  const raw = [i["file_path"], i["notebook_path"], i["command"], i["pattern"], i["path"]].find((v) => typeof v === "string");
  if (typeof raw !== "string" || raw.trim() === "") return `   · ${name}`;
  const one = raw.replace(/\s+/g, " ").trim();
  return `   · ${name} ${one.length <= TARGET_MAX ? one : `${one.slice(0, TARGET_MAX - 1)}…`}`;
}

/** The tool lines in one stream event of `claude -p --output-format stream-json` (AC-78); none for other events. */
export function toolLines(event: unknown): string[] {
  if (!isRecord(event) || event["type"] !== "assistant") return [];
  const msg = event["message"];
  const content = isRecord(msg) ? msg["content"] : undefined;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content) {
    if (isRecord(c) && c["type"] === "tool_use" && typeof c["name"] === "string") out.push(toolLine(c["name"], c["input"]));
  }
  return out;
}

/** Splits a growing stdout into whole lines; `push` returns the lines a chunk completed. */
export function lineSplitter(): { push: (chunk: string) => string[]; rest: () => string } {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      return parts;
    },
    rest: () => buf,
  };
}

export interface Now {
  step: string;
  since: string;
  last: string;
}

/**
 * What the run is doing (AC-79): `now.json` by temp file and rename, and one timed line in `progress.log`.
 * A failure to write is ignored: seeing the run must never stop it.
 */
export class Progress {
  private now: Now;
  constructor(
    private readonly projectDir: string,
    private readonly runId: string,
    step: string,
    private readonly clock: () => Date = () => new Date()
  ) {
    this.now = { step, since: clock().toISOString(), last: "" };
  }

  /** A new step starts: its time is the step's `since`. */
  step(step: string, line = `step ${step}`): void {
    this.now = { step, since: this.clock().toISOString(), last: line };
    this.write(line);
  }

  /** A line within the step (a call starts, a tool, a call ends). */
  line(line: string): void {
    this.now = { ...this.now, last: line.trim() };
    this.write(line.trim());
  }

  private write(line: string): void {
    try {
      const dir = runDir(this.projectDir, this.runId);
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `now.json.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(this.now) + "\n");
      renameSync(tmp, join(dir, "now.json"));
      appendFileSync(join(dir, "progress.log"), `${this.clock().toISOString()}\t${this.now.step}\t${line}\n`);
    } catch {
      // A full disk or a removed folder: the run goes on unseen.
    }
  }
}
