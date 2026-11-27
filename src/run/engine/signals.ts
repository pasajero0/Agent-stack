import { killLiveGroups } from "../process-group.js";

/** The signals that end a run: SIGHUP (the terminal closed) ends it the same way SIGTERM does. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * SIGINT/SIGTERM/SIGHUP abort the returned signal: the current call is killed, the run file written, exit 1
 * (AC-51). A second signal exits at once. Defect 49: every signal, an uncaught exception or unhandled rejection,
 * and process 'exit' also kill the live child groups (`killLiveGroups`), so no check or call outlives the driver.
 */
export function abortOnSignals(): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const on = (): void => {
    if (ac.signal.aborted) process.exit(1);
    ac.abort();
    killLiveGroups();
  };
  // Synchronous; 'uncaughtExceptionMonitor' also sees an unhandled rejection and keeps Node's own exit and message.
  const onEnd = (): void => killLiveGroups();
  for (const s of SIGNALS) process.on(s, on);
  process.on("uncaughtExceptionMonitor", onEnd);
  process.on("exit", onEnd);
  return {
    signal: ac.signal,
    dispose: () => {
      for (const s of SIGNALS) process.off(s, on);
      process.off("uncaughtExceptionMonitor", onEnd);
      process.off("exit", onEnd);
    },
  };
}
