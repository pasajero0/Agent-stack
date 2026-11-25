import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { writeFile, mkdir, chmod, unlink } from "node:fs/promises";
import { join, dirname, relative, basename, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneratedFile } from "./types.js";
import type { HarnessParams } from "../detect/harness-params.js";
import { detectHarnessParams } from "../detect/harness-params.js";
import { buildGatesConfig } from "./gates.js";
import { log } from "../utils/logger.js";
import { checkRouting } from "../run/routing.js";

interface HookCommand {
  type: string;
  command: string;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}
type HooksBlock = Record<string, HookEntry[]>;

/** The project dir is quoted: unquoted, a path with a space splits the command. */
const hook = (script: string): HookCommand => ({
  type: "command",
  command: `"$CLAUDE_PROJECT_DIR"/.claude/hooks/${script}`,
});

/** Verbatim hooks block — correct Claude Code schema ({matcher, hooks:[{type,command}]}). */
const HOOKS_BLOCK: HooksBlock = {
  PreToolUse: [
    { matcher: "Bash", hooks: [hook("guard-bash.sh")] },
    {
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [hook("guard-file.sh"), hook("spec-gate.sh"), hook("cheat-guard.sh"), hook("arch-guard.sh")],
    },
    // Reading a secret file asks first: what lands in the context can leak through any later call.
    { matcher: "Read|Grep", hooks: [hook("guard-file.sh")] },
  ],
  SessionStart: [{ hooks: [hook("session-start-context.sh")] }],
  Stop: [{ hooks: [hook("stop-flag-reflect.sh"), hook("evidence-gate.sh")] }],
  PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [hook("post-edit-lint.sh")] }],
};

/**
 * A project hook script, quoted or not: `"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard-bash.sh` → `guard-bash.sh`.
 * Anchored on the project dir, so `~/.claude/hooks/guard-bash.sh` is not mistaken for the harness's.
 */
function hookScript(command: string): string | null {
  return /CLAUDE_PROJECT_DIR\}?"?\/\.claude\/hooks\/([\w.-]+\.sh)"?\s*$/.exec(command)?.[1] ?? null;
}

const HARNESS_HOOKS = new Set(
  Object.values(HOOKS_BLOCK).flatMap((entries) =>
    entries.flatMap((e) => e.hooks.flatMap((h) => hookScript(h.command) ?? []))
  )
);

/** Claude Code hook events are PascalCase (`PreToolUse`); anything else is not an event to carry over. */
const EVENT_NAME = /^[A-Z][A-Za-z]+$/;

type LooseEntry = Record<string, unknown> & { hooks: Record<string, unknown>[] };

/** Hooks an earlier version shipped and this one removed: dropped on update, not kept as the user's. */
const RETIRED_HOOKS = new Set(["post-edit-verify.sh"]);

/**
 * `update` regenerates settings.json; carry over every hook the harness does not ship (the user's own
 * scripts, plugin commands, prompt/http hooks), whole and under the same event and matcher. A harness
 * hook is known by its script name, so an old unquoted entry is replaced, not kept twice.
 */
