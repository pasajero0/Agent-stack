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

describe("CI Linux sandbox tools (0.5.4)", () => {
  it("Q1: the check job installs bubblewrap and socat before the steps that run the tests", () => {
    const job = workflow.slice(workflow.indexOf("\n  check:"));
    const install = job.search(/sudo apt-get install -y bubblewrap socat/);
    expect(install).toBeGreaterThan(-1);
    expect(job.indexOf("sudo apt-get update")).toBeGreaterThan(-1);
    expect(job.indexOf("sudo apt-get update")).toBeLessThan(install);
    expect(install).toBeLessThan(job.indexOf("pnpm install --frozen-lockfile"));
    expect(install).toBeLessThan(job.indexOf("pnpm test:fast"));
    expect(install).toBeLessThan(job.indexOf("pnpm test:slow"));
  });
});
