/**
 * Skip marks: the one list of ways a test is skipped or focused (0.4.5, one source of truth). The frozen-tests
 * count (frozen.ts, AC-66) and cheat-guard's seed patterns (gates.ts → gates.json cheatPatterns) are both built
 * from it, so a mark added here reaches both. tests/run/skip-marks.test.ts checks each entry's two forms on the
 * same example lines.
 */
export interface SkipMark {
  /** What the mark is, for the test's names. */
  name: string;
  /** POSIX ERE for cheat-guard (BSD and GNU grep: no \b, no lookaround). */
  ere: string;
  /** The same mark as a JS regex source for the frozen-tests count. */
  js: string;
}

const CALLS = "it|test|describe|suite|context|bench";

export const SKIP_MARKS: readonly SkipMark[] = [
  {
    // A modifier right after a test call; a right boundary, so `context.todos` is not one.
    name: "modifier skip / skipIf / only / todo after a test call",
    ere: `(^|[^A-Za-z0-9_])(${CALLS})\\.(skip(If)?|only|todo)([^A-Za-z0-9_]|$)`,
    js: `(?<![.\\w])(?:${CALLS})\\.(?:skip(?:If)?|only|todo)(?!\\w)`,
  },
  {
    // x- (skipped) and f- (focused) test calls of Jasmine, Jest, Mocha.
    name: "x- and f- test calls",
    ere: "(^|[^A-Za-z0-9_.])(x(it|test|describe)|f(it|describe))[[:space:]]*\\(",
    js: "(?<![.\\w])(?:x(?:it|test|describe)|f(?:it|describe))\\s*\\(",
  },
  {
    // Mocha's skip takes no argument, so a parser's `skip(n)` method is not one.
    name: "Mocha this-skip with no argument",
    ere: "(^|[^A-Za-z0-9_.])this\\.skip[[:space:]]*\\([[:space:]]*\\)",
    js: "(?<![.\\w])this\\.skip\\s*\\(\\s*\\)",
  },
  { name: "pytest skip call", ere: "pytest\\.skip[[:space:]]*\\(", js: "\\bpytest\\.skip\\s*\\(" },
  { name: "pytest skip / xfail mark", ere: "@pytest\\.mark\\.(skip|xfail)", js: "@pytest\\.mark\\.(?:skip|xfail)" },
  { name: "unittest skip decorator", ere: "@unittest\\.skip", js: "@unittest\\.skip" },
  { name: "Go t-Skip", ere: "t\\.Skip(Now|f)?[[:space:]]*\\(", js: "\\bt\\.Skip(?:Now|f)?\\s*\\(" },
  { name: "Rust ignore attribute", ere: "#\\[ignore\\]", js: "#\\[ignore\\]" },
];

/** The frozen-tests count's regex, built from the list (AC-66). */
export const SKIPS_REGEX: RegExp = new RegExp(SKIP_MARKS.map((m) => m.js).join("|"), "g");
