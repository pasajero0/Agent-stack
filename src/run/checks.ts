import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { RunError } from "./errors.js";
import type { CheckResult } from "./types.js";

const TAIL_LINES = 50;

/** A check result plus the last lines of its output. */
export interface CheckRun extends CheckResult {
  tail: string;
}

function lastLines(text: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.slice(-TAIL_LINES).join("\n");
}

/** Run `cmd` through `bash -c`; decide by exit code only. Empty command is skipped. A timeout kills the whole process group. */
export function runCheck(cmd: string, cwd: string, timeoutMs: number): Promise<CheckRun> {
  if (cmd.trim() === "") return Promise.resolve({ cmd, exit: 0, skipped: true, tail: "" });
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    const take = (chunk: Buffer): void => {
      out += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    const finish = (exit: number, extra: string): void => {
      clearTimeout(timer);
      const text = extra ? (out ? `${out}\n${extra}` : extra) : out;
      resolve({ cmd, exit, skipped: false, tail: lastLines(text) });
    };
    child.on("error", (e) => finish(1, e.message));
    child.on("close", (code) => {
      if (timedOut) finish(code !== null && code !== 0 ? code : 124, `timed out after ${timeoutMs} ms`);
      else finish(code ?? 1, "");
    });
  });
}

/** Last 50 lines of `.claude/tmp/<stage>/verify.log`; empty when there is no log. */
export function verifyTail(projectDir: string, stage: string): string {
  const log = join(projectDir, ".claude", "tmp", stage, "verify.log");
  if (!existsSync(log)) return "";
  return lastLines(readFileSync(log, "utf8"));
}

/** Bash `case` glob semantics: `*` matches `/` too. */
export function globMatch(pattern: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) {
        re += "\\[";
      } else {
        let body = pattern.slice(i + 1, end);
        let neg = false;
        if (body.startsWith("!") || body.startsWith("^")) {
          neg = true;
          body = body.slice(1);
        }
        re += `[${neg ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
        i = end;
      }
    } else if (c === "\\" && i + 1 < pattern.length) {
      i++;
      re += pattern.charAt(i).replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    } else re += c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`, "s").test(path);
  } catch {
    return false;
  }
}

/** `./name` for a relative path, so a name such as `--fix.ts` is not read as an option. */
function dashSafe(f: string): string {
  return isAbsolute(f) ? f : `./${f}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Commands to run for lint: per existing matching file with `{file}`, else once. */
export function lintRuns(
  lintCmd: string,
  files: string[],
  lintMatch: string[],
  projectDir: string,
): string[] {
  if (lintCmd.trim() === "") return [];
  if (lintCmd.includes("'{file}'") || lintCmd.includes('"{file}"'))
    throw new RunError("lint command: write {file} without quotes, the driver quotes it", 1);
  if (!lintCmd.includes("{file}")) return [lintCmd];
  return files
    .filter((f) => existsSync(join(projectDir, f)) && lintMatch.some((g) => globMatch(g, f)))
    .map((f) => lintCmd.split("{file}").join(shellQuote(dashSafe(f))));
}
