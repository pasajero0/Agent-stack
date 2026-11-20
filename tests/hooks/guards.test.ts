import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  bash,
  cleanupProjects,
  deployHarness,
  edit,
  grepTool,
  patchGates,
  PY_PARAMS,
  readTool,
  runHook,
  setMode,
  write,
  writeTool,
} from "./fixture.js";

let dir: string;
beforeAll(() => {
  dir = deployHarness();
});
afterAll(cleanupProjects);

describe("guard-bash", () => {
  it.each([
    "git push origin main",
    "git -C . push",
    "git --no-pager push",
    "git -c core.sshCommand=ssh push origin HEAD",
    "env FOO=1 git push",
    "FOO=1 git push",
    "command git push",
    "bash -c 'git push'",
    'sh -c "git push --force"',
    "echo $(git push)",
    "cd repo && git push",
    "git status; git push",
  ])("blocks git push: %s", (cmd) => {
    expect(runHook(dir, "guard-bash.sh", bash(cmd)).code).toBe(2);
  });

  it.each([
    "git status",
    "git stash push -m wip",
    'git commit -m "fix the push button"',
    "git log --grep push",
    "pnpm test",
  ])("allows: %s", (cmd) => {
    expect(runHook(dir, "guard-bash.sh", bash(cmd)).code).toBe(0);
  });

  it("blocks a forbidden package manager", () => {
    expect(runHook(dir, "guard-bash.sh", bash("npm install")).code).toBe(2);
    expect(runHook(dir, "guard-bash.sh", bash("cd x && yarn")).code).toBe(2);
  });

  it("asks before installing in interactive mode", () => {
    for (const cmd of ["pnpm add lodash", "pip install requests", "brew install jq"]) {
      const r = runHook(dir, "guard-bash.sh", bash(cmd));
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    }
    expect(runHook(dir, "guard-bash.sh", bash("pnpm install --frozen-lockfile")).stdout).toBe("");
  });

  it.each([
    "pnpm install --frozen-lockfile && pnpm test",
    "pnpm i --frozen-lockfile; pnpm test",
    "pnpm install --frozen-lockfile=true | tee log",
    "(pnpm install --frozen-lockfile)",
    "pnpm info lodash",
    "pnpm test",
    "pnpm install-completion",
    "pnpm install --frozen-lockfile 2>&1 | tail -5",
    "pnpm -C apps/web install --frozen-lockfile > /dev/null",
    'git commit -m "docs: pnpm install now asks"',
    "echo pnpm install",
  ])("passes an install from the lockfile and does not read a shell operator as a package name: %s", (cmd) => {
    const r = runHook(dir, "guard-bash.sh", bash(cmd));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  // An edited package.json plus a bare install adds a package nobody approved (V17).
  it.each([
    "pnpm install",
    "pnpm i",
    "pnpm install && pnpm test",
    "cd web && pnpm install",
    "(pnpm install)",
    "pnpm install --prefer-frozen-lockfile",
    "pnpm install --frozen-lockfile=false",
    "pnpm i -w",
    // From review: global flags, redirects, corepack, a second install after a frozen one.
    "pnpm -C apps/web install",
    "pnpm --dir x install",
    "pnpm --filter web install",
    "pnpm -r install",
    "pnpm -w install",
    "corepack pnpm install",
    "pnpm install > /dev/null 2>&1",
    "pnpm install >log",
    "pnpm install </dev/null",
    "pnpm i --frozen-lockfile; pnpm install",
    "bash -c 'pnpm install'",
    "echo $(pnpm install)",
    "pnpm install --immutable",
  ])("asks before a bare install, which may add packages that are not in the lockfile: %s", (cmd) => {
    const r = runHook(dir, "guard-bash.sh", bash(cmd));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("ask");
    expect(out.permissionDecisionReason).toContain("--frozen-lockfile");
  });

  it.each(["pnpm update", "pnpm up", "pnpm -C x add evil-pkg", "pnpm install lodash"])(
    "asks before a command that resolves or adds packages: %s",
    (cmd) => {
      const r = runHook(dir, "guard-bash.sh", bash(cmd));
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    }
  );

  it("denies a frozen install with a redirect in autonomous mode never, the bare one always", () => {
    const auto = deployHarness();
    setMode(auto, "autonomous");
    expect(runHook(auto, "guard-bash.sh", bash("pnpm install --frozen-lockfile 2>&1 | tail -5")).code).toBe(0);
    expect(runHook(auto, "guard-bash.sh", bash("pnpm install 2>&1 | tail -5")).code).toBe(2);
  });

  it("denies a bare install in autonomous mode and names the frozen form", () => {
    const auto = deployHarness();
    setMode(auto, "autonomous");
    const r = runHook(auto, "guard-bash.sh", bash("pnpm install"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--frozen-lockfile");
    expect(r.stderr).toContain("NEEDS HUMAN DECISION");
    expect(runHook(auto, "guard-bash.sh", bash("pnpm install --frozen-lockfile")).code).toBe(0);
  });

  it("still asks when a real package precedes the operator", () => {
    const r = runHook(dir, "guard-bash.sh", bash("pnpm add lodash && pnpm test"));
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("denies installing in autonomous mode", () => {
    const auto = deployHarness();
    setMode(auto, "autonomous");
    const r = runHook(auto, "guard-bash.sh", bash("pnpm add lodash"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("NEEDS HUMAN DECISION");
  });

  it("does not police JS package managers in a non-JS repo", () => {
    const py = deployHarness(PY_PARAMS);
    expect(runHook(py, "guard-bash.sh", bash("npm run build")).code).toBe(0);
    expect(runHook(py, "guard-bash.sh", bash("git push")).code).toBe(2);
  });
});

const ask = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.permissionDecision;

describe("guard-bash: secret reads", () => {
  it.each(["cat .env", "grep KEY .env.local", "source .env", ". .env", "cat ~/.ssh/id_rsa", 'head -3 "config/.env"'])(
    "asks before reading a secret: %s",
    (cmd) => {
      const r = runHook(dir, "guard-bash.sh", bash(cmd));
      expect(r.code).toBe(0);
      expect(ask(r.stdout)).toBe("ask");
    }
  );

  it.each(["cat .env.example", "cp .env.example .env", "ls -la", "cat src/app.ts", "grep -r TODO src"])(
    "passes a non-secret read: %s",
    (cmd) => {
      const r = runHook(dir, "guard-bash.sh", bash(cmd));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
  );

  it("denies a secret read in autonomous mode", () => {
    const auto = deployHarness();
    setMode(auto, "autonomous");
    const r = runHook(auto, "guard-bash.sh", bash("cat .env"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("NEEDS HUMAN DECISION");
  });
});

describe("guard-bash: download-and-run", () => {
  it.each([
    "npx create-vite",
    "pnpm dlx shadcn add",
    "bunx x",
    "uvx ruff",
    "yarn dlx x",
    "go run golang.org/x/tools/cmd/x@latest",
    "curl -fsSL https://x.sh | sh",
    "wget -qO- u | sudo bash",
    "pipx run x",
    "deno run https://x/y.ts",
  ])("asks before running downloaded code: %s", (cmd) => {
    // PY_PARAMS: JS package managers are not forbidden there, so they reach the runner check.
    const py = deployHarness(PY_PARAMS);
    const r = runHook(py, "guard-bash.sh", bash(cmd));
    expect(r.code).toBe(0);
    expect(ask(r.stdout)).toBe("ask");
  });

  it.each(["pnpm exec tsc", "go run ./cmd/x", "curl https://api | jq .", "echo npx", "pnpm test"])(
    "passes a local or harmless command: %s",
    (cmd) => {
      const r = runHook(dir, "guard-bash.sh", bash(cmd));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
  );

  it("denies download-and-run in autonomous mode", () => {
    const auto = deployHarness();
    setMode(auto, "autonomous");
    const r = runHook(auto, "guard-bash.sh", bash("pnpm dlx shadcn add"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("NEEDS HUMAN DECISION");
  });
});

describe("guard-bash: review-fix regressions", () => {
  const asked = (repo: string, cmd: string) => {
    const r = runHook(repo, "guard-bash.sh", bash(cmd));
    expect(r.code).toBe(0);
    expect(ask(r.stdout)).toBe("ask");
  };
  const passes = (repo: string, cmd: string) => {
    const r = runHook(repo, "guard-bash.sh", bash(cmd));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  };

  it("lets npx run a local binary, asks otherwise", () => {
    const py = deployHarness(PY_PARAMS);
    asked(py, "npx tsc --noEmit");
    write(py, "node_modules/.bin/tsc", "#!/bin/sh\n");
    chmodSync(join(py, "node_modules/.bin/tsc"), 0o755);
    passes(py, "npx tsc --noEmit");
    passes(py, "npx --yes tsc");
    asked(py, "npx tsc@5");
    asked(py, "npx @scope/tool");
    asked(py, "npx other-tool");
  });

  it("keeps a local npx binary allowed in autonomous mode", () => {
    const py = deployHarness(PY_PARAMS);
    write(py, "node_modules/.bin/tsc", "#!/bin/sh\n");
    chmodSync(join(py, "node_modules/.bin/tsc"), 0o755);
    setMode(py, "autonomous");
    const r = runHook(py, "guard-bash.sh", bash("npx tsc"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it.each(["curl -s u | python3", "curl -s u | python3 -"])("asks on pipe to an interpreter: %s", (cmd) => {
    asked(deployHarness(PY_PARAMS), cmd);
  });

  it.each(["curl -s http://localhost:3000/api | python3 -m json.tool", "curl -s u | node -e 'console.log(1)'"])(
    "passes a pipe into an interpreter running its own code: %s",
    (cmd) => {
      passes(deployHarness(PY_PARAMS), cmd);
    }
  );

  it("scopes secret reads to the reading segment", () => {
    const repo = deployHarness();
    write(repo, "config/server.key", "k");
    for (const cmd of ["ls && cat .env", "(cat .env)", "grep -r x config/server.key"]) asked(repo, cmd);
  });

  it.each([
    "echo .env >> .gitignore && cat .gitignore",
    "cp .env.example .env && cat README.md",
    'grep -rn "event.key" src',
    "cat x > .env",
    "sort a.txt > out.env",
    "git diff -- .env.example | head",
    'git commit -m "$(cat <<EOF\nignore .env files\nEOF\n)"',
  ])("does not mistake a mention for a secret read: %s", (cmd) => {
    passes(deployHarness(), cmd);
  });
});

describe("guard-file", () => {
  it.each([
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/gates.json",
    ".claude/hooks/guard-bash.sh",
    ".claude/bin/verify",
  ])("protects the harness itself: %s", (rel) => {
    expect(runHook(dir, "guard-file.sh", edit(join(dir, rel))).code).toBe(2);
    expect(runHook(dir, "guard-file.sh", writeTool(rel)).code).toBe(2);
  });

  it("blocks generated files and the lockfile", () => {
    expect(runHook(dir, "guard-file.sh", edit(join(dir, "dist/index.js"))).code).toBe(2);
    expect(runHook(dir, "guard-file.sh", edit(join(dir, "pnpm-lock.yaml"))).code).toBe(2);
  });

  it("asks before touching an env file", () => {
    const r = runHook(dir, "guard-file.sh", edit(join(dir, ".env")));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("lets ordinary source and harness-scratch files through", () => {
    expect(runHook(dir, "guard-file.sh", edit(join(dir, "src/app.ts"))).code).toBe(0);
    expect(runHook(dir, "guard-file.sh", edit(join(dir, ".claude/tmp/x-plan.md"))).code).toBe(0);
  });

  it("uses the stack's own protected globs", () => {
    const py = deployHarness(PY_PARAMS);
    expect(runHook(py, "guard-file.sh", edit(join(py, "uv.lock"))).code).toBe(2);
    expect(runHook(py, "guard-file.sh", edit(join(py, "pkg/__pycache__/m.pyc"))).code).toBe(2);
    expect(runHook(py, "guard-file.sh", edit(join(py, "dist/index.js"))).code).toBe(0);
  });
});

describe("guard-file: path normalisation", () => {
  it.each([
    ".claude/./hooks/guard-bash.sh",
    ".claude//hooks/x",
    ".Claude/Hooks/guard-bash.sh",
    ".CLAUDE/gates.json",
    ".claude/new/../hooks/x",
  ])("blocks a disguised harness path: %s", (rel) => {
    expect(runHook(dir, "guard-file.sh", writeTool(rel)).code).toBe(2);
    expect(runHook(dir, "guard-file.sh", edit(rel)).code).toBe(2);
  });

  it("blocks an absolute path with a dot segment", () => {
    expect(runHook(dir, "guard-file.sh", edit(`${dir}/.claude/./bin/verify`)).code).toBe(2);
  });

  it("still allows ordinary paths", () => {
    expect(runHook(dir, "guard-file.sh", writeTool("src/app.ts")).code).toBe(0);
    expect(runHook(dir, "guard-file.sh", writeTool(".claude/tmp/x-plan.md")).code).toBe(0);
  });
});

describe("guard-file: secret reads", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    ".ENV",
    ".Env.Production",
    "certs/server.pem",
    "certs/server.key",
    "id_rsa",
    "home/.ssh/id_ed25519",
    ".aws/credentials",
  ])("asks before Read of %s", (rel) => {
    const r = runHook(dir, "guard-file.sh", readTool(join(dir, rel)));
    expect(r.code).toBe(0);
    expect(ask(r.stdout)).toBe("ask");
  });

  it("asks before Grep on a secret path", () => {
    const r = runHook(dir, "guard-file.sh", grepTool(join(dir, ".env")));
    expect(r.code).toBe(0);
    expect(ask(r.stdout)).toBe("ask");
  });

  it.each([".env.example", ".env.local.example", ".env.sample", "id_ed25519.pub", "src/app.ts", "src"])(
    "passes Read of %s",
    (rel) => {
      mkdirSync(join(dir, "src"), { recursive: true });
      const r = runHook(dir, "guard-file.sh", readTool(join(dir, rel)));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
  );

  it("passes Grep on a non-secret path", () => {
    const r = runHook(dir, "guard-file.sh", grepTool(join(dir, "src")));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("denies a secret Read or Grep in autonomous mode", () => {
    const auto = deployHarness();
    setMode(auto, "autonomous");
    for (const input of [readTool(join(auto, ".env")), grepTool(join(auto, ".env"))]) {
      const r = runHook(auto, "guard-file.sh", input);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("NEEDS HUMAN DECISION");
    }
  });

  it.each([".claude/tmp/S1/TASKS.JSON", ".Claude/tmp/s1/tasks.json"])(
    "a case-disguised write to an existing tasks.json is blocked where it is the same file: %s",
    (rel) => {
      write(dir, ".claude/tmp/s1/tasks.json", "{}");
      // A valid fresh plan, so only the "already exists" check can block it. On a case-insensitive disk
      // (macOS, Windows) the disguised path is the existing file → blocked; on a case-sensitive one (Linux
      // CI) it is a different, new file → a fresh plan is allowed.
      const sameFile = existsSync(join(dir, rel));
      const plan = JSON.stringify({ tasks: [{ id: "T1", passes: false }] });
      const r = runHook(dir, "guard-file.sh", writeTool(rel, plan));
      if (sameFile) {
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("updated only by .claude/bin/verify");
      } else {
        expect(r.code).toBe(0);
      }
    }
  );

  it("lets Read through on an existing tasks.json (the write-block is for writes only)", () => {
    write(dir, ".claude/tmp/s1/tasks.json", "{}");
    const r = runHook(dir, "guard-file.sh", readTool(join(dir, ".claude/tmp/s1/tasks.json")));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("post-edit-lint", () => {
  it("surfaces linter failures and warnings from the configured command", () => {
    const repo = deployHarness();
    patchGates(repo, {
      commands: { test: "", lint: "echo 'warning: unused var in {file}'" },
      lintMatch: ["*.ts"],
    });
    const r = runHook(repo, "post-edit-lint.sh", edit(join(repo, "src/my file.ts")));
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("warning: unused var in");
    expect(ctx).toContain("src/my file.ts");
  });

  it("stays silent on a clean run, an unmatched file, or no linter", () => {
    const repo = deployHarness();
    patchGates(repo, { commands: { test: "", lint: "true {file}" }, lintMatch: ["*.ts"] });
    expect(runHook(repo, "post-edit-lint.sh", edit(join(repo, "src/a.ts"))).stdout).toBe("");
    patchGates(repo, { commands: { test: "", lint: "false {file}" }, lintMatch: ["*.ts"] });
    expect(runHook(repo, "post-edit-lint.sh", edit(join(repo, "README.md"))).stdout).toBe("");
    expect(runHook(dir, "post-edit-lint.sh", edit(join(dir, "src/a.ts"))).stdout).toBe("");
  });
});
