import { describe, expect, it } from "vitest";
import { CHEAT_PATTERNS } from "../../src/claude/gates.js";
import { SKIP_MARKS, SKIPS_REGEX } from "../../src/run/engine/skip-marks.js";

/**
 * One source of truth for skip marks (0.4.5, defect #19): SKIP_MARKS is the only list; cheat-guard's seed patterns
 * and the frozen-tests count are both built from it. Each mark is checked here on its example lines.
 *
 * The examples are joined from parts on purpose: written whole, they are skip marks themselves, and cheat-guard
 * (rightly) refuses a file that adds them. They are test data, not skipped tests.
 */
const j = (...parts: string[]): string => parts.join("");

const EXAMPLES: Record<string, string[]> = {
  "modifier skip / skipIf / only / todo after a test call": [
    j("it", ".skip", '("a", f)'),
    j("it", ".skip", 'If(ci)("a", f)'),
    j("test", ".only", '("b", f)'),
    j("describe", ".todo", '("c")'),
  ],
  "x- and f- test calls": [j("x", 'it("a", f)'), j("x", 'describe("a", f)'), j("f", 'it("a", f)'), j("f", 'describe("a", f)')],
  "Mocha this-skip with no argument": [j("this", ".skip();")],
  "pytest skip call": [j("pytest", '.skip("slow")')],
  "pytest skip / xfail mark": [j("@pytest.mark", ".skip"), j("@pytest.mark", ".xfail")],
  "unittest skip decorator": [j("@unittest", ".skip")],
  "Go t-Skip": [j("t", '.Skip("flaky")'), j("t", ".SkipNow()")],
  "Rust ignore attribute": [j("#[", "ignore]")],
};

/** A POSIX ERE from gates.json as a JS RegExp: only the classes the list uses. */
const ere = (p: string): RegExp => new RegExp(p.replace(/\[\[:space:\]\]/g, "\\s"));
const frozenCount = (line: string): number => line.match(new RegExp(SKIPS_REGEX.source, "g"))?.length ?? 0;

describe("skip marks: one list (0.4.5)", () => {
  it("every mark has examples, and cheat-guard's seed holds every mark's pattern", () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual(SKIP_MARKS.map((m) => m.name).sort());
    for (const m of SKIP_MARKS) expect(CHEAT_PATTERNS).toContain(m.ere);
  });

  it.each(SKIP_MARKS.map((m) => [m.name, m] as const))("both forms catch: %s", (_name, mark) => {
    for (const line of EXAMPLES[mark.name] ?? []) {
      expect(ere(mark.ere).test(line), `cheat-guard: ${line}`).toBe(true);
      expect(new RegExp(mark.js).test(line), `frozen tests: ${line}`).toBe(true);
      expect(frozenCount(line), `frozen count: ${line}`).toBeGreaterThan(0);
    }
  });

  it("neither form counts ordinary code", () => {
    const ordinary = ["v.iter().skip(1)", "cursor.skip(n)", "this.skip(2)", "lexer.skip()", "context.todos", "req.context.todoId", "profit(x)", "submit(form)", "ftest(x)"];
    for (const line of ordinary) {
      expect(SKIP_MARKS.some((m) => ere(m.ere).test(line)), `cheat-guard: ${line}`).toBe(false);
      expect(frozenCount(line), `frozen count: ${line}`).toBe(0);
    }
  });
});
