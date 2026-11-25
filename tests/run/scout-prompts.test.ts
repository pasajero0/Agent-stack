/**
 * scout1: the map section in the clarify, spec and plan prompts. The prompt builders put it at the Contract's
 * place (AC-5); the engine reads scout.md each time it builds one of these prompts: the first call, a re-run, a
 * run after a reject and a run after gate:limit (AC-5); no map, an unreadable map, a map with no entry line and
 * the 31st entry line never reach a prompt (AC-17). Spec: docs/specs/scout1/SPEC.md.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupProjects } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { readMapLines } from "../../src/run/engine/steps-scout.js";
import { clarifyPrompt, planPrompt, specPrompt } from "../../src/run/prompts.js";
import { runDir } from "../../src/run/store.js";
import { makeFakeExecutable, repo, text, type Repo } from "./engine-fixture.js";
import { clarify, mergeSpec, patchRun, plan, scout, spec, TASK_DESC, toSpecMerge } from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const HEAD =
  "Starting map (from the driver's scout, a cheap read-only call; it can miss places or be wrong). Read these places first; read a whole file only when the listed lines are not enough:";
const E1 = "- `src/a.ts:1-5` — why a";
const E2 = "- `src/b.ts` — why b";
/** The entry line of the default scout() call of the engine fixture. */
const README = "- `README.md` — the project readme";

