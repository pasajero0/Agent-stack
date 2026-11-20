import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, git, patchGates, write } from "../hooks/fixture.js";
import { resumeRun, startRun, statusRun } from "../../src/run/engine/index.js";
import { sha256 } from "../../src/run/engine/card.js";
import { makeFakeExecutable, repo, text, type Repo } from "./engine-fixture.js";
import { runDir } from "../../src/run/store.js";
import { clarify, mergeSpec, patchRun, plan, TASK_DESC, TASKS_PATH, toPlanApprove, toSpecMerge, twoTasksDone } from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

/** `--status --json` as an object. */
async function status(r: Repo): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  expect(await statusRun({ ...r.opts(), out: (l) => lines.push(l), json: true })).toBe(0);
  return JSON.parse(lines.join("\n")) as Record<string, unknown>;
}

describe("gate cards (AC-68, AC-69)", () => {
  it("v04 AC-68: the plan gate prints one card and keeps it in the run file, keyed by the plan's sha256", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    const card = r.run().card;
    expect(card?.gate).toBe("plan-approve");
    expect(card?.source).toBe(sha256(readFileSync(join(r.dir, TASKS_PATH), "utf8")));
    expect(card?.facts).toContain(`full task text: ${TASKS_PATH}`);
    expect(card?.prompts[0]?.answers.map((a) => a.key)).toEqual(["a", "r", "c"]);
    const t = text(r);
    expect(t).toMatch(/━━ Plan B1: 2 task\(s\)/);
    expect(t).toContain("Needed from you: approve the plan");
    expect(t).toContain("a — approve · r <text> — reject");
  });

  it("v04 AC-68: gate:accept starts with a summary, then time and cost; a skipped command is named once; the waiting line names the keys", async () => {
    const r = repo();
    await toPlanApprove(r, [plan(), ...twoTasksDone()]);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(3);
    const facts = r.run().card?.facts ?? [];
    expect(facts[0]).toBe("2 task(s) · 2 commit(s) · checks green · final check green");
    expect(facts[1]).toMatch(/^time: /);
    expect(facts.findIndex((f) => f.startsWith("Usage:"))).toBeLessThan(facts.findIndex((f) => f.startsWith("Diff from")));
    expect(facts).toContain("branch: B1-add-a-greeting");
    expect(facts.filter((f) => f.includes("(empty lint command)")).length).toBeLessThanOrEqual(1);
    expect(text(r)).toMatch(/Waiting at gate:accept for your answer \(a \| r <text> \| c\): agent-stack run --resume r-\S+ --answer <answer>/);
  });

  it("v04 AC-77: a verify with command substitution is marked at the plan gate; the plan stays valid", async () => {
    const r = repo();
    const tasks = [
      { id: "T1", ac: ["AC-1"], tier: "S" as const, desc: "say hello", verify: 'test "$(cat hello.txt)" = hi' },
      { id: "T2", ac: ["AC-2"], tier: "S" as const, desc: "say bye", verify: "test -f bye.txt" },
    ];
    await toPlanApprove(r, [plan({ tasks })]);
    const facts = r.run().card?.facts ?? [];
    const i = facts.findIndex((f) => f.includes("verify: test \"$(cat hello.txt)\""));
    expect(facts[i + 1]).toContain("note: implement cannot run this verify itself");
    expect(facts.filter((f) => f.includes("cannot run this verify")).length).toBe(1);
    expect(r.run().next).toBe("gate:plan-approve");
  });

  it("v04 AC-68: a gate's card is cleared once the gate decides; the next gate keeps its own", async () => {
    const r = repo();
    await toPlanApprove(r, [plan(), ...twoTasksDone()]);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) }), text(r)).toBe(3);
    const run = r.run();
    expect(run.next).toBe("gate:accept");
    expect(run.card?.gate).toBe("accept");
    expect(text(r)).toMatch(/━━ Accept: B1 · 2 task\(s\) ━━/);
  });

  it("v04 AC-69: --status --json gives the run, the kept card and the language; en by default", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    const s = await status(r);
    expect((s["run"] as Record<string, unknown>)["next"]).toBe("gate:plan-approve");
    expect((s["run"] as Record<string, unknown>)["costUnknownCalls"]).toBe(0);
    expect((s["card"] as Record<string, unknown>)["gate"]).toBe("plan-approve");
    expect(s["language"]).toEqual({ chat: "en", terms: "en" });
    expect(s["warnings"]).toEqual([]);
  });

  it("v04 AC-76: gates.json language is given to the chat; a bad value is en with a warning", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    patchGates(r.dir, { language: { chat: "ru", terms: "en" } });
    expect((await status(r))["language"]).toEqual({ chat: "ru", terms: "en" });
    patchGates(r.dir, { language: { chat: "Russian" } });
    const s = await status(r);
    expect(s["language"]).toEqual({ chat: "en", terms: "en" });
    expect(String(s["warnings"])).toContain("language.chat");
  });

  it("v04 AC-69: with no run, --status --json prints run null and says why", async () => {
    const r = repo();
    const s = await status(r);
    expect(s["run"]).toBeNull();
    expect(s["card"]).toBeNull();
    expect(String(s["warnings"])).toContain("no run");
  });
});

