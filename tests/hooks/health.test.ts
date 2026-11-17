import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanupProjects, deployHarness, git, patchGates, runHook, write } from "./fixture.js";

afterAll(cleanupProjects);

const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";

/** main has a legacy 900-line file and one dependency; work happens on an A0 branch. */
function repo(): string {
  const dir = deployHarness();
  git(dir, "init", "-q", "-b", "main");
  write(dir, "src/legacy.ts", lines(900));
  write(dir, "package.json", JSON.stringify({ dependencies: { zod: "3" } }));
  write(dir, "docs/specs/A0/SPEC.md", "- **AC-1:** THE SYSTEM SHALL exist.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "A0-work");
  return dir;
}

const health = (dir: string, ...args: string[]) => {
  const r = spawnSync(join(dir, ".claude/bin/health"), args, { cwd: dir, encoding: "utf-8" });
  return { code: r.status, out: r.stdout + r.stderr };
};

describe("health", () => {
  it("measures only what the branch changed — old debt does not block new work", () => {
    const dir = repo();
    write(dir, "src/new.ts", lines(40));
    const r = health(dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/maxFileLines\s+40\s+limit 400\s+ok\s+src\/new\.ts/);
  });

  it("breaks the file-size SLO when a changed file grows past the limit", () => {
    const dir = repo();
    write(dir, "src/big.ts", lines(450));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "big");
    const r = health(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/maxFileLines\s+450\s+limit 400\s+BROKEN/);
    expect(r.out).toContain("ADR");
  });

  it("reports new dependencies, and blocks them once the human sets a limit", () => {
    const dir = repo();
    write(dir, "package.json", JSON.stringify({ dependencies: { zod: "3", lodash: "4" }, devDependencies: { vitest: "3" } }));
    let r = health(dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/newDependencies\s+2\s+limit —\s+report\s+lodash vitest/);
    patchGates(dir, { slo: { maxFileLines: 400, newDependencies: 0 } });
    r = health(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("SLO broken: newDependencies");
  });

  it("runs project metric commands on the changed files; --quick skips them", () => {
    const dir = repo();
    patchGates(dir, {
      health: [{ name: "todos", command: "cat {files} | grep -c TODO || true", max: 0 }],
    });
    write(dir, "src/a.ts", "// TODO one\n// TODO two\n");
    write(dir, "src/a.test.ts", "// TODO in a test file is not measured\n");
    let r = health(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/todos\s+2\s+limit 0\s+BROKEN/);
    r = health(dir, "--quick");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("todos");
  });

  it("says n/a instead of failing when a metric command breaks", () => {
    const dir = repo();
    patchGates(dir, { health: [{ name: "complexity", command: "no-such-tool {files}", max: 0 }] });
    write(dir, "src/a.ts", "x\n");
    const r = health(dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/complexity\s+n\/a/);
  });

  it("appends every run to the health time series", () => {
    const dir = repo();
    write(dir, "src/a.ts", lines(10));
    health(dir);
    health(dir);
    const series = readFileSync(join(dir, ".claude/tmp/health.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ branch: "A0-work", stage: "A0", metrics: { maxFileLines: 10 }, broken: [] });
  });

  it("evidence-gate refuses DONE while a health SLO is broken", () => {
    const dir = repo();
    write(dir, ".claude/tmp/A0/tasks.json", JSON.stringify({ tasks: [{ id: "T1", verify: "true", passes: true }] }));
    write(dir, "src/a.test.ts", 'it("A0 AC-1", f);\n');
    write(dir, "src/big.ts", lines(450));
    const done = { stop_hook_active: false, last_assistant_message: "STATUS: DONE\nEVIDENCE: verify 1/1" };
    const r = runHook(dir, "evidence-gate.sh", done);
    expect(JSON.parse(r.stdout).reason).toContain("code-health SLO is broken");
    write(dir, "src/big.ts", lines(50));
    expect(runHook(dir, "evidence-gate.sh", done).stdout).toBe("");
  });

  it("has no misplacedDocs row with the default gates", () => {
    const dir = repo();
    write(dir, "apps/web/notes.md", "# notes\n");
    const r = health(dir);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("misplacedDocs");
  });

  it("reports changed Markdown outside docsLayout, never breaks", () => {
    const dir = repo();
    patchGates(dir, { docsLayout: ["docs/*", "apps/*/README.md"] });
    write(dir, "apps/web/notes.md", "# notes\n");
    write(dir, "apps/web/README.md", "# web\n");
    write(dir, "docs/x.md", "# x\n");
    write(dir, "NOTES.md", "# root\n");
    const r = health(dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/misplacedDocs\s+1\s+limit —\s+report\s+"apps\/web\/notes\.md"/);
    expect(r.out).toContain("docsLayout");
    expect(r.out).not.toContain("apps/web/README.md");
    expect(r.out).not.toContain("docs/x.md");
    expect(r.out).not.toContain("NOTES.md");
  });

  it("counts a misplaced file with spaces or Cyrillic in its name once", () => {
    const dir = repo();
    patchGates(dir, { docsLayout: ["docs/*"] });
    write(dir, "notes dir/a b.md", "# a\n");
    write(dir, "заметки/план.md", "# план\n");
    const r = health(dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/misplacedDocs\s+2\s/);
    expect(r.out).toContain('"notes dir/a b.md"');
    expect(r.out).toContain('"заметки/план.md"');
  });

  it("does not report a misplaced Markdown file the branch did not change", () => {
    const dir = deployHarness();
    git(dir, "init", "-q", "-b", "main");
    write(dir, "apps/web/old-notes.md", "# old\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "A0-work");
    patchGates(dir, { docsLayout: ["docs/*", "apps/*/README.md"] });
    write(dir, "src/a.ts", lines(5));
    const r = health(dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/misplacedDocs\s+0/);
    expect(r.out).not.toContain("old-notes.md");
  });
});