function skills(): string {
  const dir = mkdtempSync(join(tmpdir(), "scout-prompts-"));
  for (const s of ["spec", "plan"]) {
    mkdirSync(join(dir, ".claude", "skills", s), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", s, "SKILL.md"), `SKILL-${s}`);
  }
  return dir;
}

const answers = [{ question: "Q1?", answer: "A1" }] as never;

const scoutFile = (r: Repo): string => join(runDir(r.dir, r.run().id), "scout.md");
const prompts = (r: Repo): string[] => r.logged().map((c) => c.prompt);
const roleOf = (p: string): string => (p.split("\n").find((l) => l.trim() !== "") ?? "").replace("# Role: ", "");
/** The prompts of one role, in call order. */
const promptsOf = (r: Repo, role: string): string[] => prompts(r).filter((p) => roleOf(p) === role);
const section = (...entries: string[]): string => `\n\n${HEAD}\n${entries.join("\n")}\n\n`;
/** A scout map in the writer's layout with the given entry lines. */
const mapFile = (entries: string[]): string => `# Scout map\n\nRun r · haiku · low · ${entries.length} places\n\n${entries.map((e) => `${e}\n`).join("")}`;

describe("scout1 AC-5: the prompt builders put the map section at the Contract's place", () => {
  it("scout1 AC-5: clarify puts it after the description", () => {
    const t = clarifyPrompt({ description: "DESC", used: [], map: [E1, E2] });
    expect(t).toContain(`DESC${section(E1, E2)}- Ask at most 5`);
  });

  it("scout1 AC-5: spec puts it after the answers", () => {
    const t = specPrompt(skills(), { stage: "A1", title: "T", description: "D", answers, map: [E1, E2] });
    expect(t).toContain(`A: A1${section(E1, E2)}The /spec skill follows.`);
  });

  it("scout1 AC-5: plan puts it right before the skill line", () => {
    const t = planPrompt(skills(), { stage: "A1", title: "T", map: [E1] });
    expect(t).toContain(`the file.${section(E1)}The /plan skill follows.`);
  });

  it("scout1 AC-5: plan after a reject puts it after the comment", () => {
    const t = planPrompt(skills(), { stage: "A1", title: "T", comment: "NO!", map: [E1] });
    expect(t).toContain(`Their comment:\nNO!${section(E1)}The /plan skill follows.`);
  });
});

describe("scout1 AC-5: the engine puts the map section in every clarify, spec and plan call", () => {
  it("scout1 AC-5: clarify, spec and plan of a task run each get the scout map's entry lines", async () => {
    const r = repo();
    await toSpecMerge(r, [plan()]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:plan-approve");
    const [c] = promptsOf(r, "clarify");
    const [s] = promptsOf(r, "spec");
    const [p] = promptsOf(r, "plan");
    expect(c).toContain(`Task description:\n${TASK_DESC}${section(README)}- Ask at most 5`);
    expect(s).toContain(`A: hello.txt${section(README)}The /spec skill follows.`);
    expect(p).toContain(`${section(README)}The /plan skill follows.`);
    expect(p).not.toContain("Their comment:");
  });

  it("scout1 AC-5: a clarify re-run reads scout.md again and gets its current entry lines", async () => {
    const r = repo();
    r.script([scout(), clarify(), clarify()]);
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC }), text(r)).toBe(3);
    writeFileSync(scoutFile(r), mapFile([E1, E2]));
    patchRun(r, { next: "clarify", status: "running", proposal: null });
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    const [first, again] = promptsOf(r, "clarify");
    expect(first).toContain(section(README));
    expect(again).toContain(`${TASK_DESC}${section(E1, E2)}- Ask at most 5`);
    expect(again).not.toContain(README);
  });

  it("scout1 AC-5: a spec re-run after gate:limit (decision) gets the map section", async () => {
    const r = repo();
    r.script([scout(), clarify(), spec({ writes: {}, needs: ["Which greeting language?"] }), spec()]);
    expect(await startRun({ ...r.opts({ gate: ["", "", "", "r", "English"] }), mode: "task", description: TASK_DESC }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:spec-merge");
    const specs = promptsOf(r, "spec");
    expect(specs).toHaveLength(2);
    for (const s of specs) expect(s).toContain(`A: hello.txt${section(README)}The /spec skill follows.`);
    expect(specs[1]).toContain("FROM THE HUMAN: you asked: Which greeting language?; the answer: English");
  });

  it("scout1 AC-5: a spec call after a fuse stop at gate:limit gets the map section", async () => {
    const r = repo({ run: { fuse: { calls: 2 } } });
    r.script([scout(), clarify(), spec()]);
    expect(await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC }), text(r)).toBe(3);
    expect(r.run()).toMatchObject({ next: "gate:limit", returnTo: "spec", limitReason: "fuse" });
    expect(promptsOf(r, "spec")).toHaveLength(0);
    expect(await resumeRun({ ...r.opts({ gate: ["f 5"] }) }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:spec-merge");
    const [s] = promptsOf(r, "spec");
    expect(s).toContain(`A: hello.txt${section(README)}The /spec skill follows.`);
  });

  it("scout1 AC-5: a plan re-run after a reject at gate:plan-approve gets the map section after the comment", async () => {
    const r = repo();
    await toSpecMerge(r, [plan(), plan()]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts({ gate: ["r", "split T1 in two", "c"] }) }), text(r)).toBe(0);
    const plans = promptsOf(r, "plan");
    expect(plans).toHaveLength(2);
    expect(plans[0]).toContain(`${section(README)}The /plan skill follows.`);
    expect(plans[1]).toContain(`Their comment:\nsplit T1 in two${section(README)}The /plan skill follows.`);
  });
});

