import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One session log: the main conversation, or a subagent run under `<session>/subagents/`. */
export interface LogFile {
  path: string;
  /** "main", or the subagent type from the run's `.meta.json`. */
  agent: string;
}

/**
 * Claude Code keeps a project's session logs in `~/.claude/projects/<dir>`, where `<dir>` is the
 * project path with every character other than a letter or digit replaced by `-`.
 */
export function projectLogDir(projectDir: string, home = homedir()): string {
  return join(home, ".claude", "projects", projectDir.replace(/[^A-Za-z0-9]/g, "-"));
}

/** `<dir>/*.jsonl` are main sessions, `<dir>/<session>/subagents/*.jsonl` subagent runs; nothing else. */
export function listLogFiles(dir: string): LogFile[] {
  const out: LogFile[] = [];
  for (const e of entries(dir)) {
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push({ path: join(dir, e.name), agent: "main" });
    } else if (e.isDirectory()) {
      const session = join(dir, e.name);
      if (!entries(session).some((s) => s.name === "subagents" && s.isDirectory())) continue; // not a symlink
      const sub = join(session, "subagents");
      for (const s of entries(sub)) {
        if (s.isFile() && s.name.endsWith(".jsonl")) {
          const path = join(sub, s.name);
          out.push({ path, agent: agentOf(path) });
        }
      }
    }
  }
  return out;
}

/** Directory entries without following symlinks; an unreadable or missing directory is empty. */
export function entries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function agentOf(path: string): string {
  try {
    const meta: unknown = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf-8"));
    const type = isRecord(meta) ? meta.agentType : undefined;
    return typeof type === "string" && type ? type : "subagent";
  } catch {
    return "subagent";
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
