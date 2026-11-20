import { describe, expect, it } from "vitest";
import { parsePlan } from "../../src/run/engine/plan-file.js";

const SPEC = "- **AC-1:** x\n";
const planWith = (verify: string, passes = false): string =>
  JSON.stringify({ stage: "A1", tasks: [{ id: "T2", ac: ["AC-1"], tier: "S", desc: "d", verify, passes }] });

describe("plan-file: a verify that cannot fail", () => {
  const never: [string, string][] = [
    ["pnpm test || true", "|| true"],
    ["pnpm test ||true", "|| true"],
    ["pnpm test || :", "|| :"],
    ["test -f x || echo missing", "|| echo"],
    ["pnpm test || exit 0", "|| exit 0"],
    ["pnpm test; true", "; true"],
    ["pnpm test ; exit 0", "; exit 0"],
    ["set +e; pnpm test", "set +e"],
    ["set +o errexit; pnpm test", "set +o errexit"],
    ["pnpm test | tee test.log", "| tee"],
    ["pnpm test | cat", "| cat"],
    ["pnpm test\ntrue", "a last line true"],
    ["pnpm test\n  exit 0\n", "a last line exit 0"],
  ];
  for (const [verify, pattern] of never) {
    it(`v04 AC-65: ${JSON.stringify(verify)} makes a new plan not valid, naming the task and ${pattern}`, () => {
      expect(parsePlan(planWith(verify), SPEC)).toBe(`task T2: verify cannot fail (${pattern}); remove it`);
    });
  }

  const fine = [
    'pnpm vitest run x -t "true value"',
    "node --test a.test.js",
    "test -f a.test.ts && pnpm vitest run a.test.ts",
    "pnpm test || pnpm test:retry",
    "true",
    ".claude/bin/trace && .claude/bin/health && pnpm test",
    "grep -q trueValue src/a.ts",
    "test -f x 2>/dev/null || exit 1",
    "pnpm test 2>/dev/null",
  ];
  for (const verify of fine) {
    it(`v04 AC-65: ${JSON.stringify(verify)} is a verify that can fail`, () => {
      expect(parsePlan(planWith(verify), SPEC)).toMatchObject([{ id: "T2", verify }]);
    });
  }

  it("v04 AC-65: a plan approved earlier is read as it is, so a run in progress is not stopped", () => {
    expect(parsePlan(planWith("pnpm test || true", true), SPEC, false)).toMatchObject([{ id: "T2" }]);
  });
});
