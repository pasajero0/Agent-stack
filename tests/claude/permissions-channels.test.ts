import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHarnessFiles, planUpdate } from "../../src/claude/harness.js";
import { ASK_ENTRIES, DENY_ENTRIES } from "../../src/claude/permissions.js";
import { cleanupProjects, deployHarness, TS_PARAMS } from "../hooks/fixture.js";

afterAll(cleanupProjects);

const CHROME = "mcp__claude-in-chrome__*";
const WARN_CHROME =
  "mcp__claude-in-chrome__* is not in permissions.deny of .claude/settings.json: Claude in Chrome tools run without a question";
const WARN_FETCH = "WebFetch is not in permissions.ask of .claude/settings.json: WebFetch runs under the usual permission rules";
const WARN_MCP = "mcp__* is not in permissions.ask of .claude/settings.json: MCP tools run under the usual permission rules";

const settingsPath = (dir: string) => join(dir, ".claude/settings.json");
const manifestPath = (dir: string) => join(dir, ".claude/.harness.json");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8"));
const writeJson = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v, null, 2) + "\n");
const planned = (plan: ReturnType<typeof planUpdate>, path: string) => {
  const f = plan.toWrite.find((x) => x.path === path);
  return f ? JSON.parse(f.content) : null;
};
const apply = (dir: string, plan: ReturnType<typeof planUpdate>) => {
  for (const f of plan.toWrite) writeFileSync(join(dir, f.path), f.content);
};

