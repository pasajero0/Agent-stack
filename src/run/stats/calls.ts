/** Per-run call outcomes for `run --stats` (spec stats1, AC-5, AC-10, AC-15, AC-19). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../claude.js";
import { validateOutput } from "../schemas.js";
import type { Role, RunFile } from "../types.js";

export type CallKind = "ok" | "schema" | "max-turns" | "exec-error" | "budget" | "infra" | "killed" | "unreadable";

/** The outcome order everywhere (AC-5). */
export const CALL_KINDS: readonly CallKind[] = ["ok", "schema", "max-turns", "exec-error", "budget", "infra", "killed", "unreadable"];
export const CALL_ROLES: readonly Role[] = ["clarify", "spec", "plan", "implement", "review"];

export interface RoleCalls {
  calls: number;
  outcomes: Record<CallKind, number>;
  denials: number;
}

export interface RunCalls {
  roles: Record<Role, RoleCalls>;
  /** Call numbers from 1 to `calls` with no call file. */
  missing: number;
  warnings: string[];
}

const emptyRole = (): RoleCalls => ({
  calls: 0,
  outcomes: { ok: 0, schema: 0, "max-turns": 0, "exec-error": 0, budget: 0, infra: 0, killed: 0, unreadable: 0 },
  denials: 0,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const NAME = /^(0|[1-9][0-9]*)-(clarify|spec|plan|implement|review)\.json$/;

type Read = { kind: CallKind; denials: number } | { why: string };

function readCall(path: string, role: Role): Read {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { why: "cannot read" };
  }
  let rec: unknown;
  try {
    rec = JSON.parse(text);
  } catch {
    return { why: "not JSON" };
  }
  if (!isRecord(rec)) return { why: "not an object" };
  if (!("result" in rec)) return { why: "no result key" };
  const result = rec["result"];
  if (typeof result === "string") {
    const code = rec["exitCode"];
    if (code === null) return { kind: "killed", denials: 0 };
    if (typeof code === "number" && Number.isInteger(code)) return { kind: "infra", denials: 0 };
    return { why: "bad exitCode" };
  }
  if (!isRecord(result)) return { why: "bad result" };
  const out = classify(result, (v) => validateOutput(role, v));
  const raw = result["permission_denials"];
  const denials = Array.isArray(raw) ? raw.length : 0;
  let kind: CallKind;
  switch (out.kind) {
    case "ok":
    case "schema":
    case "exec-error":
    case "budget":
      kind = out.kind;
      break;
    case "turns":
      kind = "max-turns";
      break;
    default:
      kind = "infra";
  }
  return { kind, denials };
}

/** Reads `<runDir>/calls/`. `live`: the run's process is alive, so call number `calls` may be in progress. */
export function readCalls(runDir: string, run: RunFile, live: boolean): RunCalls {
  const roles: Record<Role, RoleCalls> = {
    clarify: emptyRole(),
    spec: emptyRole(),
    plan: emptyRole(),
    implement: emptyRole(),
    review: emptyRole(),
  };
  const warnings: string[] = [];
  const total = run.calls;
  const out: RunCalls = { roles, missing: 0, warnings };
  const dir = join(runDir, "calls");

  let entries: { name: string; dir: boolean }[] = [];
  if (existsSync(dir)) {
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
    } catch {
      out.missing = total;
      warnings.push(`${run.id}: calls/ cannot be listed`);
      return out;
    }
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const seen = new Map<number, number>();
  for (const e of entries) {
    const m = e.dir ? null : NAME.exec(e.name);
    if (!m) {
      warnings.push(`${run.id}: calls/${e.name} is not a call file`);
      continue;
    }
    const n = Number(m[1]);
    const role = m[2] as Role; // NAME admits only the five roles
    if (n < 1 || n > total) {
      if (!(live && n > total)) warnings.push(`${run.id}: calls/${e.name} is outside 1..${total}`);
      continue;
    }
    seen.set(n, (seen.get(n) ?? 0) + 1);
    const r = readCall(join(dir, e.name), role);
    if ("why" in r) {
      if (live && n >= total) continue;
      roles[role].calls++;
      roles[role].outcomes.unreadable++;
      warnings.push(`${run.id}: calls/${e.name} is unreadable: ${r.why}`);
      continue;
    }
    roles[role].calls++;
    roles[role].outcomes[r.kind]++;
    roles[role].denials += r.denials;
  }
  for (const [n, c] of seen) if (c > 1) warnings.push(`${run.id}: calls/${n}-*.json: more than one file`);
  for (let n = 1; n <= total; n++) {
    if (seen.has(n)) continue;
    if (live && n === total) continue;
    out.missing++;
    warnings.push(`${run.id}: calls/${n}-*.json is missing`);
  }
  return out;
}
