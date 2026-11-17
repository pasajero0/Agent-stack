import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildHarnessFiles } from "../../src/claude/harness.js";
import type { HarnessParams } from "../../src/detect/harness-params.js";

export const TS_PARAMS: HarnessParams = {
  stack: "node",
  packageManager: "pnpm",
  forbiddenPms: "npm|yarn|bun",
  lockfile: "pnpm-lock.yaml",
  generatedGlobs: "*/dist/*|dist/*|*.d.ts|*.map",
  docsDir: "docs/",
  monorepo: false,
  mainBranch: "main",
  forgeCli: "gh",
  commands: ["pnpm typecheck", "pnpm test"],
  testCommand: "pnpm test",
  lintCommand: "",
  lintMatch: "",
  testGlobs: "*.test.*|tests/*",
  complexityCommand: "",
};

/** A non-JS project: nothing JS-specific may leak into the gates. */
export const PY_PARAMS: HarnessParams = {
  stack: "python",
  packageManager: "uv",
  forbiddenPms: "",
  lockfile: "uv.lock",
  generatedGlobs: "*/__pycache__/*|*.pyc",
  docsDir: "docs/",
  monorepo: false,
  mainBranch: "main",
  forgeCli: "gh",
  commands: ["uv run pytest"],
  testCommand: "uv run pytest",
  lintCommand: "",
  lintMatch: "",
  testGlobs: "test_*.py|tests/*",
  complexityCommand: "",
};

export interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

const created: string[] = [];

/** Deploy the real emitted harness into a fresh temp dir — tests exercise what users get. */
export function deployHarness(params: HarnessParams = TS_PARAMS): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-stack-hooks-"));
  created.push(dir);
  for (const f of buildHarnessFiles(params)) {
    const full = join(dir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
    if (f.path.startsWith(".claude/hooks/") || f.path.startsWith(".claude/bin/")) chmodSync(full, 0o755);
  }
  return dir;
}

export function cleanupProjects(): void {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function runHook(
  dir: string,
  hook: string,
  input: unknown,
  env: Record<string, string> = {}
): HookResult {
  const r = spawnSync("bash", [join(dir, ".claude/hooks", hook)], {
    input: JSON.stringify(input),
    cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** git with a throwaway identity and no signing, so tests never touch the user's git config. */
export function git(dir: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf-8" }
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Merge fields into the deployed .claude/gates.json (the human's knob, not the agent's). */
export function patchGates(dir: string, patch: Record<string, unknown>): void {
  const file = join(dir, ".claude/gates.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), ...patch }, null, 2));
}

export function setMode(dir: string, mode: "interactive" | "autonomous"): void {
  patchGates(dir, { mode });
}

export function write(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
export const edit = (file_path: string, new_string = "x", old_string = "y") => ({
  tool_name: "Edit",
  tool_input: { file_path, old_string, new_string },
});
export const writeTool = (file_path: string, content = "x") => ({
  tool_name: "Write",
  tool_input: { file_path, content },
});
export const readTool = (file_path: string) => ({ tool_name: "Read", tool_input: { file_path } });
export const grepTool = (path: string, pattern = "x") => ({ tool_name: "Grep", tool_input: { pattern, path } });