describe("Q1: the channels past the OS sandbox", () => {
  it("Q1: the constants hold the deny entry and the two ask entries, in order", () => {
    expect(DENY_ENTRIES).toEqual([CHROME]);
    expect(ASK_ENTRIES).toEqual(["WebFetch", "mcp__*"]);
  });

  it("Q1: generate writes the deny entry and the two ask entries; allow keeps WebSearch", () => {
    const files = buildHarnessFiles(TS_PARAMS);
    const s = JSON.parse(files.find((f) => f.path === ".claude/settings.json")!.content);
    expect(s.permissions.deny).toEqual([CHROME]);
    expect(s.permissions.ask).toEqual(["WebFetch", "mcp__*"]);
    expect(s.permissions.allow).toContain("WebSearch");
    expect(Object.keys(s.permissions)).toEqual(["allow", "deny", "ask"]);
  });

  it("Q1: the manifest records the generated deny and ask entries next to generatedAllow", () => {
    const m = JSON.parse(buildHarnessFiles(TS_PARAMS).find((f) => f.path === ".claude/.harness.json")!.content);
    expect(m.generatedDeny).toEqual([CHROME]);
    expect(m.generatedAsk).toEqual(["WebFetch", "mcp__*"]);
    const keys = Object.keys(m);
    expect(keys.indexOf("generatedDeny")).toBe(keys.indexOf("generatedAllow") + 1);
    expect(keys.indexOf("generatedAsk")).toBe(keys.indexOf("generatedAllow") + 2);
  });

  it("Q1: update on an older settings.json adds the three entries and keeps the user's own deny and ask", () => {
    const dir = deployHarness();
    const m = readJson(manifestPath(dir));
    delete m.generatedDeny; // as an older version wrote it
    delete m.generatedAsk;
    writeJson(manifestPath(dir), m);
    const s = readJson(settingsPath(dir));
    s.permissions.deny = ["Bash(rm -rf:*)"];
    s.permissions.ask = ["Bash(curl:*)"];
    writeJson(settingsPath(dir), s);

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    const next = planned(plan, ".claude/settings.json");
    expect(next.permissions.deny).toEqual([CHROME, "Bash(rm -rf:*)"]);
    expect(next.permissions.ask).toEqual(["WebFetch", "mcp__*", "Bash(curl:*)"]);
    expect(plan.permissionLines).toEqual([]);
    const nextManifest = planned(plan, ".claude/.harness.json");
    expect(nextManifest.generatedDeny).toEqual([CHROME]);
    expect(nextManifest.generatedAsk).toEqual(["WebFetch", "mcp__*"]);
  });

  it("Q1: update on a settings.json without deny and ask keys adds the entries", () => {
    const dir = deployHarness();
    const s = readJson(settingsPath(dir));
    delete s.permissions.deny;
    delete s.permissions.ask;
    writeJson(settingsPath(dir), s);
    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    const next = planned(plan, ".claude/settings.json");
    expect(next.permissions.deny).toEqual([CHROME]);
    expect(next.permissions.ask).toEqual(["WebFetch", "mcp__*"]);
    expect(plan.permissionLines).toEqual([]);
  });

  it("Q1: update keeps a removed entry removed and warns once per removed entry, on every run", () => {
    const dir = deployHarness();
    const s = readJson(settingsPath(dir));
    s.permissions.deny = ["Bash(rm -rf:*)"]; // the Chrome entry removed, the user's own added
    s.permissions.ask = ["mcp__*"]; // WebFetch removed
    writeJson(settingsPath(dir), s);

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.permissionLines).toEqual([WARN_CHROME, WARN_FETCH]);
    const next = planned(plan, ".claude/settings.json") ?? readJson(settingsPath(dir));
    expect(next.permissions.deny).toEqual(["Bash(rm -rf:*)"]);
    expect(next.permissions.ask).toEqual(["mcp__*"]);
    apply(dir, plan);

    const again = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(again.permissionLines).toEqual([WARN_CHROME, WARN_FETCH]);
    expect(again.toWrite).toEqual([]);
    const disk = readJson(settingsPath(dir));
    expect(disk.permissions.deny).not.toContain(CHROME);
    expect(disk.permissions.ask).not.toContain("WebFetch");
    expect(readJson(manifestPath(dir)).generatedDeny).toEqual([CHROME]);
  });

  it("Q1: an empty list after removal stays empty and warns for each entry", () => {
    const dir = deployHarness();
    const s = readJson(settingsPath(dir));
    s.permissions.deny = [];
    s.permissions.ask = [];
    writeJson(settingsPath(dir), s);
    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.permissionLines).toEqual([WARN_CHROME, WARN_FETCH, WARN_MCP]);
    const next = planned(plan, ".claude/settings.json") ?? readJson(settingsPath(dir));
    expect(next.permissions.deny).toEqual([]);
    expect(next.permissions.ask).toEqual([]);
  });

  it("Q1: an entry the user did not remove is not warned about", () => {
    const dir = deployHarness();
    const s = readJson(settingsPath(dir));
    s.permissions.ask = ["WebFetch"]; // only mcp__* removed
    s.permissions.deny.push("Bash(rm:*)");
    writeJson(settingsPath(dir), s);
    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.permissionLines).toEqual([WARN_MCP]);
    const next = planned(plan, ".claude/settings.json") ?? readJson(settingsPath(dir));
    expect(next.permissions.deny).toEqual([CHROME, "Bash(rm:*)"]);
    expect(next.permissions.ask).toEqual(["WebFetch"]);
  });

  it("Q1: an untouched harness gets no warning", () => {
    const dir = deployHarness();
    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.permissionLines).toEqual([]);
    expect(plan.toWrite).toEqual([]);
  });
});

describe("Q1: README and CHANGELOG", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");

  it("Q1: Limits says what the harness does for each channel and how to open one", () => {
    const start = readme.indexOf("## Limits — read before trusting it");
    const limits = readme.slice(start, readme.indexOf("\n## ", start + 3));
    for (const word of [CHROME, "WebFetch", "mcp__*", "bypassPermissions", "WebSearch", "guard-file", "headless"]) {
      expect(limits, word).toContain(word);
    }
  });

  it("Q1: CHANGELOG 0.5.4 has an entry for the channels", () => {
    const at = changelog.indexOf("## 0.5.4 — ");
    const section = changelog.slice(at, changelog.indexOf("\n## ", at + 3));
    expect(section).toContain(CHROME);
  });
});
