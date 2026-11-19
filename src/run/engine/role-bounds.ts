/**
 * Bounds of the spec and plan roles: the branch, no commit, only allowed paths. Spec: docs/specs/v04/SPEC.md,
 * AC-12, AC-40, AC-49. Undoing means: back to the branch, reset to the commit before the role, and restore or
 * remove the out-of-bounds paths.
 */
import { RunError } from "../errors.js";
import { currentBranch, dirtyPaths, git, headSha, restorePaths, softReset } from "../git.js";
import { resumeHint, type Ctx } from "./context.js";

/** Where the role started: HEAD and the branch. */
export interface RoleMark {
  head: string;
  branch: string;
}

export const under = (path: string, dir: string): boolean => {
  const d = dir.replace(/\/+$/, "");
  return path === d || path.startsWith(`${d}/`);
};

/** AC-49: refuses with code 1 and lists the changes outside `.claude/tmp/` that `allowed` does not cover. */
export function requireClean(dir: string, when: string, allowed: (path: string) => boolean = () => false): void {
  const dirty = dirtyPaths(dir).filter((p) => !allowed(p));
  if (dirty.length === 0) return;
  throw new RunError(`The tree is not clean ${when}. Commit or stash these changes first:\n${dirty.map((p) => `  ${p}`).join("\n")}`, 1);
}

/**
 * Undoes a branch switch and a commit by the role (the edits stay): back to `mark.branch`, soft reset to
 * `mark.head`. Returns what it undid, as feedback for the role. Also used alone after a mid-call fuse.
 */
export function undoGit(ctx: Ctx, mark: RoleMark): string[] {
  const dir = ctx.projectDir;
  const problems: string[] = [];
  const branch = currentBranch(dir);
  if (branch !== mark.branch) {
    problems.push(`you switched to ${branch ?? "a detached HEAD"}; stay on ${mark.branch} and do not branch`);
    const r = git(dir, ["checkout", "-q", mark.branch]);
    if (!r.ok) {
      throw new RunError(
        `The role left ${mark.branch} for ${branch ?? "a detached HEAD"}, and the program cannot return without losing edits: ${(r.stderr || r.stdout).trim()}. Return to ${mark.branch} by hand, then ${resumeHint(ctx.run.id)}.`,
        1
      );
    }
  }
  if (headSha(dir) !== mark.head) {
    problems.push("you made a commit; do not commit, the program commits");
    softReset(dir, mark.head);
    // A `git add -A` by the role may have staged the run folder; the driver never stages .claude/tmp/.
    git(dir, ["reset", "-q", "--", ".claude/tmp"]);
  }
  return problems;
}

/**
 * Checks what the role did against `mark`. A branch switch and a commit are undone at once (the edits stay),
 * so the out-of-bounds paths can be read on the run's branch. Returns the violations and those paths.
 */
export function checkRole(ctx: Ctx, mark: RoleMark, inBounds: (path: string) => boolean): { problems: string[]; outside: string[] } {
  const problems = undoGit(ctx, mark);
  const outside = dirtyPaths(ctx.projectDir).filter((p) => !inBounds(p));
  if (outside.length > 0) problems.push(`you changed paths outside your bounds: ${outside.join(", ")}`);
  return { problems, outside };
}

/**
 * Runs a spec or plan role call. A call that ends without reaching `checkRole` (a throw: infra, schema or
 * early ending twice, SIGINT) still has its commit and branch switch undone, keeping the edits; an undo that
 * fails is printed and the call's own error is kept.
 */
export async function guardRole<T>(ctx: Ctx, mark: RoleMark, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    try {
      undoGit(ctx, mark);
    } catch (u) {
      ctx.out(u instanceof Error ? u.message : String(u));
    }
    throw e;
  }
}

/** AC-52: the role starts only on the run's branch, so the undo after it cannot move another branch. */
export function requireBranch(ctx: Ctx, branch: string): void {
  const cur = currentBranch(ctx.projectDir);
  if (cur === branch) return;
  throw new RunError(`Run ${ctx.run.id} works on branch ${branch}, but ${cur ?? "a detached HEAD"} is checked out. Run git switch ${branch}, then ${resumeHint(ctx.run.id)}.`, 1);
}

/** Restores or removes the out-of-bounds paths of a role (AC-40). */
export function undoOutside(ctx: Ctx, mark: RoleMark, outside: string[]): void {
  restorePaths(ctx.projectDir, mark.head, outside);
}

/** The prompt with the program's feedback appended. */
export function withFeedback(prompt: string, parts: (string | null)[]): string {
  const extra = parts.filter((p): p is string => p !== null && p !== "");
  return extra.length > 0 ? `${prompt}\n\n${extra.join("\n\n")}` : prompt;
}

export function boundsFeedback(role: string, problems: string[]): string {
  return `FROM THE PROGRAM: the previous ${role} call broke its bounds, and the program undid it:\n${problems.map((p) => `- ${p}`).join("\n")}`;
}
