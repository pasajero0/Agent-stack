/**
 * One role call as the engine sees it: the fuse before it (AC-35), the schema re-run (AC-37), infra and
 * abort (AC-36, AC-51), and the endings that are a failed attempt or a role re-run (AC-38). The scout's call
 * is one attempt that never throws a `RunError` (`oneCall`, scout1 AC-10).
 */
import { join } from "node:path";
import { callClaude, type CallCommands, type CallOutcome, type CallSpec, type Model } from "../claude.js";
import { RunError } from "../errors.js";
import { roleSchemas, validateOutput } from "../schemas.js";
import { runDir, writeRun } from "../store.js";
import type { Fuse, Role, RunFile } from "../types.js";
import { Interrupted, resumeHint, type Ctx } from "./context.js";

export type CallTarget = { role: "implement"; commands: CallCommands } | { role: Exclude<Role, "implement"> };

export type RoleResult<T> =
  | { kind: "ok"; value: T }
  /** The fuse is reached: before the call, or the call hit `error_max_budget_usd` (`midCall`, its edits stay). */
  | { kind: "fuse"; midCall: boolean }
  /** max turns, error during execution, or the step timeout: the reason goes to feedback. */
  | { kind: "failed"; message: string };

export function fuseReached(run: RunFile): boolean {
  const f = run.fuse;
  if (f === "off") return false;
  if ("calls" in f) return run.calls >= f.calls;
  return run.costUsd >= f.usd;
}

export function fuseText(f: Fuse): string {
  if (f === "off") return "off";
  return "calls" in f ? `calls ${f.calls}` : `usd ${f.usd}`;
}

/** Dollars left for `--max-budget-usd`, only with a dollar fuse. */
function budgetLeft(run: RunFile): number | null {
  const f = run.fuse;
  if (f === "off" || !("usd" in f)) return null;
  return Math.max(0, Math.round((f.usd - run.costUsd) * 10_000) / 10_000);
}

/** Q1: the scout's own caps; it never waits longer, or runs more turns, than the shared limits allow. */
export const SCOUT_TIMEOUT_MIN = 3;
export const SCOUT_MAX_TURNS = 20;

/** The timeout and the turn limit of one call: the scout gets min(shared, its cap); other roles keep the shared limits. */
export function callLimits(cfg: { maxTurns: number; stepTimeoutMin: number }, role: Role): { timeoutMs: number; maxTurns: number } {
  if (role === "scout") {
    return {
      timeoutMs: Math.min(cfg.stepTimeoutMin, SCOUT_TIMEOUT_MIN) * 60_000,
      maxTurns: Math.min(cfg.maxTurns, SCOUT_MAX_TURNS),
    };
  }
  return { timeoutMs: cfg.stepTimeoutMin * 60_000, maxTurns: cfg.maxTurns };
}

function spec(ctx: Ctx, target: CallTarget, model: Model, effort?: string): CallSpec {
  const s = roleSchemas[target.role];
  const base = {
    model,
    maxTurns: callLimits(ctx.cfg, target.role).maxTurns,
    schema: { type: s.type, required: s.required, properties: s.properties },
    budgetUsd: budgetLeft(ctx.run),
  };
  const eff = effort !== undefined ? { effort } : {};
  if (target.role === "implement") return { ...base, role: "implement", commands: target.commands, ...eff };
  // scout1 AC-2: the scout's route has an effort too.
  if (target.role === "scout") return { ...base, role: "scout", ...eff };
  return { ...base, role: target.role };
}

/**
 * One call of `target.role`, or null when the fuse is reached before it (AC-35): the call count and the run file
 * before the call (so the count survives a kill), the head and end lines, and the cost after it (AC-62).
 */
async function callOnce(ctx: Ctx, target: CallTarget, model: Model, prompt: string, effort: string | undefined): Promise<CallOutcome | null> {
  const { run } = ctx;
  const role = target.role;
  if (fuseReached(run)) return null;
  run.calls += 1;
  writeRun(ctx.projectDir, run);
  const limit = run.fuse !== "off" && "calls" in run.fuse ? `/${run.fuse.calls}` : "";
  const head = `-> ${run.next} · ${role} · ${model}${effort !== undefined ? ` · ${effort}` : ""} · call ${run.calls}${limit} ...`;
  ctx.out(head);
  ctx.progress.line(head);
  const started = Date.now();
  const o = await callClaude(spec(ctx, target, model, effort), {
    cwd: ctx.projectDir,
    prompt,
    runId: run.id,
    callsDir: join(runDir(ctx.projectDir, run.id), "calls"),
    callNo: run.calls,
    timeoutMs: callLimits(ctx.cfg, role).timeoutMs,
    env: ctx.env,
    validate: (v) => validateOutput(role, v),
    signal: ctx.signal,
    onTool: (line) => {
      ctx.out(line);
      ctx.progress.line(line);
    },
  });
  // AC-62: an unknown cost is counted apart, never as $0.
  if (o.costUsd === null) run.costUnknownCalls += 1;
  else run.costUsd += o.costUsd;
  const end = `   ${o.kind} in ${Math.round((Date.now() - started) / 1000)}s`;
  ctx.out(end);
  ctx.progress.line(end);
  return o;
}

