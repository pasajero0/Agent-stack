// Children of the eval runner and how they stop (AC-14, AC-16). Plain Node ESM, built-ins only.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const DROPPED_ENV = ["AGENT_STACK_GATE_INPUT", "AGENT_STACK_RUN", "AGENT_STACK_EVAL_TTY"];
const DRIVER_GRACE_MS = 10_000;
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/** `current` is the child that runs; `currentDir` the temp copy of the try that runs; `stopSignal` the signal that came. */
export const state = { current: null, currentDir: null, stopSignal: null };

/** The eval runner's env minus the driver's seams and every GIT_* variable, so git never acts on this repo. */
function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!DROPPED_ENV.includes(key) && !key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {
    // The group is gone already.
  }
}

/**
 * Stops a running child as AC-14 says: the driver gets SIGTERM, and SIGKILL to its group if the group is still
 * alive after 10 s; any other child gets SIGKILL to its group. Resolves when the child closed and its group is gone.
 */
function stopChild(c) {
  if (c.stopped === null) {
    c.stopped = new Promise((done) => {
      const pid = c.child.pid;
      let timer = null;
      const finish = () => {
        if (timer !== null) clearTimeout(timer);
        done();
      };
      if (c.kind === "driver") {
        try {
          c.child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
        timer = setTimeout(() => {
          timer = null;
          killGroup(pid, "SIGKILL");
          c.closed.then(finish);
        }, DRIVER_GRACE_MS);
        // The driver closed: done unless something of its group still runs; then the 10 s timer decides.
        c.closed.then(() => {
          if (!groupAlive(pid)) finish();
        });
      } else {
        killGroup(pid, "SIGKILL");
        c.closed.then(finish);
      }
    });
  }
  return c.stopped;
}

/**
 * One child: an argv array, no shell, its own process group, stdin ignored. With `deadline` (ms since epoch) the
 * child is stopped when it passes, and the result has `timedOut` true. After a signal it never resolves: the signal
 * handler exits.
 */
export function runChild(cmd, args, cwd, { kind = "other", deadline = null } = {}) {
  if (state.stopSignal !== null) return new Promise(() => {});
  if (deadline !== null && Date.now() >= deadline) return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: true });
  return new Promise((done) => {
    const r = { code: null, stdout: "", stderr: "", timedOut: false };
    let ended = false;
    let entry = null;
    let timer = null;
    const end = () => {
      if (ended || state.stopSignal !== null) return;
      ended = true;
      if (timer !== null) clearTimeout(timer);
      if (state.current === entry) state.current = null;
      done(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: childEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      r.stderr = String(e);
      end();
      return;
    }
    let closed;
    const closedPromise = new Promise((c) => (closed = c));
    child.stdout.on("data", (d) => (r.stdout += d));
    child.stderr.on("data", (d) => (r.stderr += d));
    child.on("error", (e) => {
      r.stderr += String(e);
      closed();
      if (!r.timedOut) end();
    });
    child.on("close", (code) => {
      r.code = code;
      closed();
      if (!r.timedOut) end();
    });
    if (child.pid === undefined) return;
    entry = { child, kind, closed: closedPromise, stopped: null };
    state.current = entry;
    if (deadline !== null) {
      // setTimeout takes at most 2^31-1 ms.
      timer = setTimeout(() => {
        timer = null;
        if (ended) return;
        r.timedOut = true;
        stopChild(entry).then(end);
      }, Math.min(Math.max(deadline - Date.now(), 0), 2 ** 31 - 1));
    }
  });
}

/** AC-16: stop the child that runs, remove the temp copy of the try that runs (unless `keep`), exit 128 + n. */
export function handleSignals(keep) {
  for (const [sig, num] of Object.entries(SIGNALS)) {
    process.on(sig, () => {
      if (state.stopSignal !== null) return;
      state.stopSignal = sig;
      const c = state.current;
      (c !== null ? stopChild(c) : Promise.resolve()).then(() => {
        if (state.currentDir !== null && !keep) rmSync(state.currentDir, { recursive: true, force: true });
        process.exit(128 + num);
      });
    });
  }
}
