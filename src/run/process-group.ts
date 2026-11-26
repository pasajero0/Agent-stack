/**
 * Defect 49: SIGKILL to the process group that a detached child leads, so what it started (test runners,
 * servers) dies with it. runCheck and callClaude call it on a timeout, on an abort, and when the child has
 * ended in any way.
 *
 * A group with no member left gives ESRCH, which is ignored. A missing pid, pid 0 or 1, and the driver's own
 * pid are never signalled as a group; `killChild` (if given) runs instead. Another error also runs `killChild`.
 *
 * Not covered: a process that left the group (its own session, for example a daemon or a tool that calls
 * setsid) is not reached.
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