describe("--answer (AC-70)", () => {
  it("v04 AC-70: an answer decides only the gate the run waits at; the next gate waits for the human again", async () => {
    const r = repo();
    await toPlanApprove(r, [plan(), ...twoTasksDone()]);
    expect(await resumeRun({ ...r.opts(), answers: ["a"] }), text(r)).toBe(3);
    const run = r.run();
    expect(run.next).toBe("gate:accept");
    expect(run.status).toBe("waiting");
    expect(run.gates.map((g) => g.decision)).toEqual(["confirm", "merged", "approve"]);
  });

  it("v04 AC-70: extra answers are refused before anything is applied, so one --resume cannot answer two gates", async () => {
    const r = repo();
    await toPlanApprove(r, [plan(), ...twoTasksDone()]);
    const before = r.run();
    const calls = r.logged().length;
    expect(await resumeRun({ ...r.opts(), answers: ["a", "a"] })).toBe(1);
    expect(text(r)).toContain('Extra answers: "a"');
    const run = r.run();
    expect(run.next).toBe("gate:plan-approve");
    expect(run.status).toBe("waiting");
    expect(run.gates).toEqual(before.gates);
    expect(r.logged().length).toBe(calls);
  });

  it("v04 AC-70: an answer the gate does not take is refused with code 1, and the run keeps waiting", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    expect(await resumeRun({ ...r.opts(), answers: ["yes"] })).toBe(1);
    expect(text(r)).toContain("Answer a (approve)");
    expect(r.run().status).toBe("waiting");
    expect(r.run().next).toBe("gate:plan-approve");
  });

  it("v04 AC-68: a plan replaced while the gate waited is shown again; under --answer that is a refusal", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    const old = r.run().card?.source;
    const file = join(r.dir, TASKS_PATH);
    const changed = JSON.parse(readFileSync(file, "utf8")) as { tasks: { verify: string }[] };
    const first = changed.tasks[0];
    if (first) first.verify = "true";
    writeFileSync(file, JSON.stringify(changed, null, 2));
    expect(await resumeRun({ ...r.opts(), answers: ["a"] })).toBe(1);
    expect(text(r)).toContain("The gate changed since its card was shown");
    const run = r.run();
    expect(run.next).toBe("gate:plan-approve");
    expect(run.card?.source).not.toBe(old);
    expect(run.gates.at(-1)?.decision).not.toBe("approve");
  });

  it("v04 AC-70: --answer at gate:spec-merge, which takes no answer, is refused before anything runs", async () => {
    const r = repo();
    await toSpecMerge(r);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts(), answers: ["a"] })).toBe(1);
    expect(text(r)).toContain("--answer needs a run waiting at a gate that takes an answer");
    expect(r.run().next).toBe("gate:spec-merge");
  });

  it("v04 AC-70: answers that run out before the gate decides apply nothing; the next resume starts at the first prompt", async () => {
    const r = repo();
    r.script([clarify()]);
    // No terminal and no gate input: the run waits at gate:answers.
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC })).toBe(3);
    expect(await resumeRun({ ...r.opts(), answers: [""] })).toBe(3);
    const run = r.run();
    expect(run.next).toBe("gate:answers");
    expect(run.answers).toEqual([]);
    expect(run.card?.gate).toBe("answers");
    expect(run.card?.prompts.at(-2)?.answers.map((a) => a.key)).toEqual(["task", "story", "epic", "c"]);
  });
});