describe("scout1 AC-17: no map section", () => {
  it("scout1 AC-17: no map or an empty one gives the prompt exactly as before", () => {
    const dir = skills();
    expect(clarifyPrompt({ description: "D", used: [], map: [] })).toBe(clarifyPrompt({ description: "D", used: [] }));
    expect(specPrompt(dir, { stage: "A1", title: "T", description: "D", answers, map: [] })).toBe(
      specPrompt(dir, { stage: "A1", title: "T", description: "D", answers })
    );
    expect(planPrompt(dir, { stage: "A1", title: "T", comment: "NO!", map: [] })).toBe(planPrompt(dir, { stage: "A1", title: "T", comment: "NO!" }));
    expect(planPrompt(dir, { stage: "A1", title: "T" })).not.toContain("Starting map");
  });

  it("scout1 AC-17: an unreadable map gives no lines", () => {
    expect(readMapLines(join(tmpdir(), "scout-prompts-none", "scout.md"))).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "scout-prompts-"));
    mkdirSync(join(dir, "scout.md"));
    expect(readMapLines(join(dir, "scout.md"))).toEqual([]);
  });

  it("scout1 AC-17: a map with no entry line gives no lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-prompts-"));
    const f = join(dir, "scout.md");
    writeFileSync(f, "# Scout map\n\nRun r · m · e · 0 places\n\nnot an entry\n");
    expect(readMapLines(f)).toEqual([]);
  });

  it("scout1 AC-17: a run with no scout map builds clarify, spec and plan with no map section and goes on", async () => {
    const n = repo();
    n.script([scout([]), clarify(), spec(), plan()]);
    expect(await startRun({ ...n.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC }), text(n)).toBe(3);
    expect(text(n)).toContain("scout: no map (empty list); the run goes on without it");
    mergeSpec(n);
    expect(await resumeRun({ ...n.opts() }), text(n)).toBe(3);
    expect(n.run().next).toBe("gate:plan-approve");
    for (const role of ["clarify", "spec", "plan"]) {
      const ps = promptsOf(n, role);
      expect(ps, role).toHaveLength(1);
      expect(ps[0], role).not.toContain("Starting map");
    }
    const [c] = promptsOf(n, "clarify");
    expect(c).toContain(`Task description:\n${TASK_DESC}\n\n- Ask at most 5`);
    const [s] = promptsOf(n, "spec");
    expect(s).toContain("A: hello.txt\n\nThe /spec skill follows.");
  });

  it("scout1 AC-17: an unreadable scout map gives a plan prompt with no map section, and the run goes on", async () => {
    const r = repo();
    await toSpecMerge(r, [plan()]);
    rmSync(scoutFile(r));
    mkdirSync(scoutFile(r));
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:plan-approve");
    const [p] = promptsOf(r, "plan");
    expect(p).not.toContain("Starting map");
    expect(p).toMatch(/\.\n\nThe \/plan skill follows\./);
  });

  it("scout1 AC-17: a scout map with no entry line gives a plan prompt with no map section", async () => {
    const r = repo();
    await toSpecMerge(r, [plan()]);
    writeFileSync(scoutFile(r), "# Scout map\n\nRun r · haiku · low · 0 places\n\nnot an entry\n- `broken entry\n");
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    const [p] = promptsOf(r, "plan");
    expect(p).not.toContain("Starting map");
    expect(p).not.toContain("not an entry");
    expect(p).not.toContain("broken entry");
  });

  it("scout1 AC-17: a line that is not an entry line, and the 31st entry line, never reach a prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-prompts-"));
    const f = join(dir, "scout.md");
    const entries = Array.from({ length: 31 }, (_, i) => `- \`src/f${i}.ts\` — why ${i}`);
    writeFileSync(f, `# Scout map\n\nheader\n\nstray line\n${entries.join("\n")}\n`);
    const lines = readMapLines(f);
    expect(lines).toEqual(entries.slice(0, 30));
    const t = clarifyPrompt({ description: "D", used: [], map: lines });
    expect(t).not.toContain("stray line");
    expect(t).not.toContain("src/f30.ts");
    expect(t).toContain("src/f29.ts");
  });

  it("scout1 AC-17: in a run, the plan prompt gets only the first 30 entry lines of scout.md and no other line", async () => {
    const r = repo();
    await toSpecMerge(r, [plan()]);
    const entries = Array.from({ length: 31 }, (_, i) => `- \`src/f${i}.ts\` — why ${i}`);
    writeFileSync(scoutFile(r), `# Scout map\n\nRun r · haiku · low · 31 places\n\nstray line\n${entries.join("\n")}\n`);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    const [p] = promptsOf(r, "plan");
    expect(p).toContain(`${section(...entries.slice(0, 30))}The /plan skill follows.`);
    expect(p).not.toContain("src/f30.ts");
    expect(p).not.toContain("stray line");
    expect(p).not.toContain("# Scout map");
    expect(p).not.toContain("31 places");
  });
});
