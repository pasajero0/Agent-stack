import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { harnessInventory, neverActed, type Inventory } from "../../src/usage/inventory.js";
import { emptyReport } from "../../src/usage/collect.js";

describe("harnessInventory", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-stack-inv-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const touch = (rel: string) => {
    const p = join(dir, ".claude", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "");
  };

  it("returns empty lists when .claude is missing", () => {
    expect(harnessInventory(dir)).toEqual({ hooks: [], bin: [], agents: [], skills: [], commands: [] });
  });

  it("lists installed parts by kind and excludes gates-lib", () => {
    for (const h of ["guard-bash", "gates-lib", "post-edit-lint", "session-start-context", "evidence-gate"]) {
      touch(`hooks/${h}.sh`);
    }
    touch("bin/trace");
    touch("agents/implementer.md");
    touch("skills/spec/SKILL.md");
    touch("commands/review.md");

    expect(harnessInventory(dir)).toEqual({
      hooks: ["evidence-gate", "guard-bash", "post-edit-lint", "session-start-context"],
      bin: ["trace"],
      agents: ["implementer"],
      skills: ["spec"],
      commands: ["review"],
    });
  });
});

describe("neverActed", () => {
  const inv: Inventory = {
    hooks: ["guard-bash", "spec-gate", "evidence-gate", "post-edit-lint", "session-start-context"],
    bin: ["trace", "verify"],
    agents: ["implementer", "test-writer"],
    skills: ["spec", "adr"],
    commands: ["review", "ship"],
  };

  it("lists everything for an empty report", () => {
    expect(neverActed(inv, emptyReport())).toEqual(inv);
  });

  it("drops hooks that blocked, ran as Stop, or added context", () => {
    const r = emptyReport();
    r.hookBlocks["spec-gate"] = 1;
    r.stopRuns["evidence-gate"] = 3;
    r.hookContext["PostToolUse:Edit"] = 1;
    r.hookContext["SessionStart:startup"] = 1;
    expect(neverActed(inv, r).hooks).toEqual(["guard-bash"]);
  });

  it("does not credit context from an unrelated event", () => {
    const r = emptyReport();
    r.hookContext["PreToolUse:Bash"] = 1;
    expect(neverActed(inv, r).hooks).toContain("post-edit-lint");
    expect(neverActed(inv, r).hooks).toContain("session-start-context");
  });

  it("drops used bin tools, agents, skills and commands", () => {
    const r = emptyReport();
    r.bin["trace"] = 1;
    r.agents["implementer"] = 2;
    r.skills["spec"] = 1;
    r.commands["review"] = 1;
    expect(neverActed(inv, r)).toMatchObject({
      bin: ["verify"],
      agents: ["test-writer"],
      skills: ["adr"],
      commands: ["ship"],
    });
  });
});
