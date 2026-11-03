import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { join, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneratedFile } from "./types.js";
import type { HarnessParams } from "../detect/harness-params.js";
import { detectHarnessParams } from "../detect/harness-params.js";
import { buildGatesConfig } from "./gates.js";
import { log } from "../utils/logger.js";

/** Verbatim hooks block — correct Claude Code schema ({matcher, hooks:[{type,command}]}). */
const HOOKS_BLOCK = {
  PreToolUse: [
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.sh" }],
    },
    {
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [
        { type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-file.sh" },
        { type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/spec-gate.sh" },
        { type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/cheat-guard.sh" },
        { type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/arch-guard.sh" },
      ],
    },
  ],
  SessionStart: [
    {
      hooks: [
        { type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-context.sh" },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        { type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-flag-reflect.sh" },
        { type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/evidence-gate.sh" },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: "Edit|Write|MultiEdit",
      hooks: [
        { type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/post-edit-lint.sh" },
        { type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/post-edit-verify.sh" },
      ],
    },
  ],
};

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

function buildCodemap(): string {
  return `# CODEMAP

> Generated by agent-stack — replace with a real map of where things live (apps, packages, entry points).

| Path | What |
| --- | --- |
| \`src/\` | source |
| \`tests/\` | tests |

## Harness

\`.claude/\`, \`CLAUDE.md\`, \`CODEMAP.md\` come from agent-stack. If the harness is personal, list them in
\`.git/info/exclude\` — agent-stack does not do it for you.
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
  files.push({ path: "CODEMAP.md", content: buildCodemap(), action: "create" });
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
}

/** Classify a freshly built harness against what is on disk. Seed files are never overwritten. */
export function planUpdate(projectDir: string, files: GeneratedFile[]): UpdatePlan {
  const plan: UpdatePlan = { created: [], changed: [], unchanged: 0, kept: [], toWrite: [] };
  for (const f of files) {
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
