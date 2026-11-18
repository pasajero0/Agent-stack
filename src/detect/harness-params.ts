import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../utils/shell.js";

export type Stack = "node" | "python" | "go" | "rust" | "unknown";

/**
 * Values the harness emitter needs about the target project. Stack-specific facts live here and in
 * `.claude/gates.json` — the hooks themselves stay stack-agnostic. Empty string = not applicable.
 * See templates/claude/_TOKENS.md for the token contract.
 */
export interface HarnessParams {
  stack: Stack;
  packageManager: string; // pnpm | npm | yarn | bun | uv | poetry | pipenv | pip | go | cargo | ""
  forbiddenPms: string; // regex alternation of the other JS package managers, e.g. "npm|yarn|bun"
  lockfile: string; // pnpm-lock.yaml | uv.lock | go.sum | Cargo.lock | ...
  generatedGlobs: string; // case-glob of build output, e.g. "*/dist/*|dist/*|*.d.ts|*.map"
  docsDir: string; // "docs/"
  monorepo: boolean; // workspaces or apps/ / packages/ — gets the default docs layout
  mainBranch: string; // main | master | ...
  forgeCli: string; // gh | glab
  commands: string[]; // verification commands to allow-list, e.g. ["pnpm typecheck", "pnpm test"]
  testCommand: string; // the project's test command
  lintCommand: string; // per-file lint command with a {file} placeholder
  lintMatch: string; // case-glob of files the lint hook checks
  testGlobs: string; // case-glob of test files (trace looks for criterion ids there)
  complexityCommand: string; // prints how many changed functions exceed complexity 10; {files} placeholder
}

const PM_BY_LOCKFILE: Array<{ lock: string; pm: string }> = [
  { lock: "pnpm-lock.yaml", pm: "pnpm" },
  { lock: "yarn.lock", pm: "yarn" },
  { lock: "bun.lockb", pm: "bun" },
  { lock: "package-lock.json", pm: "npm" },
];

const PY_PM_BY_LOCKFILE: Array<{ lock: string; pm: string }> = [
  { lock: "uv.lock", pm: "uv" },
  { lock: "poetry.lock", pm: "poetry" },
  { lock: "Pipfile.lock", pm: "pipenv" },
];

const ALL_PMS = ["npm", "yarn", "pnpm", "bun"];

const JS_LINT_MATCH = "*.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts";

export function detectStack(dir: string): Stack {
  const has = (f: string) => existsSync(join(dir, f));
  if (has("package.json")) return "node";
  if (["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"].some(has)) return "python";
  if (has("go.mod")) return "go";
  if (has("Cargo.toml")) return "rust";
  return "unknown";
}

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

