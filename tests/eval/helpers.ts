/** Shared setup for the eval tests: run scripts/eval.mjs with the fake claude, a temp out dir and a temp script copy. */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const EVAL_SCRIPT = join(REPO_ROOT, "scripts", "eval.mjs");
export const FAKE = join(REPO_ROOT, "tests", "run", "fake-claude.mjs");

export interface EvalResult {
  code: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
  scriptCopy: string | null;
}

export interface EvalOptions {
  /** Script to run; default the real scripts/eval.mjs. */
  script?: string;
  /** A fake script (JSON) to copy into a temp dir and point FAKE_CLAUDE_SCRIPT at. */
  fakeScript?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Answer given on stdin. */
  input?: string;
}

export function tempDir(prefix = "agent-stack-eval-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function runEval(args: string[], opts: EvalOptions = {}): EvalResult {
  const dir = tempDir();
  const outDir = join(dir, "out");
  mkdirSync(outDir, { recursive: true });
  let scriptCopy: string | null = null;
  const env: Record<string, string | undefined> = { ...process.env, AGENT_STACK_CLAUDE: FAKE, ...opts.env };
  if (opts.fakeScript) {
    scriptCopy = join(dir, "fake-script.json");
    copyFileSync(opts.fakeScript, scriptCopy);
    env.FAKE_CLAUDE_SCRIPT = scriptCopy;
  }
  const hasOut = args.includes("--out");
  const full = hasOut ? args : [...args, "--out", outDir];
  const r = spawnSync(process.execPath, [opts.script ?? EVAL_SCRIPT, ...full], {
    encoding: "utf8",
    env,
    input: opts.input ?? "",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, outDir, scriptCopy };
}
