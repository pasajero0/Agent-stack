/**
 * Spec flow (0.4.6, AC-83): how a human approves a spec. The one list of names; the type comes from it, and
 * gates-lib.sh's copy (spec_flow) is held equal to it by tests/hooks/spec-flow.test.ts.
 * - `merge` (the default, a team): the spec comes on `spec/<stage>`; merging it into the base branch approves it.
 * - `branch` (one person): spec, plan and code stay in the current branch; gate:spec-approve approves it.
 */
import { RunError } from "./errors.js";
import { commandName } from "./engine/command.js";

export const SPEC_FLOWS = ["merge", "branch"] as const;

export type SpecFlow = (typeof SPEC_FLOWS)[number];

export const DEFAULT_SPEC_FLOW: SpecFlow = "merge";

export function isSpecFlow(v: unknown): v is SpecFlow {
  return typeof v === "string" && (SPEC_FLOWS as readonly string[]).includes(v);
}

/** The allowed names for a message: `"merge" or "branch"`. */
export const specFlowNames = (): string => SPEC_FLOWS.map((f) => JSON.stringify(f)).join(" or ");

/**
 * AC-84: a run keeps the flow it started with. Checked on `--resume` and before every step, so a `gates.json`
 * edit while a run is open stops it instead of switching halfway.
 */
export function requireSameFlow(run: { id: string; specFlow: SpecFlow }, now: SpecFlow): void {
  if (run.specFlow === now) return;
  throw new RunError(
    `Run ${run.id} started with specFlow "${run.specFlow}", but gates.json now says "${now}". A run keeps its flow: put "${run.specFlow}" back, or finish the run or cancel it (${commandName()} run --cancel ${run.id}), then change the flow.`,
    1
  );
}
