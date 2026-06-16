import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../utils/shell.js";

/**
 * Values the harness emitter substitutes into templates/claude/ placeholders.
 * MVP heuristics — see templates/claude/_TOKENS.md for the token contract.
 */
export interface HarnessParams {
  packageManager: string; // pnpm | npm | yarn | bun
  forbiddenPms: string; // regex alternation of the others, e.g. "npm|yarn|bun"
  lockfile: string; // pnpm-lock.yaml | package-lock.json | yarn.lock | bun.lockb
  generatedGlobs: string; // case-glob for guard-file, e.g. "*/dist/*|dist/*|*.d.ts|*.map"
  docsDir: string; // "docs/"
  mainBranch: string; // main | master | ...
  forgeCli: string; // gh | glab
  commands: string[]; // e.g. ["pnpm typecheck", "pnpm test", "pnpm build"]
}

const PM_BY_LOCKFILE: Array<{ lock: string; pm: string }> = [
  { lock: "pnpm-lock.yaml", pm: "pnpm" },
  { lock: "yarn.lock", pm: "yarn" },
  { lock: "bun.lockb", pm: "bun" },
  { lock: "package-lock.json", pm: "npm" },
];

const ALL_PMS = ["npm", "yarn", "pnpm", "bun"];

export function detectPackageManager(dir: string): {
  packageManager: string;
  lockfile: string;
} {
  for (const { lock, pm } of PM_BY_LOCKFILE) {
    if (existsSync(join(dir, lock))) return { packageManager: pm, lockfile: lock };
  }
  return { packageManager: "npm", lockfile: "package-lock.json" };
}

export function forbiddenPmsFor(pm: string): string {
  return ALL_PMS.filter((p) => p !== pm).join("|");
}

export function forgeFromRemote(remoteUrl: string): string {
  return /gitlab/i.test(remoteUrl) ? "glab" : "gh";
}

function generatedGlobsFor(dir: string): string {
  // TS projects emit .d.ts / .map alongside dist; non-TS just build/dist dirs.
  return existsSync(join(dir, "tsconfig.json"))
    ? "*/dist/*|dist/*|*.d.ts|*.map"
    : "*/dist/*|dist/*|*/build/*";
}

async function detectGit(dir: string): Promise<{ mainBranch: string; forgeCli: string }> {
  let mainBranch = "main";
  let forgeCli = "gh";

  const head = await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: dir });
  const m = head.exitCode === 0 ? head.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/) : null;
  if (m) {
    mainBranch = m[1];
  } else {
    const cur = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
    const branch = cur.stdout.trim();
    if (cur.exitCode === 0 && branch && branch !== "HEAD") mainBranch = branch;
  }

  const remote = await run("git", ["remote", "get-url", "origin"], { cwd: dir });
  if (remote.exitCode === 0 && remote.stdout) forgeCli = forgeFromRemote(remote.stdout);

  return { mainBranch, forgeCli };
}

async function detectCommands(dir: string, pm: string): Promise<string[]> {
  const cmds: string[] = [];
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    const scripts: Record<string, string> = pkg.scripts ?? {};
    for (const name of ["typecheck", "test", "build"]) {
      if (scripts[name]) cmds.push(`${pm} ${name}`);
    }
  } catch {
    // no package.json / unparseable — no commands
  }
  return cmds;
}

export async function detectHarnessParams(dir: string): Promise<HarnessParams> {
  const { packageManager, lockfile } = detectPackageManager(dir);
  const { mainBranch, forgeCli } = await detectGit(dir);
  const commands = await detectCommands(dir, packageManager);

  return {
    packageManager,
    forbiddenPms: forbiddenPmsFor(packageManager),
    lockfile,
    generatedGlobs: generatedGlobsFor(dir),
    docsDir: "docs/",
    mainBranch,
    forgeCli,
    commands,
  };
}
