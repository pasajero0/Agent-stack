/** Git helpers of the pipeline driver. Spec: docs/specs/v04/SPEC.md (Terms, Commits). */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RunError } from "./errors.js";

const TMP_DIR = ".claude/tmp";
const TMP_EXCLUDE = `:(exclude)${TMP_DIR}`;

export interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommitResult {
  ok: boolean;
  /** stdout and stderr of `git commit`, hook output included. */
  output: string;
  sha: string | null;
}

/** Runs `git <args>` in `dir`. Never throws on a non-zero exit. */
export function git(dir: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const code = r.status ?? 1;
  return { ok: code === 0, code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function mustGit(dir: string, args: string[]): string {
  const r = git(dir, args);
  if (!r.ok) {
    throw new RunError(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`, 1);
  }
  return r.stdout;
}

/** A path as a literal git pathspec, so `[`, `*` and `?` are not globs. */
function lit(path: string): string {
  return `:(literal)${path}`;
}

function isTmp(path: string): boolean {
  return path === TMP_DIR || path.startsWith(`${TMP_DIR}/`);
}

function splitZ(out: string): string[] {
  return out.split("\0").filter((p) => p !== "");
}

/** Paths from `git status --porcelain`, `.claude/tmp/` excluded. */
export function dirtyPaths(dir: string): string[] {
  const out = mustGit(dir, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const parts = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // A rename or copy is followed by its source path.
    if (status.includes("R") || status.includes("C")) i++;
  }
  return paths.filter((p) => !isTmp(p));
}

export function isClean(dir: string): boolean {
  return dirtyPaths(dir).length === 0;
}

/** Current branch, or null when HEAD is detached. */
export function currentBranch(dir: string): string | null {
  const r = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.ok ? r.stdout.trim() : null;
}

export function headSha(dir: string): string {
  return mustGit(dir, ["rev-parse", "HEAD"]).trim();
}

export function branchExists(dir: string, name: string): boolean {
  return git(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).ok;
}

export function createBranch(dir: string, name: string, from: string): void {
  mustGit(dir, ["checkout", "-q", "-b", name, from]);
}

export function checkout(dir: string, name: string): void {
  mustGit(dir, ["checkout", "-q", name]);
}

/** `origin/<baseBranch>` when it exists, else `<baseBranch>`. */
export function baseRef(dir: string, baseBranch: string): string {
  const remote = `origin/${baseBranch}`;
  return git(dir, ["rev-parse", "--verify", "--quiet", `${remote}^{commit}`]).ok ? remote : baseBranch;
}

export function existsOnRef(dir: string, ref: string, path: string): boolean {
  return git(dir, ["cat-file", "-e", `${ref}:${path}`]).ok;
}

function untrackedPaths(dir: string): string[] {
  const out = mustGit(dir, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return splitZ(out).filter((p) => !isTmp(p));
}

/** Paths changed since `base` (tracked and untracked), sorted, `.claude/tmp/` excluded. */
export function taskDiffPaths(dir: string, base: string): string[] {
  const tracked = splitZ(
    mustGit(dir, ["diff", "--name-only", "--no-renames", "-z", base, "--", ".", TMP_EXCLUDE])
  );
  return [...new Set([...tracked, ...untrackedPaths(dir)])].sort();
}

function countLines(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  if (text === "") return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** Added plus deleted lines since `base`, plus all lines of each untracked file. */
export function diffLines(dir: string, base: string): number {
  const out = mustGit(dir, ["diff", "--numstat", "--no-renames", base, "--", ".", TMP_EXCLUDE]);
  let total = 0;
  for (const line of out.split("\n")) {
    const [added, deleted] = line.split("\t");
    // Binary files show "-" and count as 0.
    total += (Number(added) || 0) + (Number(deleted) || 0);
  }
  for (const p of untrackedPaths(dir)) total += countLines(join(dir, p));
  return total;
}

/** Human-readable stat of the task diff; untracked files are listed with their line counts. */
export function diffStat(dir: string, base: string): string {
  const stat = mustGit(dir, ["diff", "--stat", "--no-renames", base, "--", ".", TMP_EXCLUDE]).trimEnd();
  const fresh = untrackedPaths(dir).map((p) => ` ${p} (new, ${countLines(join(dir, p))} lines)`);
  return [stat, ...fresh].filter((s) => s !== "").join("\n");
}

/**
 * Stages exactly `paths` (never `.claude/tmp/`) and commits only them. A refusal (hook, nothing to
 * commit) gives `ok: false` with the git output.
 */
export function commitPaths(dir: string, paths: string[], header: string): CommitResult {
  const wanted = [...new Set(paths)].filter((p) => !isTmp(p));
  if (wanted.length === 0) return { ok: false, output: "no paths to commit", sha: null };
  const add = git(dir, ["add", "-A", "--", ...wanted.map(lit)]);
  if (!add.ok) return { ok: false, output: `${add.stdout}${add.stderr}`, sha: null };
  const commit = git(dir, ["commit", "-q", "-m", header, "--only", "--", ...wanted.map(lit)]);
  const output = `${commit.stdout}${commit.stderr}`;
  return commit.ok ? { ok: true, output, sha: headSha(dir) } : { ok: false, output, sha: null };
}

/** Moves HEAD to `sha`, keeping the index and the working tree. */
export function softReset(dir: string, sha: string): void {
  mustGit(dir, ["reset", "--soft", sha]);
}

/** Restores each path to its state on `base`; a path that is not on `base` is removed. */
export function restorePaths(dir: string, base: string, paths: string[]): void {
  for (const p of paths) {
    if (isTmp(p)) continue;
    if (existsOnRef(dir, base, p)) {
      mustGit(dir, ["checkout", "-q", base, "--", lit(p)]);
    } else {
      git(dir, ["rm", "-q", "-f", "--cached", "--ignore-unmatch", "--", lit(p)]);
      rmSync(join(dir, p), { force: true });
    }
  }
}

/** Header that `@commitlint/config-conventional` accepts: lowercase scope and subject start, no period, ≤ 100. */
export function normaliseHeader(type: string, scope: string | null, subject: string): string {
  if (subject.trim() === "") throw new RunError("commit subject is empty", 1);
  const prefix = scope ? `${type}(${scope.toLowerCase()}): ` : `${type}: `;
  let text = subject.trim().replace(/\s+/g, " ");
  text = text.charAt(0).toLowerCase() + text.slice(1);
  text = text.slice(0, Math.max(0, 100 - prefix.length)).replace(/[.\s]+$/, "");
  return `${prefix}${text}`;
}

/** `[a-z0-9-]`, at most 40 characters, no leading or trailing dash; `run` when nothing is left. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" ? "run" : slug;
}
