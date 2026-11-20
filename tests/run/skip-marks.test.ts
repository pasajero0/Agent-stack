import { describe, expect, it } from "vitest";
import { CHEAT_PATTERNS } from "../../src/claude/gates.js";
import { SKIPS } from "../../src/run/engine/frozen.js";

/**
 * One source of truth for skip marks (0.4.5, defect #19): every form a test can be skipped or focused with. The
 * cheat-guard patterns (POSIX ERE in gates.json) and the frozen-tests count (frozen.ts) must both catch each one;
 * before 0.4.5 cheat-guard missed `.todo` and `this.skip(`, and frozen tests missed `fit(` and `fdescribe(`.
 */
const SKIP_FORMS = [
  'it.skip("a", f)',
  'test.only("a", f)',
  'describe.todo("a")',
  'it.skipIf(ci)("a", f)',
  'xit("a", f)',
  'xdescribe("a", f)',
  'fit("a", f)',
  'fdescribe("a", f)',
  "this.skip();",
  "pytest.skip(\"slow\")",
  "@pytest.mark.skip",
  "@pytest.mark.xfail",
  "@unittest.skip",
  't.Skip("flaky")',
  "#[ignore]",
];

/** A POSIX ERE from gates.json as a JS RegExp: only the classes the list uses. */
const ere = (p: string): RegExp => new RegExp(p.replace(/\[\[:space:\]\]/g, "\\s"));

describe("skip marks: one list (0.4.5)", () => {
  it.each(SKIP_FORMS)("both cheat-guard and the frozen-tests count catch %s", (line) => {
    expect(CHEAT_PATTERNS.some((p) => ere(p).test(line)), "cheat-guard").toBe(true);
    expect(line.match(new RegExp(SKIPS.source, "g"))?.length ?? 0, "frozen tests").toBeGreaterThan(0);
  });

  it("neither counts code that only looks like a skip", () => {
    for (const line of ["v.iter().skip(1)", "cursor.skip(n)", "profit(x)", "submit(form)"]) {
      expect(CHEAT_PATTERNS.some((p) => ere(p).test(line)), line).toBe(false);
      expect(line.match(new RegExp(SKIPS.source, "g")), line).toBeNull();
    }
  });
});
