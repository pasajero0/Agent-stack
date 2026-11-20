/**
 * The engine loop: the handler for `next` returns an event, the table gives the new `next`, the run file is
 * written, repeat. Ends at a gate without input (3), finished or cancelled (0), or a `RunError` (its code).
 */
import { RunError } from "../errors.js";
import { nonePrompter } from "../gate.js";
import { releaseLock, writeRun } from "../store.js";
import type { RunFile } from "../types.js";
import { GateChanged } from "./card.js";
import { cancelHint, Interrupted, resumeHint, type Ctx, type StepHandler } from "./context.js";
import { acceptGate, cancelledText, finishedText, limitGate } from "./gates.js";
import { commonHandlers } from "./steps-common.js";
import { parseNext, transition, type StepKind } from "./transitions.js";

export type ExitCode = 0 | 1 | 3;

/** Puts the run back as it was before the gate: under `--answer` a refused gate applies nothing (AC-70). */
function restore(run: RunFile, snap: RunFile): void {
  for (const k of Object.keys(run)) delete (run as unknown as Record<string, unknown>)[k];
  Object.assign(run, snap);
}

export async function runLoop(ctx: Ctx): Promise<ExitCode> {
  const handlers: Partial<Record<StepKind, StepHandler>> = {
    ...commonHandlers,
    "gate:accept": acceptGate,
    "gate:limit": limitGate,
    ...ctx.mode.handlers,
  };
  const { run } = ctx;
  try {
    for (;;) {
      if (ctx.signal.aborted) throw new Interrupted();
      const { kind, task } = parseNext(run.next);
      const handler = handlers[kind];
      if (!handler) throw new RunError(`Step ${kind} is not built for ${run.mode} mode.`, 1);
      const gate = kind.startsWith("gate:");
      // AC-70: the gate that reads `--answer` either decides with all of them, or applies nothing.
      const snap = gate && ctx.answering ? structuredClone(run) : null;
      let event;
      try {
        event = await handler(ctx, task);
      } catch (e) {
        if (snap !== null && e instanceof RunError) {
          // A changed gate keeps its new card, so --status shows what to read again (AC-68).
          const card = e instanceof GateChanged ? run.card : snap.card;
          restore(run, snap);
          run.card = card;
          run.status = "waiting";
        }
        throw e;
      }
      if (event.type === "no-input") {
        run.status = "waiting";
        if (snap !== null) {
          // AC-70: the answers ran out before the gate decided; nothing of it is applied.
          restore(run, snap);
          run.status = "waiting";
          writeRun(ctx.projectDir, run);
          ctx.out(`Waiting at ${run.next}: the answers ran out before the gate decided, so nothing was applied. Give every answer it takes: ${resumeHint(run.id)} --answer …`);
          return 3;
        }
        writeRun(ctx.projectDir, run);
        ctx.out(`Waiting at ${run.next}; no answer was given. Answer it with: ${resumeHint(run.id)}`);
        return 3;
      }
      if (snap !== null) {
        // The answers reach only this gate; the next one waits for the human again.
        ctx.prompter = nonePrompter;
        ctx.answering = false;
      }
      if (gate) run.card = null;
      const t = transition(run.next, event, run.returnTo);
      if (kind === "gate:limit") {
        run.returnTo = null;
        run.limitReason = null;
      }
      run.next = t.next;
      run.status = t.status;
      writeRun(ctx.projectDir, run);
      if (t.status === "finished" || t.status === "cancelled") {
        releaseLock(ctx.projectDir);
        ctx.out(t.status === "finished" ? finishedText(run) : cancelledText(ctx.projectDir, run));
        return 0;
      }
    }
  } catch (e) {
    writeRun(ctx.projectDir, run);
    if (e instanceof Interrupted) {
      // AC-74: the lock stays with the run, so a new run is refused until this one goes on or is cancelled.
      ctx.out(`Interrupted at ${run.next}. The run is kept and holds the lock: no other run starts in this repo until it goes on or is cancelled.`);
      ctx.out(`  continue: ${resumeHint(run.id)}`);
      ctx.out(`  cancel:   ${cancelHint(run.id)}`);
      return 1;
    }
    if (e instanceof RunError) {
      ctx.out(e.message);
      return e.exitCode;
    }
    throw e;
  }
}
