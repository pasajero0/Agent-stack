/**
 * The engine loop: the handler for `next` returns an event, the table gives the new `next`, the run file is
 * written, repeat. Ends at a gate without input (3), finished or cancelled (0), or a `RunError` (its code).
 */
import { RunError } from "../errors.js";
import { releaseLock, writeRun } from "../store.js";
import { Interrupted, resumeHint, type Ctx, type StepHandler } from "./context.js";
import { acceptGate, cancelledText, finishedText, limitGate } from "./gates.js";
import { commonHandlers } from "./steps-common.js";
import { parseNext, transition, type StepKind } from "./transitions.js";

export type ExitCode = 0 | 1 | 3;

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
      const event = await handler(ctx, task);
      if (event.type === "no-input") {
        run.status = "waiting";
        writeRun(ctx.projectDir, run);
        ctx.out(`Waiting at ${run.next}; no answer was given. Answer it with: ${resumeHint(run.id)}`);
        return 3;
      }
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
      ctx.out(`Interrupted at ${run.next}; the run is kept. Continue with: ${resumeHint(run.id)}`);
      return 1;
    }
    if (e instanceof RunError) {
      ctx.out(e.message);
      return e.exitCode;
    }
    throw e;
  }
}
