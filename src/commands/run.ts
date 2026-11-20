/** `agent-stack run`: thin wiring over src/run/engine. Exit codes 0 / 3 / 1 (docs/specs/v04/SPEC.md, "CLI"). */
import {
  abortOnSignals,
  cancelRun,
  resumeRun,
  startRun,
  statusRun,
  type ExitCode,
} from "../run/engine/index.js";
import { commandName } from "../run/engine/command.js";

export interface RunOptions {
  /** `true` for the flag alone, a run id when one is given. */
  resume?: string | boolean;
  status?: string | boolean;
  cancel?: string | boolean;
  stage?: string;
  /** `--answer`, repeatable: the input of the gate the run waits at (AC-70). */
  answer?: string[];
  /** `--json` with `--status` (AC-69). */
  json?: boolean;
}

export interface RunIo {
  projectDir?: string;
  out?: (line: string) => void;
}

const given = (v: string | boolean | undefined): boolean => v !== undefined && v !== false;
const idOf = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

async function withSignals(fn: (signal: AbortSignal) => Promise<ExitCode>): Promise<ExitCode> {
  const s = abortOnSignals();
  try {
    return await fn(s.signal);
  } finally {
    s.dispose();
  }
}

export async function runCommand(
  mode: string | undefined,
  description: string | undefined,
  options: RunOptions,
  io: RunIo = {}
): Promise<ExitCode> {
  const projectDir = io.projectDir ?? process.cwd();
  const out = io.out ?? ((line: string) => console.log(line));
  const base = { projectDir, out };
  const actions = [options.resume, options.status, options.cancel].filter(given).length;
  if (actions > 1) {
    out("Use one of --resume, --status or --cancel.");
    return 1;
  }
  if (actions === 1 && mode !== undefined) {
    out(`--resume, --status and --cancel take a run id, not a mode ("${mode}").`);
    return 1;
  }
  const answers = options.answer ?? [];
  if (answers.length > 0 && !given(options.resume)) {
    out("--answer needs --resume: it answers the gate a waiting run stops at.");
    return 1;
  }
  if (options.json === true && !given(options.status)) {
    out("--json goes with --status.");
    return 1;
  }
  if (given(options.status)) return statusRun({ ...base, id: idOf(options.status), json: options.json === true });
  if (given(options.cancel)) return cancelRun({ ...base, id: idOf(options.cancel) });
  if (given(options.resume)) return withSignals((signal) => resumeRun({ ...base, signal, id: idOf(options.resume), ...(answers.length > 0 ? { answers } : {}) }));
  if (mode === undefined) {
    out(`Say what to run: ${commandName()} run quick "<description>" or run task "<description>"; or --resume, --status, --cancel.`);
    return 1;
  }
  if (mode !== "quick" && mode !== "task") {
    out(`Unknown mode "${mode}": use quick or task.`);
    return 1;
  }
  if (options.stage !== undefined && mode !== "task") {
    out("--stage applies to run task only.");
    return 1;
  }
  return withSignals((signal) =>
    startRun({ ...base, signal, mode, description: description ?? "", ...(options.stage ? { stage: options.stage } : {}) })
  );
}

/** Commander action: runs and exits with the engine's code. */
export async function runAction(mode: string | undefined, description: string | undefined, options: RunOptions): Promise<void> {
  process.exit(await runCommand(mode, description, options));
}