/** Why a scout call gave no output (scout1 AC-10): its ending, as the no-map line names it. */
export type NoOutputReason = "infra" | "schema" | "max-turns" | "timeout" | "exec-error";

export type OneCallResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "fuse"; midCall: boolean }
  | { kind: "none"; reason: NoOutputReason };

/**
 * The scout's call (scout1 AC-10): one attempt that never throws a `RunError`. Infra, schema (also a parse failure
 * after `ok`), max turns, timeout and exec-error end it with `none` and no second call. The fuse is as in
 * `roleCall`; an abort is `Interrupted` (v04 AC-51). Only a parsed `ok` adds its denials to `humanDecisions`.
 */
export async function oneCall<T>(
  ctx: Ctx,
  target: CallTarget,
  model: Model,
  prompt: string,
  parse: (v: unknown) => T | string,
  effort?: string
): Promise<OneCallResult<T>> {
  const o = await callOnce(ctx, target, model, prompt, effort);
  if (o === null) return { kind: "fuse", midCall: false };
  switch (o.kind) {
    case "aborted":
      throw new Interrupted();
    case "budget":
      return { kind: "fuse", midCall: true };
    case "infra":
    case "schema":
    case "timeout":
    case "exec-error":
      return { kind: "none", reason: o.kind };
    case "turns":
      return { kind: "none", reason: "max-turns" };
    case "ok": {
      const value = parse(o.output);
      if (typeof value === "string") return { kind: "none", reason: "schema" };
      ctx.run.humanDecisions.push(...o.denials);
      return { kind: "ok", value };
    }
  }
}

/**
 * Calls `target.role` with `prompt`. A schema mismatch is re-run once with the same prompt; a second one,
 * and any infrastructure failure, is a `RunError(1)` with `next` kept. Permission denials go to
 * `humanDecisions` (AC-32). The run file is written before each call so the call count survives a kill.
 */
export async function roleCall<T>(
  ctx: Ctx,
  target: CallTarget,
  model: Model,
  prompt: string,
  parse: (v: unknown) => T | string,
  /** implement and scout only: the route's effort, passed as `--effort` and shown in the head line. */
  effort?: string
): Promise<RoleResult<T>> {
  const { run } = ctx;
  const role = target.role;
  let mismatch = "";
  for (let round = 0; round < 2; round++) {
    const o = await callOnce(ctx, target, model, prompt, effort);
    if (o === null) return { kind: "fuse", midCall: false };
    switch (o.kind) {
      case "aborted":
        throw new Interrupted();
      case "infra":
        throw new RunError(
          `The ${role} call failed: ${o.message}. The run stays at ${run.next}; fix the cause, then ${resumeHint(run.id)}.`,
          1
        );
      case "budget":
        return { kind: "fuse", midCall: true };
      case "turns":
      case "exec-error":
      case "timeout":
        return { kind: "failed", message: o.message };
      case "schema":
        mismatch = o.message;
        continue;
      case "ok": {
        const value = parse(o.output);
        if (typeof value === "string") {
          mismatch = value;
          continue;
        }
        ctx.run.humanDecisions.push(...o.denials);
        return { kind: "ok", value };
      }
    }
  }
  throw new RunError(
    `The ${role} output did not match its schema twice (${mismatch}). The run stays at ${run.next}; ${resumeHint(run.id)} tries again.`,
    1
  );
}

/**
 * A judgment role (clarify, spec, plan, review) has no attempts: a turns / error / timeout ending is re-run
 * once with the reason as feedback, then it is a `RunError(1)` (AC-38).
 */
export async function judgeCall<T>(
  ctx: Ctx,
  role: Exclude<Role, "implement">,
  prompt: (feedback: string | null) => string,
  parse: (v: unknown) => T | string
): Promise<Exclude<RoleResult<T>, { kind: "failed" }>> {
  let feedback: string | null = null;
  for (let round = 0; round < 2; round++) {
    const r: RoleResult<T> = await roleCall(ctx, { role }, "opus", prompt(feedback), parse);
    if (r.kind !== "failed") return r;
    feedback = `FROM THE PROGRAM: the previous ${role} call ended early: ${r.message}.`;
  }
  throw new RunError(
    `The ${role} call ended early twice (${feedback ?? ""}). The run stays at ${ctx.run.next}; ${resumeHint(ctx.run.id)} tries again.`,
    1
  );
}