describe("--answer on the paths that write files (AC-68, AC-70)", () => {
  it("v04 AC-70: a reject with an extra answer is refused before run.json or tasks.json change", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    const before = readFileSync(join(runDir(r.dir, r.run().id), "run.json"), "utf8");
    expect(await resumeRun({ ...r.opts(), answers: ["r split T2", "a"] })).toBe(1);
    expect(existsSync(join(r.dir, TASKS_PATH))).toBe(true);
    const after = JSON.parse(readFileSync(join(runDir(r.dir, r.run().id), "run.json"), "utf8")) as { gates: unknown[]; next: string };
    expect(after.gates).toEqual((JSON.parse(before) as { gates: unknown[] }).gates);
    expect(after.next).toBe("gate:plan-approve");
  });

  it("v04 AC-70: with size epic a stage-id answer is extra, and split.md is not written", async () => {
    const r = repo();
    r.script([clarify({ size: "epic", split: [{ id: "C1", goal: "part one" }] })]);
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC })).toBe(3);
    const questions = (r.run().card?.prompts.length ?? 0) - 2;
    const answers = [...Array.from({ length: questions }, () => ""), "epic", ""];
    expect(await resumeRun({ ...r.opts(), answers })).toBe(1);
    expect(text(r)).toContain('Extra answers: ""');
    expect(existsSync(join(runDir(r.dir, r.run().id), "split.md"))).toBe(false);
    expect(r.run().next).toBe("gate:answers");
  });

  it("v04 AC-68: a gate:answers resume takes the stage id the card showed", async () => {
    const r = repo();
    r.script([clarify()]);
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC })).toBe(3);
    const card = r.run().card;
    if (!card) throw new Error("no card");
    const prompts = card.prompts.map((p, i) => (i === card.prompts.length - 1 ? { ...p, default: "C7" } : p));
    patchRun(r, { card: { ...card, prompts } });
    r.script([clarify(), { expectRole: "spec", output: { needsHumanDecision: [] } }]);
    await resumeRun({ ...r.opts(), answers: prompts.map(() => "") });
    expect(r.run().stage).toBe("C7");
  });

  it("v04 AC-68: a resume at gate:accept shows the kept card without a new final check; a moved HEAD refuses --answer", async () => {
    const r = repo();
    await toPlanApprove(r, [plan(), ...twoTasksDone()]);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(3);
    const log = (): number => (readFileSync(join(r.dir, ".claude/tmp/B1/verify.log"), "utf8").match(/^=== verify/gm) ?? []).length;
    const runs = log();
    expect(await resumeRun({ ...r.opts() })).toBe(3);
    expect(log()).toBe(runs);
    const old = r.run().card?.source;
    write(r.dir, "late.txt", "x\n");
    git(r.dir, "add", "late.txt");
    git(r.dir, "commit", "-q", "-m", "chore: late");
    expect(await resumeRun({ ...r.opts(), answers: ["a"] })).toBe(1);
    expect(text(r)).toContain("The gate changed since its card was shown");
    const run = r.run();
    expect(run.status).toBe("waiting");
    expect(run.next).toBe("gate:accept");
    expect(run.card?.source).not.toBe(old);
    expect(log()).toBe(runs + 1);
  });

  it("v04 AC-68: a run waiting with no kept card (an older driver) shows the card first and refuses the answer", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    patchRun(r, { card: null });
    expect(await resumeRun({ ...r.opts(), answers: ["a"] })).toBe(1);
    expect(r.run().card?.gate).toBe("plan-approve");
    expect(r.run().gates.at(-1)?.decision).not.toBe("approve");
  });

  it("v04 AC-69: a run that waits at no gate gives card null", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    patchRun(r, { status: "running" });
    expect((await status(r))["card"]).toBeNull();
  });
});

describe("run command flags (AC-69, AC-70)", () => {
  it("v04 AC-70: --answer without --resume, and --json without --status, are refused with code 1", async () => {
    const { runCommand } = await import("../../src/commands/run.js");
    const r = repo();
    const out: string[] = [];
    const io = { projectDir: r.dir, out: (l: string) => out.push(l) };
    expect(await runCommand("quick", "x", { answer: ["a"] }, io)).toBe(1);
    expect(out.join("\n")).toContain("--answer needs --resume");
    expect(await runCommand(undefined, undefined, { cancel: true, json: true }, io)).toBe(1);
    expect(out.join("\n")).toContain("--json goes with --status");
  });
});
