import { RunError } from "../../src/run/errors.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  baseRef,
  branchExists,
  checkout,
  commitPaths,
  createBranch,
  currentBranch,
  diffLines,
  diffStat,
  dirtyPaths,
  existsOnRef,
  git,
  headSha,
  isClean,
  normaliseHeader,
  restorePaths,
  slugify,
  softReset,
  taskDiffPaths,
} from "../../src/run/git.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let dir: string;

function sh(...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function put(path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-git-"));
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "t@example.com");
  sh("config", "user.name", "T");
  put("a.txt", "one\ntwo\n");
  sh("add", "-A");
  sh("commit", "-q", "-m", "chore: init");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("clean tree", () => {
  it("v04 AC-49: a fresh repo is clean and .claude/tmp/ changes are ignored", () => {
    expect(isClean(dir)).toBe(true);
    put(".claude/tmp/v04/notes.md", "x");
    expect(isClean(dir)).toBe(true);
    expect(dirtyPaths(dir)).toEqual([]);
  });

  it("v04 AC-49: untracked and modified files make the tree dirty and are listed", () => {
    put("new.txt", "n");
    put("a.txt", "changed\n");
    expect(isClean(dir)).toBe(false);
    expect(dirtyPaths(dir).sort()).toEqual(["a.txt", "new.txt"]);
  });
});

describe("branches and refs", () => {
  it("v04 AC-55: create, check out and detect branches; detached HEAD gives null", () => {
    expect(currentBranch(dir)).toBe("main");
    expect(branchExists(dir, "feat/x")).toBe(false);
    createBranch(dir, "feat/x", "main");
    expect(currentBranch(dir)).toBe("feat/x");
    expect(branchExists(dir, "feat/x")).toBe(true);
    checkout(dir, "main");
    expect(currentBranch(dir)).toBe("main");
    sh("checkout", "-q", "--detach");
    expect(currentBranch(dir)).toBeNull();
    expect(headSha(dir)).toBe(sh("rev-parse", "HEAD"));
  });

  it("v04 AC-20: baseRef prefers origin/<branch> and falls back to <branch>", () => {
    expect(baseRef(dir, "main")).toBe("main");
    sh("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(baseRef(dir, "main")).toBe("origin/main");
  });

  it("v04 AC-20: existsOnRef tells whether a path is on a ref", () => {
    expect(existsOnRef(dir, "HEAD", "a.txt")).toBe(true);
    expect(existsOnRef(dir, "HEAD", "nope.txt")).toBe(false);
  });

  it("git() returns exit code and output without throwing", () => {
    const r = git(dir, ["rev-parse", "--verify", "--quiet", "nope"]);
    expect(r.ok).toBe(false);
    expect(git(dir, ["rev-parse", "HEAD"]).stdout.trim()).toBe(headSha(dir));
  });
});

describe("task diff", () => {
  it("v04 AC-20: task diff paths cover tracked and untracked, never .claude/tmp/", () => {
    const base = headSha(dir);
    put("a.txt", "one\ntwo\nthree\n");
    put("src/new.ts", "a\nb\nc\n");
    put(".claude/tmp/v04/verify.log", "log\n");
    expect(taskDiffPaths(dir, base)).toEqual(["a.txt", "src/new.ts"]);
  });

  it("v04 AC-20: diff lines count added plus deleted, plus all lines of untracked files", () => {
    const base = headSha(dir);
    put("a.txt", "one\nTWO\nthree\n"); // +2 -1
    put("src/new.ts", "a\nb\nc\n"); // +3
    put(".claude/tmp/x.md", "1\n2\n3\n4\n5\n");
    expect(diffLines(dir, base)).toBe(6);
    expect(diffStat(dir, base)).toContain("a.txt");
    expect(diffStat(dir, base)).toContain("src/new.ts");
    expect(diffStat(dir, base)).not.toContain(".claude/tmp");
  });

  it("v04 AC-20: an empty task diff has no paths and zero lines", () => {
    const base = headSha(dir);
    put(".claude/tmp/only.md", "x");
    expect(taskDiffPaths(dir, base)).toEqual([]);
    expect(diffLines(dir, base)).toBe(0);
  });
});

describe("commitPaths", () => {
  it("v04 AC-20: stages exactly the given paths and returns the sha", () => {
    put("a.txt", "changed\n");
    put("b.txt", "b\n");
    put(".claude/tmp/n.md", "n");
    const r = commitPaths(dir, ["a.txt", ".claude/tmp/n.md"], "feat(a0): add the thing");
    expect(r.ok).toBe(true);
    expect(r.sha).toBe(headSha(dir));
    expect(sh("log", "-1", "--format=%s")).toBe("feat(a0): add the thing");
    expect(sh("show", "--name-only", "--format=", "HEAD")).toBe("a.txt");
    expect(dirtyPaths(dir)).toEqual(["b.txt"]);
  });

  it("v04 AC-20: commits a deletion and a new file together", () => {
    put("new.txt", "n\n");
    rmSync(join(dir, "a.txt"));
    const r = commitPaths(dir, ["a.txt", "new.txt"], "chore: swap files");
    expect(r.ok).toBe(true);
    expect(sh("show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual([
      "A\tnew.txt",
      "D\ta.txt",
    ]);
  });

  it("v04 AC-20: a hook that refuses gives ok:false with the hook output", () => {
    put("a.txt", "changed\n");
    const hook = join(dir, ".git", "hooks", "commit-msg");
    writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
    const before = headSha(dir);
    const r = commitPaths(dir, ["a.txt"], "feat: nope");
    expect(r.ok).toBe(false);
    expect(r.sha).toBeNull();
    expect(r.output).toContain("hook says no");
    expect(headSha(dir)).toBe(before);
  });

  it("v04 AC-55: softReset moves HEAD back and keeps the changes", () => {
    const base = headSha(dir);
    put("a.txt", "changed\n");
    commitPaths(dir, ["a.txt"], "feat: x");
    softReset(dir, base);
    expect(headSha(dir)).toBe(base);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("changed\n");
  });

  it("v04 AC-20: restorePaths restores tracked paths and removes ones new since base", () => {
    const base = headSha(dir);
    put("a.txt", "changed\n");
    put("new.txt", "n\n");
    sh("add", "new.txt");
    restorePaths(dir, base, ["a.txt", "new.txt"]);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(existsSync(join(dir, "new.txt"))).toBe(false);
    expect(isClean(dir)).toBe(true);
  });
});

describe("headers", () => {
  it("v04 AC-20: normaliseHeader lowercases the scope and subject start and drops the period", () => {
    expect(normaliseHeader("feat", "A0", "Add the thing.")).toBe("feat(a0): add the thing");
    expect(normaliseHeader("fix", null, "Repair it")).toBe("fix: repair it");
  });

  it("v04 AC-20: normaliseHeader cuts the header to 100 characters", () => {
    const h = normaliseHeader("feat", "a0", "x".repeat(200));
    expect(h.length).toBeLessThanOrEqual(100);
    expect(h.startsWith("feat(a0): xxx")).toBe(true);
  });

  it("v04 AC-20: commitlint accepts the normalised header of stage A0", () => {
    const headers = [
      normaliseHeader("feat", "A0", "Add the thing."),
      normaliseHeader("fix", null, "Quick Fix for the parser..."),
      normaliseHeader("docs", "A0", "y ".repeat(80)),
    ];
    for (const h of headers) {
      // execFileSync throws on a non-zero exit, so a rejected header fails the test.
      execFileSync("pnpm", ["exec", "commitlint"], { cwd: repoRoot, input: `${h}\n`, stdio: "pipe" });
    }
  }, 60_000);

  it("slugify keeps [a-z0-9-] and at most 40 characters", () => {
    expect(slugify("Add the Thing, now!")).toBe("add-the-thing-now");
    expect(slugify("  --A__B--  ")).toBe("a-b");
    const s = slugify("word ".repeat(30));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).toMatch(/^[a-z0-9-]+$/);
    expect(s.endsWith("-")).toBe(false);
  });

  it("v04 AC-20: slugify falls back to run for text without ASCII letters", () => {
    expect(slugify("Добавить поле")).toBe("run");
    expect(slugify("")).toBe("run");
    expect(slugify("---")).toBe("run");
  });

  it("v04 AC-20: normaliseHeader throws RunError(1) for an empty subject", () => {
    for (const subject of ["", "   \n\t"]) {
      let thrown: unknown = null;
      try {
        normaliseHeader("feat", "a0", subject);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RunError);
      expect(thrown instanceof RunError ? thrown.exitCode : null).toBe(1);
    }
  });
});

describe("literal pathspecs", () => {
  it("v04 AC-20: commitPaths treats src/[id].ts as a literal name, not a glob", () => {
    put("src/[id].ts", "x\n");
    put("src/i.ts", "y\n");
    const r = commitPaths(dir, ["src/[id].ts"], "feat: bracket");
    expect(r.ok).toBe(true);
    expect(sh("show", "--name-only", "--format=", "HEAD")).toBe("src/[id].ts");
    expect(dirtyPaths(dir)).toEqual(["src/i.ts"]);
  });

  it("v04 AC-20: restorePaths restores src/[id].ts without touching src/i.ts", () => {
    put("src/[id].ts", "x\n");
    put("src/i.ts", "y\n");
    commitPaths(dir, ["src/[id].ts", "src/i.ts"], "feat: both");
    const base = headSha(dir);
    put("src/[id].ts", "changed\n");
    put("src/i.ts", "changed\n");
    restorePaths(dir, base, ["src/[id].ts"]);
    expect(readFileSync(join(dir, "src/[id].ts"), "utf8")).toBe("x\n");
    expect(readFileSync(join(dir, "src/i.ts"), "utf8")).toBe("changed\n");
  });
});