export function keepCustomHooks(
  existing: string,
  fresh: string
): { content: string; kept: string[]; retired: string[]; unreadable: boolean } {
  let old: unknown;
  try {
    old = JSON.parse(existing);
  } catch {
    return { content: fresh, kept: [], retired: [], unreadable: true };
  }
  const oldHooks = isObject(old) && isObject(old.hooks) ? old.hooks : {};
  // `fresh` is buildSettings() output: its shape is known.
  const next = JSON.parse(fresh) as { hooks: Record<string, LooseEntry[]> };
  const kept: string[] = [];
  const retired: string[] = [];
  for (const [event, entries] of Object.entries(oldHooks)) {
    if (!EVENT_NAME.test(event)) continue;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isObject(entry) || !Array.isArray(entry.hooks)) continue;
      const matcher = typeof entry.matcher === "string" ? entry.matcher : undefined;
      for (const h of entry.hooks) {
        if (!isObject(h)) continue;
        const command = typeof h.command === "string" ? h.command : null;
        const script = command ? hookScript(command) : null;
        if (script && HARNESS_HOOKS.has(script)) continue;
        if (script && RETIRED_HOOKS.has(script)) {
          retired.push(script);
          continue;
        }
        const target = Object.hasOwn(next.hooks, event) ? next.hooks[event]! : (next.hooks[event] = []);
        let slot = target.find((e) => e.matcher === matcher);
        if (!slot) {
          const { hooks: _drop, ...entryFields } = entry; // keep the entry's own fields, not its hooks
          target.push((slot = { ...entryFields, hooks: [] }));
        }
        if (slot.hooks.some((x) => JSON.stringify(x) === JSON.stringify(h))) continue;
        slot.hooks.push({ ...h }); // whole: timeout, async, statusMessage… survive
        kept.push(`${event}${matcher ? ` (${matcher})` : ""}: ${command ?? `${String(h.type ?? "?")} hook`}`);
      }
    }
  }
  return { content: kept.length ? JSON.stringify(next, null, 2) + "\n" : fresh, kept, retired, unreadable: false };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Keep the user's own settings when settings.json is regenerated (variant A2): top-level keys the harness
 * does not write (`env`, `plugins`, …), `permissions` keys it does not write, and entries in
 * `permissions.*` arrays beyond the generated ones. The harness's own values win where both exist.
 * `fresh` is valid JSON (buildSettings output, maybe with hooks merged); `existing` was parsed before.
 */
