/**
 * Defect 49: SIGKILL to the process group that a detached child leads, so what it started (test runners,
 * servers) dies with it. runCheck and callClaude kill the group on a timeout, on an abort, and once when the
 * child has ended in any way (`trackGroup`).
 *
 * The driver keeps the set of live child groups: `trackGroup` adds a group when runCheck or callClaude spawns its
 * child and removes it when that child has ended. `killLiveGroups` kills every group in the set; the driver calls
 * it on SIGHUP, SIGINT and SIGTERM, on an uncaught exception or unhandled rejection, and on process 'exit'
 * (`abortOnSignals` in engine/signals.ts). Child pids are kept in memory only, never in the run file.
 *
 * A group with no member left gives ESRCH, which is ignored. A missing pid, pid 0 or 1, and the driver's own
 * pid are never signalled as a group; `killChild` (if given) runs instead. Another error also runs `killChild`.
 * A group number is signalled after its child has ended only once: once the group is empty, the number can
 * belong to a new, unrelated group. While the child is in the set it is not reaped yet, so its number is safe.
 *
 * Not covered: a driver killed with SIGKILL cannot clean up, so its children stay; a process that left the group
 * (its own session, for example a daemon or a tool that calls setsid) is not reached.
 */
export function killGroup(pid: number | undefined, killChild?: () => void): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    killChild?.();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ESRCH") return;
    killChild?.();
  }
}

/** Groups of children that runCheck and callClaude spawned and that have not ended yet. */
const live = new Set<number>();

/** The live child groups, for tests. */
export function liveGroups(): number[] {
  return [...live];
}

/** SIGKILL to every live child group; synchronous, so a process 'exit' handler can call it. */
export function killLiveGroups(): void {
  for (const pid of live) killGroup(pid);
}

export interface TrackedGroup {
  /** Timeout or abort: kill the group while the child runs; nothing once the child has ended. */
  kill: (killChild: () => void) => void;
  /** The child has ended (exit, error, finish): remove it from the set and kill what is left, at most once. */
  end: () => void;
}

/** Adds the group of a just-spawned detached child to the live set. */
export function trackGroup(pid: number | undefined): TrackedGroup {
  let ended = false;
  if (pid !== undefined) live.add(pid);
  return {
    kill: (killChild) => {
      if (!ended) killGroup(pid, killChild);
    },
    end: () => {
      if (ended) return;
      ended = true;
      if (pid !== undefined) live.delete(pid);
      killGroup(pid);
    },
  };
}
