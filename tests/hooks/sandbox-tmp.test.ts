import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanupProjects, deployHarness, git, runHook, write } from "./fixture.js";

afterAll(cleanupProjects);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "agent-stack-sbx-"));
}

describe("Q1: harness temp files stay where the sandbox allows", () => {
  it("Q1 verify records a pass when mktemp cannot write", () => {
    const dir = deployHarness();
    git(dir, "init", "-q", "-b", "main");
    write(dir, "README.md", "# demo\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-q", "-m", "init");
    write(dir, ".claude/tmp/A0/tasks.json", JSON.stringify({ stage: "A0", tasks: [{ id: "T1", verify: "true", passes: false }] }));
    git(dir, "checkout", "-q", "-b", "A0-x");
    // A mktemp that always fails, like the sandbox on macOS (bare mktemp ignores $TMPDIR).
    const fake = scratch();
    writeFileSync(join(fake, "mktemp"), "#!/bin/sh\necho 'mktemp: Operation not permitted' >&2\nexit 1\n");
    chmodSync(join(fake, "mktemp"), 0o755);
    const r = spawnSync(join(dir, ".claude/bin/verify"), ["T1"], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, PATH: `${fake}:${process.env.PATH}` },
    });
    const out = r.stdout + r.stderr;
    expect(out).toContain("PASS T1");
    expect(out).toContain("1/1 tasks passing");
    const tasks = JSON.parse(readFileSync(join(dir, ".claude/tmp/A0/tasks.json"), "utf-8")).tasks;
    expect(tasks[0].passes).toBe(true);
  });

  it("Q1 both hooks put markers under TMPDIR and agree on the folder", () => {
    const dir = deployHarness();
    const tmp = scratch();
    const home = scratch();
    const cwd = "/proj/demo";
    const mem = join(home, ".claude/projects", cwd.replace(/\//g, "-"), "memory");
    mkdirSync(mem, { recursive: true });
    const env = { TMPDIR: tmp, HOME: home };
    const start = runHook(dir, "session-start-context.sh", { session_id: "s1", cwd, source: "resume" }, env);
    expect(start.code).toBe(0);
    const marker = join(tmp, "claude-sessions", "s1.start");
    expect(existsSync(marker)).toBe(true);
    // Make the marker older than the memory file, then let the Stop hook compare.
    utimesSync(marker, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    writeFileSync(join(mem, "note.md"), "x");
    const stop = runHook(dir, "stop-flag-reflect.sh", { session_id: "s1", cwd }, env);
    expect(stop.code).toBe(0);
    expect(existsSync(join(tmp, ".claude-reflect-pending"))).toBe(true);
    // The next session start reads and removes the flag from the same place.
    runHook(dir, "session-start-context.sh", { session_id: "s2", cwd, source: "startup" }, env);
    expect(existsSync(join(tmp, ".claude-reflect-pending"))).toBe(false);
  });
});
