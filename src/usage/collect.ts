import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { isRecord, type LogFile } from "./logs.js";

/**
 * Counts what the harness actually did, read from Claude Code session logs. The log format is Claude
 * Code's internal one, not a public API: a line this code does not recognise is skipped.
 * Only real events count — a hook's text quoted in a file the agent read is not a firing.
 */
export interface TokenRow {
  agent: string;
  model: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Counts keyed by names taken from the logs; null-prototype, so a name like `constructor` is safe. */
export type Counts = Record<string, number>;

export interface UsageReport {
  mainSessions: number;
  subagentRuns: number;
  /** Log files that could not be read (deleted mid-run, no permission). */
  skippedFiles: number;
  first: string | null;
  last: string | null;
  tools: Counts;
  /** Agent tool calls by `subagent_type`. */
  agents: Counts;
  skills: Counts;
  /** Slash commands typed by the human. */
  commands: Counts;
  /** `.claude/bin/<tool>` runs through Bash. */
  bin: Counts;
  /** PreToolUse/PostToolUse hooks that denied a tool call, by script name. */
  hookBlocks: Counts;
  /** Context a hook added to the conversation, by hook event (e.g. `PostToolUse:Edit`). */
  hookContext: Counts;
  /** Stop hooks: how often each ran. */
  stopRuns: Counts;
  /** Stops where any Stop hook produced output, errors or kept Claude going. */
  stopsActed: number;
  tokens: TokenRow[];
}

export const counts = (): Counts => Object.create(null) as Counts;

export function emptyReport(): UsageReport {
  return {
    mainSessions: 0,
    subagentRuns: 0,
    skippedFiles: 0,
    first: null,
    last: null,
    tools: counts(),
    agents: counts(),
    skills: counts(),
    commands: counts(),
    bin: counts(),
    hookBlocks: counts(),
    hookContext: counts(),
    stopRuns: counts(),
    stopsActed: 0,
    tokens: [],
  };
}

// Anchored to a line start: an error result that merely quotes an old block (a failed grep over logs)
// has a file path or line number in front of it.
const HOOK_ERROR = /^\s*(?:PreToolUse|PostToolUse):\w+ hook error: \[[^\]]*?([\w.-]+)\.sh\]/gm;
const BIN_TOOL = /\.claude\/bin\/(verify|trace|health)\b/g;
const COMMAND = /<command-name>\/?([\w:-]+)<\/command-name>/g;
const SKILL_FILE = /\.claude\/skills\/([\w-]+)\/SKILL\.md$/;

/** State kept across all lines of one report. */
export interface IngestState {
  /** Message ids already counted for tokens: a streamed message is logged once per content block. */
  seenMessages: Set<string>;
  /** Line uuids already counted: a resumed or forked session copies earlier lines into a new file. */
  seenLines: Set<string>;
  since: number | null;
}

export function newState(sinceMs: number | null = null): IngestState {
  return { seenMessages: new Set(), seenLines: new Set(), since: sinceMs };
}

/** Counts one log line. Returns true when it was a conversation turn inside the time window. */
export function ingestLine(r: UsageReport, line: string, agent: string, st: IngestState): boolean {
  let d: unknown;
  try {
    d = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isRecord(d)) return false;

  const ts = typeof d.timestamp === "string" ? d.timestamp : null;
  if (st.since !== null) {
    const t = ts ? Date.parse(ts) : NaN;
    if (!(t >= st.since)) return false; // missing or unparseable timestamps are outside the window
  }
  const uuid = typeof d.uuid === "string" ? d.uuid : null;
  if (uuid) {
    if (st.seenLines.has(uuid)) return false;
    st.seenLines.add(uuid);
  }
  if (ts) {
    if (!r.first || ts < r.first) r.first = ts;
    if (!r.last || ts > r.last) r.last = ts;
  }

  const msg = isRecord(d.message) ? d.message : {};
  if (d.type === "assistant") ingestAssistant(r, msg, agent, st);
  else if (d.type === "user") ingestUser(r, msg, agent);
  else if (d.type === "attachment" && isRecord(d.attachment)) ingestAttachment(r, d.attachment);
  else if (d.type === "system" && d.subtype === "stop_hook_summary") ingestStop(r, d);
  return d.type === "assistant" || d.type === "user";
}

