import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UsageReport } from "./collect.js";
import type { Inventory } from "./inventory.js";

/**
 * A saved usage summary: counts and harness part names only, never conversation text, so it can be
 * kept long after Claude Code deletes the logs it came from. Compare snapshots taken with the same
 * `--days` window; two windows that overlap count the same events twice.
 */
export interface UsageSnapshot {
  savedAt: string;
  toolVersion: string;
  days: number | null;
  files: number;
  report: UsageReport;
  neverActed: Inventory;
}

/** `.claude/tmp/usage/<YYYY-MM-DD>.json` — one per day; a second save that day replaces the first. */
export function snapshotPath(projectDir: string, at: Date): string {
  return join(projectDir, ".claude", "tmp", "usage", `${at.toISOString().slice(0, 10)}.json`);
}

export function saveSnapshot(projectDir: string, snap: UsageSnapshot): string {
  const path = snapshotPath(projectDir, new Date(snap.savedAt));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snap, null, 2) + "\n", "utf-8");
  return path;
}
