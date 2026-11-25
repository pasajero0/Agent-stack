import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupProjects } from "../hooks/fixture.js";
import { startRun } from "../../src/run/engine/index.js";
import { limitAnswers } from "../../src/run/engine/gates.js";
import type { Routing } from "../../src/run/routing.js";
import { DESC, impl, makeFakeExecutable, repo, text } from "./engine-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const ROUTING: Routing = {
  S: { low: "sonnet·low", medium: "sonnet·medium", high: "opus·high" },
  M: { low: "sonnet·low", medium: "sonnet·medium", high: "opus·high" },
  L: { low: "sonnet·medium", medium: "opus·medium", high: "opus·high" },
  retry: "opus·high",
  risky: "opus·high",
  scout: "haiku·low",
};

const label = (reason: string, routing: Routing, key = "r"): string | undefined =>
  limitAnswers(reason, routing).find((a) => a.key === key)?.label;

describe("gate:limit answer labels", () => {
  it("effort1 AC-11: tests-changed and an other reason show the retry route (default routing: opus · high)", () => {
    expect(label("tests-changed", ROUTING)).toBe("retry with a comment (a new attempt, opus · high)");
    expect(label("blocked", ROUTING)).toBe("retry (a new attempt, opus · high)");
    expect(label("attempts", ROUTING)).toBe("retry (a new attempt, opus · high)");
    expect(label("review-loop", ROUTING)).toBe("retry (a new attempt, opus · high)");
  });

  it("effort1 AC-11: a changed retry route shows in the label", () => {
    const changed = { ...ROUTING, retry: "sonnet·max" };
    expect(label("tests-changed", changed)).toBe("retry with a comment (a new attempt, sonnet · max)");
    expect(label("other", changed)).toBe("retry (a new attempt, sonnet · max)");
  });

  it("effort1 AC-11: the card of a stopped run names the route of gates.json", async () => {
    const r = repo({ extra: { routing: { ...ROUTING, retry: "haiku·low" } } });
    r.script([impl({ status: "BLOCKED", report: "the API key is missing", needs: ["which key?"] })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC }), text(r)).toBe(3);
    expect(text(r)).toContain("retry (a new attempt, haiku · low)");
  });

  it("effort1 AC-20: fuse, decision and test-conflict labels are as today", () => {
    const changed = { ...ROUTING, retry: "sonnet·max" };
    expect(label("fuse", changed, "f")).toBe("new limit");
    expect(label("decision", changed)).toBe("retry with your answer (the role gets it)");
    expect(label("test-conflict", changed)).toBe("retry with your answer for the implementer (no attempt is counted)");
    expect(label("tests-changed", changed, "a")).toBe("allow exactly these (the checks run next)");
  });
});
