/**
 * The channels that go past the OS sandbox (Bash only): Claude in Chrome tools, WebFetch and MCP tools.
 * The harness closes them in `.claude/settings.json` → `permissions`. The only place in `src/` that holds them.
 * Claude Code checks deny, then ask, then allow; a deny rule blocks in every permission mode, and an explicit
 * ask rule still asks in bypassPermissions.
 */

/** `permissions.deny`: every tool of the Claude in Chrome server (a browser with the user's own logins). */
export const DENY_ENTRIES: readonly string[] = ["mcp__claude-in-chrome__*"];

/** `permissions.ask`, in this order: WebFetch, then every tool of every MCP server. */
export const ASK_ENTRIES: readonly string[] = ["WebFetch", "mcp__*"];

/** What is open when the user removed an entry: the end of its warning line. */
const OPEN: Readonly<Record<string, string>> = {
  "mcp__claude-in-chrome__*": "Claude in Chrome tools run without a question",
  WebFetch: "WebFetch runs under the usual permission rules",
  "mcp__*": "MCP tools run under the usual permission rules",
};

export type GuardedKey = "deny" | "ask";

/** The harness entries of each guarded key. */
export const GUARDED: Readonly<Record<GuardedKey, readonly string[]>> = { deny: DENY_ENTRIES, ask: ASK_ENTRIES };

/** The deny and ask entries the harness wrote last time (manifest); null: an older manifest without the record. */
export interface GeneratedPermissions {
  deny: string[] | null;
  ask: string[] | null;
}

export const NO_RECORD: GeneratedPermissions = { deny: null, ask: null };

/** A manifest field read back: not an array → null (no record); non-strings dropped. */
export function readGeneratedList(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
}

/** The warning line `update` prints for an entry the user removed. */
export function removedLine(entry: string, key: GuardedKey): string {
  return `${entry} is not in permissions.${key} of .claude/settings.json: ${OPEN[entry] ?? "the entry is open"}`;
}
