import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupProjects, write } from "../hooks/fixture.js";
import { startRun, watchRun } from "../../src/run/engine/index.js";
import { watchView } from "../../src/run/engine/watch.js";
import { writeRun } from "../../src/run/store.js";
import { impl, makeFakeExecutable, repo, text } from "./engine-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const DESC = "Fix the README line.";

describe("run --watch (AC-82)", () => {
  it("v04 AC-82: a finished run shows each ended step with its time; a gate's time is the human's", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC })).toBe(0);
    const view = watchView(r.dir, r.run().id) ?? "";
    expect(view).toMatch(/^run r-\S+ · quick · finished · \d+:\d\d work · \$0\.01\n/);
    expect(view).toMatch(/ {2}✓ implement:Q1 +\d+:\d\d\n/);
    expect(view).toMatch(/ {2}✓ gate:accept +\d+:\d\d waiting for you$/);
  });

  it("v04 AC-82: the step in progress shows its time and its last 5 progress lines; a waiting gate its answer", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    const run = r.run();
    expect(watchView(r.dir, run.id)).toMatch(/⏸ waiting at gate:accept — answer: agent-stack run --resume r-/);
    // Put it back to a running implement, with more tool lines than the view shows.
    const start = new Date(Date.now() - 65_000).toISOString();
    writeRun(r.dir, { ...run, status: "running", next: "implement:Q1", steps: [{ step: "implement:Q1", start, end: null }] });
    const log = Array.from({ length: 7 }, (_, i) => `${start}\timplement:Q1\t· Read f${i}.ts`).join("\n");
    write(r.dir, `.claude/tmp/runs/${run.id}/progress.log`, `${start}\timplement:Q1\tstep implement:Q1\n${log}\n`);
    const view = watchView(r.dir, run.id) ?? "";
    expect(view).toMatch(/ {2}▶ implement:Q1 +1:0\d\n/);
    expect(view.match(/ {6}· Read f\d\.ts/g)).toEqual(["      · Read f2.ts", "      · Read f3.ts", "      · Read f4.ts", "      · Read f5.ts", "      · Read f6.ts"]);
    expect(view).not.toContain("step implement:Q1");
  });

  it("v04 AC-82: without a terminal it prints once; at a terminal it redraws until the run has ended", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC })).toBe(0);
    const id = r.run().id;
    const lines: string[] = [];
    expect(await watchRun({ projectDir: r.dir, id, isTTY: false, out: (l) => lines.push(l) })).toBe(0);
    expect(lines.join("\n")).toContain(`run ${id} · quick · finished`);
    const drawn: string[] = [];
    expect(await watchRun({ projectDir: r.dir, id, isTTY: true, out: () => {}, write: (t) => drawn.push(t) })).toBe(0);
    expect(drawn.length).toBe(1);
    expect(drawn[0]).toMatch(/^\u001b\[2J\u001b\[H/);
  });

  it("v04 AC-82: no run holding the lock, or a run that does not exist, is said and exits 0", async () => {
    const r = repo();
    const lines: string[] = [];
    expect(await watchRun({ projectDir: r.dir, isTTY: false, out: (l) => lines.push(l) })).toBe(0);
    expect(lines.join("\n")).toContain("No run holds the lock");
    expect(await watchRun({ projectDir: r.dir, id: "r-20990101-000000", isTTY: false, out: (l) => lines.push(l) })).toBe(0);
    expect(lines.join("\n")).toContain("does not exist");
    expect(text(r)).toBe("");
  });
});
