/**
 * Spec flow branch: has the approved spec changed? (AC-88). Apart from steps-spec.ts so that implement and the
 * gates can ask without importing the spec step.
 */
import { RunError } from "../errors.js";
import { git } from "../git.js";
import { resumeHint } from "./context.js";
import type { Ctx } from "./context.js";
import { specPath } from "./plan-file.js";
import type { StepEvent } from "./transitions.js";

/** The git blob id of a file at HEAD, or null when HEAD has none. */
export function specBlob(dir: string, file: string): string | null {
  const r = git(dir, ["rev-parse", "--verify", "--quiet", `HEAD:${file}`]);
  return r.ok ? r.stdout.trim() : null;
}

/**
 * True when spec flow is branch, the spec was approved, and the spec now differs from that approval — committed
 * or not. Quick runs and merge-flow runs never change here.
 */
export function specChanged(ctx: Ctx): boolean {
  const { run } = ctx;
  if (run.mode !== "task" || run.specFlow !== "branch" || run.specApproved === null || run.stage === null) return false;
  const file = specPath(ctx.cfg, run.stage);
  return specBlob(ctx.projectDir, file) !== run.specApproved || !git(ctx.projectDir, ["diff", "--quiet", "HEAD", "--", file]).ok;
}

/** A blob's text, or "" when it cannot be read. */
const blobText = (dir: string, blob: string): string => {
  const r = git(dir, ["cat-file", "-p", blob]);
  return r.ok ? r.stdout : "";
};

/**
 * The lines of a `## <name>` section, up to the next `## ` heading. The heading matches by its start, as
 * gates-lib.sh changes_section does (`/^## Changes/`), so the driver and spec-gate read the same section.
 */
export function section(md: string, name: string): string[] {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`## ${name}`));
  if (i < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (/^## /.test(l)) break;
    out.push(l);
  }
  return out;
}

/** AC-88: a changed spec is approved again only when committed with a new `## Changes` entry. */
export function requireRecordedChange(ctx: Ctx, file: string, approved: string): void {
  const dir = ctx.projectDir;
  const how = `Commit the spec change with an entry under ## Changes (what changed, which AC, why) first, then ${resumeHint(ctx.run.id)}.`;
  if (!git(dir, ["diff", "--quiet", "HEAD", "--", file]).ok) throw new RunError(`${file} has uncommitted changes. ${how}`, 1);
  const now = specBlob(dir, file);
  if (now === null) throw new RunError(`${file} is not on HEAD any more. Restore it, then ${resumeHint(ctx.run.id)}.`, 1);
  if (section(blobText(dir, approved), "Changes").join("\n") === section(blobText(dir, now), "Changes").join("\n")) {
    throw new RunError(`${file} changed since its approval, but its ## Changes section does not say what changed. ${how}`, 1);
  }
}

/**
 * Back to gate:spec-approve, then to the step or gate that found the change. A change that is not committed with
 * a new `## Changes` entry is refused here, so `next` stays where it was (AC-88).
 */
export function toSpecApprove(ctx: Ctx): StepEvent {
  if (ctx.run.stage !== null && ctx.run.specApproved !== null) requireRecordedChange(ctx, specPath(ctx.cfg, ctx.run.stage), ctx.run.specApproved);
  ctx.run.returnTo = ctx.run.next;
  ctx.out(`The spec changed since its approval; approve it again before ${ctx.run.next}.`);
  return { type: "spec-changed" };
}
