/**
 * The stage's `tasks.json` and spec as the driver reads them. Spec: docs/specs/v04/SPEC.md, Terms "Valid plan",
 * "Criterion text", "Risk words"; AC-12, AC-13, AC-45.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isObj } from "../config.js";
import { RunError } from "../errors.js";
import { criterionText } from "../prompts.js";
import type { RunConfig } from "../types.js";
import type { Tier } from "./context.js";

export interface PlanTask {
  id: string;
  ac: string[];
  tier: Tier;
  desc: string;
  verify: string;
}

export const stageTmp = (stage: string): string => `.claude/tmp/${stage}`;
export const tasksPath = (dir: string, stage: string): string => join(dir, stageTmp(stage), "tasks.json");
export const specPath = (cfg: RunConfig, stage: string): string => `${cfg.specsDir}/${stage}/SPEC.md`;

const TIERS: readonly Tier[] = ["S", "M", "L"];

const nonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Criterion ids of a spec: every `- **AC-n:**` line, in order. */
export function specAcIds(specMd: string): string[] {
  const ids: string[] = [];
  for (const m of specMd.matchAll(/^\s*[-*]\s*\*\*(AC-\d+):\*\*/gm)) {
    const id = m[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** One task of the plan, or why it is not valid. */
function parseTask(v: unknown, i: number, seen: Set<string>): PlanTask | string {
  const at = `tasks[${i}]`;
  if (!isObj(v)) return `${at} is not an object`;
  if (!nonEmptyStr(v.id)) return `${at} has no id`;
  const id = v.id;
  // The id goes into `.claude/bin/verify <id>` as one shell word.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return `task id ${JSON.stringify(id)} may hold only letters, digits, ".", "_" and "-"`;
  if (id === "Q1" || /^F\d+$/.test(id)) return `task id ${id} is reserved (Q1 and F<number> are the driver's)`;
  if (seen.has(id)) return `task id ${id} is used twice`;
  seen.add(id);
  if (!Array.isArray(v.ac) || v.ac.length === 0 || !v.ac.every(nonEmptyStr)) return `task ${id} needs a non-empty ac array`;
  const tier = TIERS.find((t) => t === v.tier);
  if (tier === undefined) return `task ${id} needs a tier of S, M or L`;
  if (!nonEmptyStr(v.verify)) return `task ${id} needs a non-empty verify`;
  if (v.passes !== false) return `task ${id} must have passes: false`;
  return { id, ac: v.ac, tier, desc: typeof v.desc === "string" ? v.desc : "", verify: v.verify };
}

/**
 * The valid plan in `text` against the spec's criteria, or why it is not one. With `fresh` false the `passes`
 * flags verify has written since are accepted.
 */
export function parsePlan(text: string, specMd: string, fresh = true): PlanTask[] | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return `tasks.json is not JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!isObj(raw) || !Array.isArray(raw.tasks) || raw.tasks.length === 0) return "tasks.json needs a non-empty tasks array";
  const seen = new Set<string>();
  const tasks: PlanTask[] = [];
  for (const [i, v] of raw.tasks.entries()) {
    const t = parseTask(fresh || !isObj(v) ? v : { ...v, passes: false }, i, seen);
    if (typeof t === "string") return t;
    tasks.push(t);
  }
  const covered = new Set(tasks.flatMap((t) => t.ac));
  const missing = specAcIds(specMd).filter((id) => !covered.has(id));
  if (missing.length > 0) return `no task covers ${missing.join(", ")} of the spec`;
  return tasks;
}

export function readSpec(dir: string, cfg: RunConfig, stage: string): string {
  const file = join(dir, specPath(cfg, stage));
  if (!existsSync(file)) throw new RunError(`The spec ${specPath(cfg, stage)} is missing on this branch; the plan cannot be read.`, 1);
  return readFileSync(file, "utf8");
}

/** The approved plan as it is on disk now (verify may have set `passes`); a broken one is exit 1. */
export function readPlan(dir: string, cfg: RunConfig, stage: string): PlanTask[] {
  const file = tasksPath(dir, stage);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const r = text === "" ? "tasks.json is missing" : parsePlan(text, readSpec(dir, cfg, stage), false);
  if (typeof r === "string") throw new RunError(`${stageTmp(stage)}/tasks.json is no longer a valid plan: ${r}. Restore it, or cancel the run.`, 1);
  return r;
}

/** The sha256 of a tasks.json text, kept in a plan-approve reject (AC-14). */
export const planSha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Removes the stage's tasks.json and verify.log (AC-14, AC-45). */
export function deletePlan(dir: string, stage: string): void {
  rmSync(tasksPath(dir, stage), { force: true });
  rmSync(join(dir, stageTmp(stage), "verify.log"), { force: true });
}

/** The criterion texts of a task's ids in the spec; an id the spec lacks is kept as itself. */
export function criteriaOf(specMd: string, ac: string[]): string[] {
  return ac.map((id) => criterionText(specMd, id) || id);
}
