import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { join, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneratedFile } from "./types.js";
import type { HarnessParams } from "../detect/harness-params.js";
import { detectHarnessParams } from "../detect/harness-params.js";
import { buildGatesConfig } from "./gates.js";
import { log } from "../utils/logger.js";

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
export function buildHarnessFiles(params: HarnessParams): GeneratedFile[] {
  const root = templatesRoot();
  const files: GeneratedFile[] = [];

  for (const abs of walk(root)) {
    if (basename(abs).startsWith("_")) continue; // generator input, not deployed
    const rel = relative(root, abs);
    const content = substitute(readFileSync(abs, "utf-8"), params);
    files.push({ path: join(".claude", rel), content, action: "create" });
  }

  files.push({ path: ".claude/settings.json", content: buildSettings(params), action: "create" });
  files.push({
    path: ".claude/settings.local.json",
    content: buildSettingsLocal(params),
    action: "create",
  });
  files.push({
    path: ".claude/gates.json",
    content: JSON.stringify(buildGatesConfig(params), null, 2) + "\n",
    action: "create",
  });
  files.push({ path: "CLAUDE.md", content: buildClaudeMd(params, root), action: "create" });
  files.push({ path: "CODEMAP.md", content: buildCodemap(params), action: "create" });
  files.push({
    path: ".claude/.harness.json",
    content: JSON.stringify({ templateVersion: toolVersion(), params }, null, 2) + "\n",
    action: "create",
  });

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
}

/** Classify a freshly built harness against what is on disk. Seed files are never overwritten. */
export function planUpdate(projectDir: string, files: GeneratedFile[]): UpdatePlan {
  const plan: UpdatePlan = {
    created: [],
    changed: [],
    unchanged: 0,
    kept: [],
    toWrite: [],
    customHooks: [],
    retiredHooks: [],
    settingsUnreadable: false,
  };
  for (const built of files) {
    const full = join(projectDir, built.path);
    let f = built;
    if (f.path === ".claude/settings.json" && existsSync(full)) {
      const merged = keepCustomHooks(readFileSync(full, "utf-8"), f.content);
      f = { ...f, content: merged.content };
      plan.customHooks = merged.kept;
      plan.retiredHooks = merged.retired;
      plan.settingsUnreadable = merged.unreadable;
      if (merged.unreadable) {
        plan.kept.push(f.path); // not ours to overwrite blind: the user fixes the JSON, then updates
        continue;
      }
    }
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

/** Detect params, build the harness, write it to disk. */
export async function emitHarness(projectDir: string): Promise<GeneratedFile[]> {
  const params = await detectHarnessParams(projectDir);
  const files = buildHarnessFiles(params);
  await writeHarnessFiles(projectDir, files);
  return files;
}
