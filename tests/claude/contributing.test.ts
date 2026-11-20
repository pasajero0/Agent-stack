import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SCOPES } from "../../commitlint.config.js";

/** The scope column of CONTRIBUTING.md's commit table: plain scopes only, not `<spec>-<version>` or `<stage>`. */
function contributingScopes(): string[] {
  const text = readFileSync(new URL("../../CONTRIBUTING.md", import.meta.url), "utf8");
  const table = text.slice(text.indexOf("| Scope |"), text.indexOf("Tests take the scope"));
  const out: string[] = [];
  for (const row of table.split("\n").slice(2)) {
    const first = row.split("|")[1] ?? "";
    for (const m of first.matchAll(/`([a-z]+)`/g)) if (m[1]) out.push(m[1]);
  }
  return out.sort();
}

describe("commit scopes: one list (0.4.5)", () => {
  it("CONTRIBUTING's scope table and commitlint's SCOPES name the same scopes", () => {
    expect(contributingScopes()).toEqual([...SCOPES].sort());
  });
});
