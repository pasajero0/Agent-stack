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
export const HOOKS_BLOCK: HooksBlock = {
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
  Stop: [{ hooks: [hook("stop-flag-reflect.sh")] }],
  PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [hook("post-edit-lint.sh")] }],
};

/**
 * A project hook script, quoted or not: `"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard-bash.sh` → `guard-bash.sh`.
 * Anchored on the project dir, so `~/.claude/hooks/guard-bash.sh` is not mistaken for the harness's.
 */
export function hookScript(command: string): string | null {
  return /CLAUDE_PROJECT_DIR\}?"?\/\.claude\/hooks\/([\w.-]+\.sh)"?\s*$/.exec(command)?.[1] ?? null;
}
