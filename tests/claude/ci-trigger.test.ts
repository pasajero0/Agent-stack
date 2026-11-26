import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const trigger = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\njobs:"));

describe("CI trigger (0.5.2)", () => {
  it("Q1: push runs on main, release/** and hotfix/**", () => {
    for (const pattern of ["main", "release/**", "hotfix/**"]) {
      expect(trigger).toContain(pattern);
    }
  });

  it("Q1: the pull request trigger is still there", () => {
    expect(trigger).toMatch(/^ {2}pull_request:/m);
  });
});
