/**
 * One role call as the engine sees it: the fuse before it (AC-35), the schema re-run (AC-37), infra and
 * abort (AC-36, AC-51), and the endings that are a failed attempt or a role re-run (AC-38).
 */
import { join } from "node:path";
import { callClaude, type CallCommands, type CallSpec, type Model } from "../claude.js";
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

function spec(ctx: Ctx, target: CallTarget, model: Model): CallSpec {
  const s = roleSchemas[target.role];
  const base = {
    model,
    maxTurns: ctx.cfg.maxTurns,
    schema: { type: s.type, required: s.required, properties: s.properties },
    budgetUsd: budgetLeft(ctx.run),
  };
  return target.role === "implement"
    ? { ...base, role: "implement", commands: target.commands }
    : { ...base, role: target.role };
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
  parse: (v: unknown) => T | string
): Promise<RoleResult<T>> {
  const { run } = ctx;
  const role = target.role;
  let mismatch = "";
  for (let round = 0; round < 2; round++) {
    if (fuseReached(run)) return { kind: "fuse", midCall: false };
    run.calls += 1;
    writeRun(ctx.projectDir, run);
    const limit = run.fuse !== "off" && "calls" in run.fuse ? `/${run.fuse.calls}` : "";
    ctx.out(`-> ${run.next} · ${role} · ${model} · call ${run.calls}${limit} ...`);
    const started = Date.now();
    const o = await callClaude(spec(ctx, target, model), {
      cwd: ctx.projectDir,
      prompt,
      runId: run.id,
      callsDir: join(runDir(ctx.projectDir, run.id), "calls"),
      callNo: run.calls,
      timeoutMs: ctx.cfg.stepTimeoutMin * 60_000,
      env: ctx.env,
      validate: (v) => validateOutput(role, v),
      signal: ctx.signal,
    });
    // AC-62: an unknown cost is counted apart, never as $0.
    if (o.costUsd === null) run.costUnknownCalls += 1;
    else run.costUsd += o.costUsd;
    ctx.out(`   ${o.kind} in ${Math.round((Date.now() - started) / 1000)}s`);
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
