#!/usr/bin/env node
// Fake `claude` for the v04 driver tests. Plain Node ESM, no dependencies. See .claude/tmp/v04/design.md.
//
// FAKE_CLAUDE_SCRIPT names a JSON array of responses, consumed in order (counter in `<script>.idx`).
// FAKE_CLAUDE_LOG gets one JSONL line per call: {argv, env: {AGENT_STACK_RUN and the AC-58 vars}, prompt}. `prompt` is an excerpt:
// the whole prompt up to 4000 chars, else its first and last 2000 (the program's feedback is appended last).
// A response: { expectRole?, expectModel?, writes?: {path: content}, deletes?: string[], exec?: string,
//               exit?: number, stdout?: string | object, sleepMs?: number, output?: unknown }
// With expectRole set, the fake exits 9 unless the prompt's first non-empty line names the role and
// `--model` fits it (opus for every role but implement; expectModel when given).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const prompt = readStdin();

const LOGGED_ENV = ["AGENT_STACK_RUN", "ENABLE_CLAUDEAI_MCP_SERVERS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS"];
const loggedEnv = () => Object.fromEntries(LOGGED_ENV.map((k) => [k, process.env[k] ?? null]));

const log = process.env.FAKE_CLAUDE_LOG;
if (log) {
  const excerpt = prompt.length <= 4000 ? prompt : `${prompt.slice(0, 2000)}\n[...]\n${prompt.slice(-2000)}`;
  appendFileSync(log, JSON.stringify({ argv, env: loggedEnv(), prompt: excerpt }) + "\n");
}

const scriptPath = process.env.FAKE_CLAUDE_SCRIPT;
if (!scriptPath) {
  process.stderr.write("fake-claude: FAKE_CLAUDE_SCRIPT is not set\n");
  process.exit(2);
}
const script = JSON.parse(readFileSync(scriptPath, "utf8"));
const idxPath = `${scriptPath}.idx`;
const idx = existsSync(idxPath) ? Number(readFileSync(idxPath, "utf8")) : 0;
writeFileSync(idxPath, String(idx + 1));
const response = script[idx];
if (!response) {
  process.stderr.write(`fake-claude: script has no response #${idx}\n`);
  process.exit(2);
}

if (response.expectRole) {
  const role = String(response.expectRole);
  const model = flag("--model");
  const header = (prompt.split("\n").find((l) => l.trim() !== "") ?? "").toLowerCase();
  const wantModel = response.expectModel ?? (role === "implement" ? null : "opus");
  const modelOk = wantModel === null ? model !== null : model === wantModel;
  if (!modelOk || !header.includes(role.toLowerCase())) {
    process.stderr.write(`fake-claude: expected role ${role} (model ${wantModel ?? "any"}), got model ${model}, header "${header}"\n`);
    process.exit(9);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (response.sleepMs) await sleep(response.sleepMs);

for (const [p, content] of Object.entries(response.writes ?? {})) {
  const full = resolve(process.cwd(), p);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, String(content));
}
for (const p of response.deletes ?? []) {
  rmSync(resolve(process.cwd(), p), { recursive: true, force: true });
}
if (response.exec) {
  execSync(response.exec, { cwd: process.cwd(), stdio: "ignore" });
}

let stdout = response.stdout;
if (stdout === undefined) {
  stdout = {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    total_cost_usd: 0.01,
    permission_denials: [],
    structured_output: response.output,
  };
}
// stream-json (AC-78): an assistant event per scripted tool, then the result as the last line.
for (const t of response.tools ?? []) {
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: t.name, input: t.input ?? {} }] } }) + "\n");
}
process.stdout.write(typeof stdout === "string" ? stdout : JSON.stringify(stdout));
process.exit(response.exit ?? 0);