/** How a JS package manager runs a locally installed binary. */
export function execPrefixFor(pm: string): string {
  return { pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" }[pm] ?? "npx";
}

/** How a Python package manager runs a tool inside the project environment. */
function pyRunPrefixFor(pm: string): string {
  return { uv: "uv run ", poetry: "poetry run ", pipenv: "pipenv run " }[pm] ?? "";
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

function readText(dir: string, file: string): string {
  try {
    return readFileSync(join(dir, file), "utf-8");
  } catch {
    return "";
  }
}

function makeTarget(dir: string, target: string): boolean {
  return new RegExp(`^${target}:`, "m").test(readText(dir, "Makefile"));
}

type StackFacts = Omit<HarnessParams, "stack" | "docsDir" | "monorepo" | "mainBranch" | "forgeCli">;

/** Several apps or packages in one repo: a workspace file, or an `apps/` / `packages/` folder. */
export function detectMonorepo(dir: string): boolean {
  const has = (f: string) => existsSync(join(dir, f));
  if (["pnpm-workspace.yaml", "go.work", "apps", "packages"].some(has)) return true;
  if (/^\[workspace\]/m.test(readText(dir, "Cargo.toml"))) return true;
  try {
    const pkg: unknown = JSON.parse(readText(dir, "package.json"));
    if (typeof pkg !== "object" || pkg === null || !("workspaces" in pkg)) return false;
    const ws = pkg.workspaces;
    return Array.isArray(ws) ? ws.length > 0 : typeof ws === "object" && ws !== null;
  } catch {
    return false;
  }
}

function nodeFacts(dir: string): StackFacts {
  const { packageManager: pm, lockfile } = detectPackageManager(dir);
  let pkg: { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object } = {};
  try {
    pkg = JSON.parse(readText(dir, "package.json"));
  } catch {
    // unparseable package.json — no scripts, no linter
  }
  const scripts = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const exec = execPrefixFor(pm);

  let lintCommand = "";
  let complexityCommand = "";
  if ("eslint" in deps) {
    lintCommand = `${exec} eslint --no-warn-ignored {file}`;
    complexityCommand =
      `${exec} eslint --no-warn-ignored --rule '{"complexity": ["error", 10]}' --format json {files}` +
      ` | jq '[.[].messages[] | select(.ruleId == "complexity")] | length'`;
  } else if ("@biomejs/biome" in deps) {
    lintCommand = `${exec} biome lint {file}`;
  }

  return {
    packageManager: pm,
    forbiddenPms: forbiddenPmsFor(pm),
    lockfile,
    // Build output dirs at any depth, plus source maps. Not *.d.ts: hand-written declaration files exist.
    generatedGlobs: "dist/*|*/dist/*|build/*|*/build/*|*.map",
    commands: ["typecheck", "test", "build"].filter((s) => scripts[s]).map((s) => `${pm} ${s}`),
    testCommand: scripts.test ? `${pm} test` : "",
    lintCommand,
    lintMatch: lintCommand ? JS_LINT_MATCH : "",
    testGlobs: "*.test.*|*.spec.*|*/__tests__/*|tests/*|*/tests/*|test/*|*/test/*|e2e/*",
    complexityCommand,
  };
}

function pythonFacts(dir: string): StackFacts {
  const found = PY_PM_BY_LOCKFILE.find(({ lock }) => existsSync(join(dir, lock)));
  const pm = found?.pm ?? "pip";
  const prefix = pyRunPrefixFor(pm);
  const pyproject = readText(dir, "pyproject.toml");
  const usesPytest =
    /pytest/.test(pyproject + readText(dir, "requirements.txt")) || existsSync(join(dir, "tests"));
  const testCommand = usesPytest ? `${prefix}pytest` : makeTarget(dir, "test") ? "make test" : "";
  const usesRuff = /ruff/.test(pyproject);
  const lintCommand = usesRuff ? `${prefix}ruff check {file}` : "";
  return {
    packageManager: pm,
    forbiddenPms: "",
    lockfile: found?.lock ?? "",
    generatedGlobs: "*/__pycache__/*|*.pyc|*.egg-info/*|dist/*|build/*",
    commands: testCommand ? [testCommand] : [],
    testCommand,
    lintCommand,
    lintMatch: lintCommand ? "*.py" : "",
    testGlobs: "test_*.py|*/test_*.py|*_test.py|tests/*|*/tests/*",
    complexityCommand: usesRuff
      ? `${prefix}ruff check --select C901 --output-format json {files} | jq length`
      : "",
  };
}

function goFacts(): StackFacts {
  return {
    packageManager: "go",
    forbiddenPms: "",
    lockfile: "go.sum",
    generatedGlobs: "",
    commands: ["go vet ./...", "go test ./..."],
    testCommand: "go test ./...",
    lintCommand: "",
    lintMatch: "",
    testGlobs: "*_test.go",
    complexityCommand: "",
  };
}

function rustFacts(): StackFacts {
  return {
    packageManager: "cargo",
    forbiddenPms: "",
    lockfile: "Cargo.lock",
    generatedGlobs: "target/*",
    commands: ["cargo check", "cargo test"],
    testCommand: "cargo test",
    lintCommand: "",
    lintMatch: "",
    testGlobs: "tests/*|*.rs", // unit tests live inside src/*.rs
    complexityCommand: "",
  };
}

function unknownFacts(dir: string): StackFacts {
  const testCommand = makeTarget(dir, "test") ? "make test" : "";
  return {
    packageManager: "",
    forbiddenPms: "",
    lockfile: "",
    generatedGlobs: "",
    commands: testCommand ? [testCommand] : [],
    testCommand,
    lintCommand: "",
    lintMatch: "",
    testGlobs: "tests/*|*/tests/*|test/*|*/test/*|*test*",
    complexityCommand: "",
  };
}

export function detectStackFacts(dir: string, stack: Stack): StackFacts {
  switch (stack) {
    case "node":
      return nodeFacts(dir);
    case "python":
      return pythonFacts(dir);
    case "go":
      return goFacts();
    case "rust":
      return rustFacts();
    default:
      return unknownFacts(dir);
  }
}

export async function detectHarnessParams(dir: string): Promise<HarnessParams> {
  const stack = detectStack(dir);
  const { mainBranch, forgeCli } = await detectGit(dir);
  return {
    stack,
    ...detectStackFacts(dir, stack),
    docsDir: "docs/",
    monorepo: detectMonorepo(dir),
    mainBranch,
    forgeCli,
  };
}
