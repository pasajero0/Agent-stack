import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyReport } from "../../src/usage/collect.js";
import { saveSnapshot, snapshotPath, type UsageSnapshot } from "../../src/usage/snapshot.js";

describe("usage snapshots", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-stack-snapshot-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const snap = (savedAt: string, files: number): UsageSnapshot => ({
    savedAt,
    toolVersion: "0.0.0",
    days: 7,
    files,
    report: { ...emptyReport(), mainSessions: files },
    neverActed: { hooks: ["arch-guard"], bin: [], agents: [], skills: [], commands: [] },
  });

  it("names the file after the UTC date", () => {
    expect(snapshotPath("/p", new Date("2026-11-16T23:30:00Z"))).toBe("/p/.claude/tmp/usage/2026-11-16.json");
  });

  it("writes the snapshot under .claude/tmp/usage, creating the folder", () => {
    const path = saveSnapshot(dir, snap("2026-11-16T10:00:00Z", 3));
    expect(path).toBe(join(dir, ".claude/tmp/usage/2026-11-16.json"));
    const back = JSON.parse(readFileSync(path, "utf-8")) as UsageSnapshot;
    expect(back.report.mainSessions).toBe(3);
    expect(back.neverActed.hooks).toEqual(["arch-guard"]);
  });

  it("replaces a snapshot saved earlier the same day", () => {
    saveSnapshot(dir, snap("2026-11-16T08:00:00Z", 1));
    const path = saveSnapshot(dir, snap("2026-11-16T20:00:00Z", 5));
    expect((JSON.parse(readFileSync(path, "utf-8")) as UsageSnapshot).files).toBe(5);
  });
});
