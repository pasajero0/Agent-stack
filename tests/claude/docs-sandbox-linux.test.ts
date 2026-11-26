import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

/** A `## ` section of a Markdown text: from its heading to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + 3);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

describe("Q1: README Limits — Linux and the token mask", () => {
  const limits = section(readme, "## Limits — read before trusting it");

  it("Q1: the OS sandbox item has a Linux sub-item with its facts", () => {
    const at = limits.indexOf("  - **Linux:**");
    expect(at).toBeGreaterThan(-1);
    const item = limits.slice(at, limits.indexOf("\n  - ", at + 5));
    for (const word of [
      "macOS only",
      "bubblewrap",
      "socat",
      "CI installs them",
      "no live probe",
      '"/**"',
      "allowWrite",
      "does not exist yet",
    ]) {
      expect(item, word).toContain(word);
    }
  });

  it("Q1: the token file sub-item says why the token is not masked", () => {
    const at = limits.indexOf("**The driver started from the chat's Bash (macOS) needs a token file.**");
    expect(at).toBeGreaterThan(-1);
    const item = limits.slice(at, limits.indexOf("\n  - ", at));
    expect(item).toContain("Make the file once");
    expect(item).toContain("the token makes model requests only");
    expect(item).toContain("placeholder");
    expect(item).toContain("not from a project's settings");
    expect(item).toContain("experimental");
    expect(item).toContain("the harness does not set it");
  });
});