function ingestAssistant(r: UsageReport, msg: Record<string, unknown>, agent: string, st: IngestState) {
  const id = str(msg.id);
  if (id && !st.seenMessages.has(id) && isRecord(msg.usage)) {
    st.seenMessages.add(id);
    addTokens(r, agent, str(msg.model) ?? "?", msg.usage);
  }
  for (const c of arr(msg.content)) {
    if (!isRecord(c) || c.type !== "tool_use" || typeof c.name !== "string") continue;
    const input = isRecord(c.input) ? c.input : {};
    bump(r.tools, c.name);
    if (c.name === "Agent" || c.name === "Task") bump(r.agents, str(input.subagent_type) ?? "general-purpose");
    const skill = str(input.skill);
    if (c.name === "Skill" && skill) bump(r.skills, skill);
    // Agents also follow a skill by reading its SKILL.md directly, without the Skill tool.
    if (c.name === "Read") {
      const read = SKILL_FILE.exec(str(input.file_path) ?? "");
      if (read?.[1]) bump(r.skills, read[1]);
    }
    if (c.name === "Bash") bumpAll(r.bin, str(input.command) ?? "", BIN_TOOL);
  }
}

function ingestUser(r: UsageReport, msg: Record<string, unknown>, agent: string) {
  const content = msg.content;
  if (typeof content === "string") {
    if (agent === "main") bumpAll(r.commands, content, COMMAND);
    return;
  }
  for (const c of arr(content)) {
    if (!isRecord(c)) continue;
    if (c.type === "text" && agent === "main") bumpAll(r.commands, str(c.text) ?? "", COMMAND);
    if (c.type === "tool_result" && c.is_error === true) bumpAll(r.hookBlocks, resultText(c.content), HOOK_ERROR);
  }
}

function ingestAttachment(r: UsageReport, a: Record<string, unknown>) {
  // The IDE's own diagnostics arrive in the same envelope as a hook's context: not a hook firing.
  if (a.type === "hook_additional_context" && !JSON.stringify(a.content ?? "").includes("<ide_diagnostics>")) {
    bump(r.hookContext, str(a.hookName) ?? "?");
  }
  // A SessionStart hook's output is logged as a success, not as added context.
  if (a.type === "hook_success" && a.hookEvent === "SessionStart") bump(r.hookContext, str(a.hookName) ?? "SessionStart");
}

function ingestStop(r: UsageReport, d: Record<string, unknown>) {
  for (const h of arr(d.hookInfos)) {
    const name = isRecord(h) ? hookName(str(h.command)) : null;
    if (name) bump(r.stopRuns, name);
  }
  if (d.preventedContinuation === true || d.hasOutput === true || arr(d.hookErrors).length > 0) {
    r.stopsActed++;
  }
}

/** `$CLAUDE_PROJECT_DIR/.claude/hooks/evidence-gate.sh` → `evidence-gate`; other commands → null. */
function hookName(command: string | null): string | null {
  const m = command ? /([\w.-]+)\.sh"?$/.exec(command) : null;
  return m?.[1] ?? null;
}

function addTokens(r: UsageReport, agent: string, model: string, u: Record<string, unknown>) {
  let row = r.tokens.find((t) => t.agent === agent && t.model === model);
  if (!row) {
    row = { agent, model, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    r.tokens.push(row);
  }
  row.input += num(u.input_tokens);
  row.cacheWrite += num(u.cache_creation_input_tokens);
  row.cacheRead += num(u.cache_read_input_tokens);
  row.output += num(u.output_tokens);
}

export async function collectUsage(files: LogFile[], sinceMs: number | null = null): Promise<UsageReport> {
  const r = emptyReport();
  const st = newState(sinceMs);
  for (const f of files) {
    let counted = false;
    const input = createReadStream(f.path, "utf-8");
    try {
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        if (ingestLine(r, line, f.agent, st)) counted = true;
      }
    } catch {
      r.skippedFiles++;
      continue;
    } finally {
      input.destroy();
    }
    if (counted) {
      if (f.agent === "main") r.mainSessions++;
      else r.subagentRuns++;
    }
  }
  r.tokens = r.tokens.filter((t) => t.input + t.cacheWrite + t.cacheRead + t.output > 0);
  r.tokens.sort((a, b) => b.cacheWrite + b.output - (a.cacheWrite + a.output));
  return r;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map((x) => (isRecord(x) ? (str(x.text) ?? "") : ""))
    .join("\n");
}

function bump(m: Counts, key: string) {
  m[key] = (m[key] ?? 0) + 1;
}
/** Bumps group 1 of every match of a global regex. */
function bumpAll(m: Counts, text: string, re: RegExp) {
  for (const hit of text.matchAll(re)) if (hit[1]) bump(m, hit[1]);
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