export function keepUserSettings(
  existing: string,
  fresh: string,
  /** `permissions.allow` the harness generated last time (manifest): an entry it no longer writes is dropped. */
  generatedBefore: readonly string[] = []
): { content: string; kept: string[] } {
  let old: unknown;
  try {
    old = JSON.parse(existing);
  } catch {
    return { content: fresh, kept: [] };
  }
  if (!isObject(old)) return { content: fresh, kept: [] };
  const next = JSON.parse(fresh) as Record<string, unknown>;
  const kept: string[] = [];
  for (const [key, value] of Object.entries(old)) {
    if (key === "hooks" || key === "__proto__") continue; // hooks: keepCustomHooks
    if (!Object.hasOwn(next, key)) {
      next[key] = value;
      kept.push(key);
    }
  }
  const oldPerms = old.permissions;
  const perms = next.permissions;
  if (isObject(oldPerms) && isObject(perms)) {
    for (const [key, value] of Object.entries(oldPerms)) {
      if (key === "__proto__") continue;
      const mine = perms[key];
      if (!Object.hasOwn(perms, key)) {
        perms[key] = value;
        kept.push(`permissions.${key}`);
      } else if (Array.isArray(mine) && Array.isArray(value)) {
        for (const v of value) {
          if (mine.some((m) => JSON.stringify(m) === JSON.stringify(v))) continue;
          if (key === "allow" && typeof v === "string" && generatedBefore.includes(v)) continue; // ours, retired
          mine.push(v);
          kept.push(`permissions.${key}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
        }
      }
    }
  }
  return { content: kept.length ? JSON.stringify(next, null, 2) + "\n" : fresh, kept };
}

/**
 * Seed files are created once and then belong to the user: `update` never overwrites them.
 * CLAUDE.md / CODEMAP.md invite edits; gates.json is tuned per repo; Claude Code itself appends
 * "always allow" rules to settings.local.json.
 */
export const SEED_PATHS = new Set([
  "CLAUDE.md",
  "CODEMAP.md",
  ".claude/gates.json",
  ".claude/settings.local.json",
]);

const MANIFEST = ".claude/.harness.json";
const SETTINGS = ".claude/settings.json";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Files the manifest hashes: everything the harness owns outright (settings.json is merged instead). */
function tracked(path: string): boolean {
  return path.startsWith(".claude/") && !SEED_PATHS.has(path) && path !== SETTINGS && path !== MANIFEST;
}

/**
 * A path read back from the manifest on disk is untrusted: only a plain harness path may be deleted through
 * it — never rules/ or tmp/ (the user's), a directory, or anything `..` or `//` could steer elsewhere.
 */
function safeTrackedPath(path: string): boolean {
  return (
    tracked(path) &&
    posix.normalize(path) === path &&
    !path.endsWith("/") &&
    !path.split("/").includes("..") &&
    !/^\.claude\/(rules|tmp)\//.test(path)
  );
}

/** A regular file whose real location is inside the project's .claude/ — not a symlink, not through one. */
function plainFileInHarness(projectDir: string, path: string): boolean {
  try {
    const full = join(projectDir, path);
    if (!lstatSync(full).isFile()) return false;
    const root = realpathSync(join(projectDir, ".claude"));
    const parent = realpathSync(dirname(full));
    return parent === root || parent.startsWith(root + sep);
  } catch {
    return false;
  }
}

function manifestContent(params: unknown, files: Record<string, string>, generatedAllow: unknown): string {
  return JSON.stringify({ templateVersion: toolVersion(), params, files, generatedAllow }, null, 2) + "\n";
}

interface Manifest {
  /** sha256 of each harness file as deployed; null for a manifest written before 0.3 (or none). */
  hashes: Record<string, string> | null;
  /** The `permissions.allow` entries the harness generated. */
  generatedAllow: string[];
}

function readManifest(projectDir: string): Manifest {
  const none: Manifest = { hashes: null, generatedAllow: [] };
  let m: unknown;
  try {
    m = JSON.parse(readFileSync(join(projectDir, MANIFEST), "utf-8"));
  } catch {
    return none;
  }
  if (!isObject(m)) return none;
  const generatedAllow = Array.isArray(m.generatedAllow)
    ? m.generatedAllow.filter((x): x is string => typeof x === "string")
    : [];
  if (!isObject(m.files)) return { hashes: null, generatedAllow };
  const hashes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(m.files)) if (typeof v === "string") hashes[k] = v;
  return { hashes, generatedAllow };
}

function templatesRoot(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(thisDir, "..", "templates", "claude"), // dist/index.js -> ../templates/claude
    join(thisDir, "..", "..", "templates", "claude"), // src/claude/ -> ../../templates/claude
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error("Could not find templates/claude");
}

/** `templates/claude/_routing.json` cannot be read or is not a valid routing (AC-19). */
export class RoutingTemplateError extends Error {
  constructor() {
    super("templates/claude/_routing.json is not a valid routing; reinstall agent-stack.");
  }
}

function loadDefaultRouting(root: string): Record<string, unknown> {
  let routing: unknown;
  try {
    routing = JSON.parse(readFileSync(join(root, "_routing.json"), "utf-8"));
  } catch {
    throw new RoutingTemplateError();
  }
  if (checkRouting(routing).length > 0) throw new RoutingTemplateError();
  return routing as Record<string, unknown>;
}

/** agent-stack's own version (package.json) — the CLI's --version and the deployed harness manifest. */
export function toolVersion(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(thisDir, "..", "package.json"), join(thisDir, "..", "..", "package.json")]) {
    try {
      return JSON.parse(readFileSync(c, "utf-8")).version ?? "0.0.0";
    } catch {
      continue;
    }
  }
  return "0.0.0";
}

function verifyCommand(p: HarnessParams): string {
  return p.commands.length ? p.commands.join(" && ") : "<test command>";
}

function substitute(text: string, p: HarnessParams): string {
  return text
    .replaceAll("{{DOCS_DIR}}", p.docsDir)
    .replaceAll("{{MAIN_BRANCH}}", p.mainBranch)
    .replaceAll("{{VERIFY_CMD}}", verifyCommand(p));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function buildSettings(p: HarnessParams): string {
  const allow = [
    ...p.commands.map((c) => `Bash(${c}:*)`),
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    `Bash(${p.forgeCli} pr view:*)`,
    `Bash(${p.forgeCli} pr diff:*)`,
    // Deliberately NOT allow-listed: .claude/bin/verify runs commands from agent-written tasks.json.
    "WebSearch",
  ];
  const settings = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    permissions: { allow },
    hooks: HOOKS_BLOCK,
  };
  return JSON.stringify(settings, null, 2) + "\n";
}

function buildSettingsLocal(p: HarnessParams): string {
  const generated = p.generatedGlobs ? p.generatedGlobs.split("|") : [];
  const settings = {
    permissions: {
      allow: ["WebSearch"],
      deny: [
        // case-glob "*/dist/*" → permission glob "dist/**"
        ...generated.map((g) => `Read(./**/${g.replace(/^\*\//, "").replace(/\/\*$/, "/**")})`),
        "Read(./**/coverage/**)",
        ...(p.lockfile ? [`Read(./**/${p.lockfile})`] : []),
        "Read(./**/node_modules/**)",
      ].filter((rule, i, all) => all.indexOf(rule) === i),
    },
  };
  return JSON.stringify(settings, null, 2) + "\n";
}

function buildClaudeMd(p: HarnessParams, root: string): string {
  const normative = readFileSync(join(root, "_normative.md"), "utf-8").replace(
    /^<!--[\s\S]*?-->\s*/,
    ""
  );
  const lines = [
    p.packageManager
      ? `- Package manager: **${p.packageManager}** only` +
        (p.forbiddenPms ? " — foreign package managers are blocked by the guard-bash hook." : ".")
      : "",
    `- Default branch: \`${p.mainBranch}\`. \`git push\` is manual-only.`,
    "- Never hand-edit generated files or lockfiles (`protectedGlobs` in `.claude/gates.json`).",
    p.commands.length ? `- Commands: ${p.commands.map((c) => `\`${c}\``).join(", ")}.` : "",
    "- Gate settings (mode, base branch, specs dir, lint/test commands): `.claude/gates.json` — human-edited.",
  ].filter(Boolean);
  const body = `# Project guide

> Generated by agent-stack. Edit freely to describe your project — \`agent-stack update\` keeps your edits.

## Tooling

${lines.join("\n")}

## Subagent delegation

- **task-analyzer** at the start of a non-trivial task.
- **spec-reviewer** after writing or changing a spec, before its MR.
- **test-writer** for tests from acceptance criteria.
- **implementer** for one task from tasks.json, model by tier.
- **code-reviewer** after writing or modifying code.
- **researcher** for fact lookups (cheap model).
- **pattern-scout** to (re)generate \`.claude/rules/\` after structural changes.

`;
  return body + normative;
}

function buildCodemap(p: HarnessParams): string {
  return `# CODEMAP

> The project's map: one entry point that links to everything else. agent-stack wrote this stub — fill each
> table with the real paths and keep it in git; it is the project's, not the harness's.

## Code

| Path | What |
| --- | --- |
| <path> | <app, package or entry point — one line> |

## Specs

One folder per stage under \`${p.docsDir}specs/\`. Each \`SPEC.md\` lists the ADRs behind it.

| Stage | Spec | What |
| --- | --- | --- |
| <stage id> | [SPEC.md](${p.docsDir}specs/STAGE/SPEC.md) | <one line> |

## Docs

| Path | What |
| --- | --- |
| \`${p.docsDir}adr/\` | decisions, one per file |
| <path> | <architecture, guides> |
`;
}

/** Build the full harness file set (pure — no IO side effects on the target). */
export function buildHarnessFiles(params: HarnessParams, templatesDir?: string): GeneratedFile[] {
  const root = templatesDir ?? templatesRoot();
  const routing = loadDefaultRouting(root); // first: a broken template stops before anything is built
  const files: GeneratedFile[] = [];

  for (const abs of walk(root)) {
    if (basename(abs).startsWith("_")) continue; // generator input, not deployed
    const rel = relative(root, abs).split(sep).join("/"); // "/" on every OS: manifest keys stay portable
    const content = substitute(readFileSync(abs, "utf-8"), params);
    files.push({ path: posix.join(".claude", rel), content, action: "create" });
  }

  files.push({ path: ".claude/settings.json", content: buildSettings(params), action: "create" });
  files.push({
    path: ".claude/settings.local.json",
    content: buildSettingsLocal(params),
    action: "create",
  });
  files.push({
    path: ".claude/gates.json",
    content: JSON.stringify(buildGatesConfig(params, routing), null, 2) + "\n",
    action: "create",
  });
  files.push({ path: "CLAUDE.md", content: buildClaudeMd(params, root), action: "create" });
  files.push({ path: "CODEMAP.md", content: buildCodemap(params), action: "create" });
  const hashes: Record<string, string> = {};
  for (const f of files) if (tracked(f.path)) hashes[f.path] = sha256(f.content);
  const allow = (JSON.parse(buildSettings(params)) as { permissions: { allow: string[] } }).permissions.allow;
  files.push({ path: MANIFEST, content: manifestContent(params, hashes, allow), action: "create" });

  return files;
}

export interface UpdatePlan {
  created: string[];
  changed: string[];
  unchanged: number;
  /** Seed files already on disk — the user's, left untouched. */
  kept: string[];
  /** What `update` actually writes: new files + changed emitter-owned files. */
  toWrite: GeneratedFile[];
  /** The user's own hook entries carried over into the regenerated settings.json. */
  customHooks: string[];
  /** Hooks an earlier version registered and this one dropped (their files stay on disk). */
  retiredHooks: string[];
  /** settings.json on disk was not valid JSON: its custom hooks, if any, could not be carried over. */
  settingsUnreadable: boolean;
  /** The user's own settings.json keys and permission entries carried over (variant A2). */
  customSettings: string[];
  /** Harness files the user changed since they were deployed: left as they are (`--force` overwrites). */
  edited: string[];
  /** Harness files no longer shipped, untouched since deployment: `update` deletes them. */
  removed: string[];
  /** Harness files no longer shipped but changed by the user: left in place. */
  orphaned: string[];
  /** The manifest predates file hashes (≤ 0.2): edits cannot be told apart this time. */
  noHashes: boolean;
}

/**
 * Classify a freshly built harness against what is on disk. Seed files are never overwritten; a harness
 * file the user changed since deployment (its hash differs from the manifest) is kept unless `force`.
 */
export function planUpdate(
  projectDir: string,
  files: GeneratedFile[],
  options: { force?: boolean } = {}
): UpdatePlan {
  const plan: UpdatePlan = {
    created: [],
    changed: [],
    unchanged: 0,
    kept: [],
    toWrite: [],
    customHooks: [],
    retiredHooks: [],
    settingsUnreadable: false,
    customSettings: [],
    edited: [],
    removed: [],
    orphaned: [],
    noHashes: false,
  };
  const before = readManifest(projectDir);
  const recorded = before.hashes;
  plan.noHashes = recorded === null;
  const hashes: Record<string, string> = {};
  let manifest: GeneratedFile | undefined;

  const classify = (f: GeneratedFile): void => {
    const full = join(projectDir, f.path);
    if (!existsSync(full)) {
      plan.created.push(f.path);
      plan.toWrite.push(f);
    } else if (SEED_PATHS.has(f.path)) {
      plan.kept.push(f.path);
    } else if (readFileSync(full, "utf-8") !== f.content) {
      plan.changed.push(f.path);
      plan.toWrite.push(f);
    } else {
      plan.unchanged++;
    }
  };

  for (const built of files) {
    const full = join(projectDir, built.path);
    let f = built;
    if (f.path === MANIFEST) {
      manifest = f;
      continue;
    }
    if (f.path === SETTINGS && existsSync(full)) {
      const raw = readFileSync(full, "utf-8");
      const merged = keepCustomHooks(raw, f.content);
      plan.customHooks = merged.kept;
      plan.retiredHooks = merged.retired;
      plan.settingsUnreadable = merged.unreadable;
      if (merged.unreadable) {
        plan.kept.push(f.path); // not ours to overwrite blind: the user fixes the JSON, then updates
        continue;
      }
      const settings = keepUserSettings(raw, merged.content, before.generatedAllow);
      plan.customSettings = settings.kept;
      f = { ...f, content: settings.content };
    }
    if (tracked(f.path)) {
      const deployed = recorded?.[f.path];
      const onDisk = existsSync(full) ? readFileSync(full, "utf-8") : null;
      // Changed since deployment — or, with hashes recorded, a file the harness never deployed here.
      const yours = recorded !== null && onDisk !== null && onDisk !== f.content &&
        (deployed === undefined || sha256(onDisk) !== deployed);
      if (yours && !options.force) {
        plan.edited.push(f.path);
        if (deployed) hashes[f.path] = deployed; // still the user's next time
        continue;
      }
      hashes[f.path] = sha256(f.content);
    }
    classify(f);
  }

  if (recorded) {
    const shipped = new Set(files.map((f) => f.path));
    for (const [path, deployed] of Object.entries(recorded)) {
      if (shipped.has(path) || !safeTrackedPath(path)) continue;
      const full = join(projectDir, path);
      if (!existsSync(full)) continue;
      if (!plainFileInHarness(projectDir, path)) {
        plan.orphaned.push(path); // a symlink or a directory: never deleted by update
        continue;
      }
      if (sha256(readFileSync(full, "utf-8")) === deployed) plan.removed.push(path);
      else plan.orphaned.push(path);
    }
  }

  if (manifest) {
    const m: unknown = JSON.parse(manifest.content);
    const built = isObject(m) ? m : {};
    classify({ ...manifest, content: manifestContent(built.params, hashes, built.generatedAllow) });
  }
  return plan;
}

/** Hooks and harness scripts (`.claude/bin/`) are run directly, so they must be executable. */
export function isExecutable(path: string): boolean {
  return (
    (path.startsWith(".claude/hooks/") && path.endsWith(".sh")) || path.startsWith(".claude/bin/")
  );
}

/** Write a harness file set to disk (chmod +x hooks and scripts). Only touches the listed
 *  (emitter-owned) paths — anything else under .claude/ (rules/, tmp/) is left intact. */
export async function writeHarnessFiles(
  projectDir: string,
  files: GeneratedFile[]
): Promise<void> {
  for (const f of files) {
    const full = join(projectDir, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content, "utf-8");
    if (isExecutable(f.path)) await chmod(full, 0o755);
    log.success(f.path);
  }
}

/** Delete harness files that are no longer shipped (only paths `planUpdate` put in `removed`). */
export async function removeHarnessFiles(projectDir: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await unlink(join(projectDir, p));
      log.success(`removed ${p}`);
    } catch (e) {
      // The new manifest no longer lists it, so say so now — a later update will not see it again.
      log.warn(`could not remove ${p} (${e instanceof Error ? e.message : String(e)}) — delete it by hand`);
    }
  }
}

/** Detect params, build the harness, write it to disk. */
export async function emitHarness(projectDir: string, templatesDir?: string): Promise<GeneratedFile[]> {
  const params = await detectHarnessParams(projectDir);
  const files = buildHarnessFiles(params, templatesDir);
  await writeHarnessFiles(projectDir, files);
  return files;
}
