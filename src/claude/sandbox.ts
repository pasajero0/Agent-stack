/**
 * The OS sandbox for the Bash tool (docs/specs/sandbox1/SPEC.md): the secret folders, the detected domain list
 * and the sandbox block the harness writes into `.claude/settings.json`. The only place in `src/` that holds them.
 */

import { readFileSync } from "node:fs";
import chalk from "chalk";

/** Folders Bash may not read inside the sandbox, in the Contract order. Not `~/.config/gh`: `gh pr view` needs it. */
export const SECRET_FOLDERS: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.kube",
  "~/.docker",
  "~/.netrc",
  "~/.npmrc",
  "~/.config/gcloud",
  "~/.azure",
];

/**
 * Harness places Bash may not write inside the sandbox (`sandbox.filesystem.denyWrite`); "./" is the project root.
 * guard-file stops the Edit and Write tools there; this stops a script run through Bash. `generate` and `update`
 * still write them: the human runs those from a terminal, outside the sandbox.
 */
export const HARNESS_WRITE_PATHS: readonly string[] = ["./.claude/gates.json", "./.claude/bin", "./CLAUDE.md"];

const NPM =["registry.npmjs.org"];
const PYPI = ["pypi.org", "files.pythonhosted.org"];

/** Registry domains of each package manager (`HarnessParams.packageManager`). */
const REGISTRY_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  pnpm: NPM,
  npm: NPM,
  bun: NPM,
  yarn: ["registry.yarnpkg.com"],
  uv: PYPI,
  poetry: PYPI,
  pipenv: PYPI,
  pip: PYPI,
  go: ["proxy.golang.org", "sum.golang.org"],
  cargo: ["index.crates.io", "static.crates.io"],
};

/** Forge domains of each forge CLI (`HarnessParams.forgeCli`). */
const FORGE_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  gh: ["github.com", "api.github.com"],
};

const lookup = (table: Readonly<Record<string, readonly string[]>>, key: string): readonly string[] =>
  Object.hasOwn(table, key) ? table[key]! : [];

/** The detected domain list: the registry domains, then the forge domains; no duplicates. */
export function detectedDomains(packageManager: string, forgeCli: string): string[] {
  const all = [...lookup(REGISTRY_DOMAINS, packageManager), ...lookup(FORGE_DOMAINS, forgeCli)];
  return all.filter((d, i) => all.indexOf(d) === i);
}

/** Cache folders of each package manager (macOS and Linux): the install writes there, the sandbox blocks it. */
const CACHE_PATHS: Readonly<Record<string, readonly string[]>> = {
  npm: ["~/.npm"],
  pnpm: ["~/Library/pnpm/store", "~/Library/Caches/pnpm", "~/.local/share/pnpm/store", "~/.cache/pnpm"],
  yarn: ["~/Library/Caches/Yarn", "~/.cache/yarn", "~/.yarn/berry/cache"],
  bun: ["~/.bun/install/cache"],
};

/** The `filesystem.allowWrite` paths of the detected package manager; none for any other. */
export function detectedWritePaths(packageManager: string): string[] {
  return [...lookup(CACHE_PATHS, packageManager)];
}

/** The `sandbox` object of `.claude/settings.json`, keys in the Contract order. */
export interface SandboxBlock {
  enabled: true;
  allowUnsandboxedCommands: false;
  failIfUnavailable: true;
  filesystem: { denyRead: string[]; denyWrite: string[]; allowWrite?: string[] };
  network: { allowedDomains: string[] };
}

export function buildSandboxBlock(domains: readonly string[], writePaths: readonly string[] = []): SandboxBlock {
  return {
    enabled: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    filesystem: {
      denyRead: [...SECRET_FOLDERS],
      denyWrite: [...HARNESS_WRITE_PATHS],
      ...(writePaths.length ? { allowWrite: [...writePaths] } : {}),
    },
    network: { allowedDomains: [...domains] },
  };
}

type Exists = (cmd: string) => Promise<boolean>;

/** On `linux`, the sandbox tools not found on `PATH` (`bwrap` first). Empty elsewhere; `exists` is not called. */
export async function missingSandboxTools(platform: string, exists: Exists): Promise<string[]> {
  if (platform !== "linux") return [];
  const missing: string[] = [];
  for (const tool of ["bwrap", "socat"]) {
    if (!(await exists(tool))) missing.push(tool);
  }
  return missing;
}

/** The "tools" line of `generate` and `update` (Contract); `missing` is not empty. */
export function toolsLine(missing: readonly string[]): string {
  return (
    `missing ${missing.join(", ")} on PATH: every Bash command fails, because sandbox.failIfUnavailable is true. ` +
    "Install bubblewrap and socat, then run agent-stack detect."
  );
}

/** The status part of the `detect` sandbox line (after the padded name). */
export async function sandboxReadiness(platform: string, exists: Exists): Promise<string> {
  if (platform === "darwin") return chalk.green("✔ built in (macOS Seatbelt)");
  if (platform !== "linux") {
    return chalk.dim(`? not checked on ${platform} — see Claude Code's sandbox docs`);
  }
  const missing = await missingSandboxTools(platform, exists);
  if (missing.length === 0) return chalk.green("✔ found bwrap, socat");
  return chalk.red(
    `✖ missing ${missing.join(", ")} — Bash commands will fail; install bubblewrap and socat`,
  );
}

/** The manifest's `generatedSandbox`: the lists the harness wrote, without the user's entries. */
export interface GeneratedSandbox {
  denyRead: string[];
  denyWrite?: string[]; // always written; absent when read back from a manifest without it (before 0.5.4)
  allowedDomains: string[];
  allowWrite?: string[]; // only when the harness writes any
}

export function generatedSandbox(domains: readonly string[], writePaths: readonly string[] = []): GeneratedSandbox {
  return {
    denyRead: [...SECRET_FOLDERS],
    denyWrite: [...HARNESS_WRITE_PATHS],
    allowedDomains: [...domains],
    ...(writePaths.length ? { allowWrite: [...writePaths] } : {}),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The manifest's `generatedSandbox` as read back: each list on its own; not an array → empty; non-strings dropped. */
export function readGeneratedSandbox(v: unknown): GeneratedSandbox {
  const g = isObject(v) ? v : {};
  const allowWrite = strings(g.allowWrite);
  const denyWrite = strings(g.denyWrite);
  return {
    denyRead: strings(g.denyRead),
    ...(denyWrite.length ? { denyWrite } : {}),
    allowedDomains: strings(g.allowedDomains),
    ...(allowWrite.length ? { allowWrite } : {}),
  };
}

/** A sandbox line `update` prints at the end of its report (Contract table "update output"). */
export interface SandboxLine {
  kind: "dim" | "warn";
  text: string;
}

const ADD_LINE: SandboxLine = {
  kind: "dim",
  text: "  add sandbox.allowedDomains to .claude/gates.json to change the list",
};
const BAD_LIST: SandboxLine = {
  kind: "warn",
  text:
    ".claude/gates.json sandbox.allowedDomains must be a list of domain names, so the detected list was used. " +
    "Fix it, then run update again.",
};

/**
 * The domain source of `update`: reads gates.json once. An array of strings → that array without duplicates
 * (JSON equality, first place); key missing → the detected list and the "add" line; wrong type → the detected
 * list and the "bad list" warning; not valid JSON, not an object or missing → the detected list, no line.
 */
export function domainSource(
  gatesPath: string,
  detected: readonly string[]
): { domains: string[]; line: SandboxLine | null } {
  const fallback = (line: SandboxLine | null) => ({ domains: [...detected], line });
  let gates: unknown;
  try {
    gates = JSON.parse(readFileSync(gatesPath, "utf-8"));
  } catch {
    return fallback(null);
  }
  if (!isObject(gates)) return fallback(null);
  if (!Object.hasOwn(gates, "sandbox")) return fallback(ADD_LINE);
  const sandbox = gates.sandbox;
  if (!isObject(sandbox)) return fallback(BAD_LIST);
  if (!Object.hasOwn(sandbox, "allowedDomains")) return fallback(ADD_LINE);
  const list = sandbox.allowedDomains;
  if (!Array.isArray(list) || !list.every((d): d is string => typeof d === "string")) return fallback(BAD_LIST);
  const keys = list.map((d) => JSON.stringify(d));
  return { domains: list.filter((_, i) => keys.indexOf(keys[i]!) === i), line: null };
}

/** Safe text (Terms): each control, line/paragraph separator and bidi character → `?`. */
const UNSAFE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]", "g");
export const safeText = (s: string): string => s.replace(UNSAFE, "?");
const safeValue = (v: unknown): string => safeText(JSON.stringify(v));

const SWITCH_WARNINGS: Readonly<Record<string, string>> = {
  enabled: "Bash runs without the sandbox",
  allowUnsandboxedCommands: "the model can run a command outside the sandbox",
  failIfUnavailable: "Bash runs without the sandbox when the sandbox cannot start",
};

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What the merge reports, kept apart so `customSettings` and the lines follow the Contract order. */
interface MergeReport {
  switches: string[];
  keys: Record<"sandbox" | Place, string[]>; // other keys of each object place
  entries: Record<Place, string[]>; // denyRead, then allowedDomains entries
  warnings: string[];
  replaced: Record<"objects" | "lists", string[]>; // the five places: the objects first, then the lists
  readable: string[]; // removed secret folders, in the secret folders' order (AC-18)
  writable: string[]; // removed harness write paths, in their order
}

type Place = "filesystem" | "network";
const LIST_KEY = { filesystem: "denyRead", network: "allowedDomains" } as const;

const replaced = (path: string, what: "an object" | "a list"): string =>
  `replaced ${path} in .claude/settings.json: it was not ${what}`;

/** A list place: the harness entries, then the user's (no entry twice; not one the harness wrote last time). */
function mergeList(user: readonly unknown[], harness: readonly string[], before: readonly string[], path: string,
  out: string[]): unknown[] {
  const list: unknown[] = [...harness];
  for (const v of user) {
    if (list.some((x) => sameJson(x, v))) continue;
    if (typeof v === "string" && before.includes(v)) continue; // ours last time, not now (AC-14)
    list.push(v);
    out.push(`${path}: ${typeof v === "string" ? safeText(v) : safeValue(v)}`);
  }
  return list;
}

/**
 * An object place (`sandbox.filesystem` or `sandbox.network`) with its one list. Absent → the harness value;
 * not an object → the harness value and a "replaced" line; else the list merged, then the user's other keys.
 */
function mergePlace(
  userSandbox: Record<string, unknown>,
  place: Place,
  harness: readonly string[],
  before: readonly string[],
  r: MergeReport,
  skip: readonly string[] = []
): Record<string, unknown> {
  const path = `sandbox.${place}`;
  const listKey = LIST_KEY[place];
  const user = userSandbox[place];
  if (!Object.hasOwn(userSandbox, place)) return { [listKey]: [...harness] };
  if (!isObject(user)) {
    r.replaced.objects.push(replaced(path, "an object"));
    return { [listKey]: [...harness] };
  }
  const out: Record<string, unknown> = {};
  const list = user[listKey];
  if (!Object.hasOwn(user, listKey)) out[listKey] = [...harness];
  else if (!Array.isArray(list)) {
    r.replaced.lists.push(replaced(`${path}.${listKey}`, "a list"));
    out[listKey] = [...harness];
  } else {
    // A removed secret folder: the harness wrote it last time and the user's list has it no more (AC-18).
    const removed = place === "filesystem" ? harness.filter((h) => before.includes(h) && !list.includes(h)) : [];
    for (const folder of removed) {
      r.readable.push(`${safeText(folder)} is readable inside the sandbox: it is not in ${path}.${listKey}`);
    }
    const written = harness.filter((h) => !removed.includes(h));
    out[listKey] = mergeList(list, written, before, `${path}.${listKey}`, r.entries[place]);
  }
  for (const [k, v] of Object.entries(user)) {
    if (k === listKey || k === "__proto__" || skip.includes(k)) continue;
    out[k] = v;
    r.keys[place].push(`${path}.${safeText(k)}`);
  }
  return out;
}

/**
 * `sandbox.filesystem.denyWrite`, as denyRead: absent → the harness list; not a list → the harness list and a
 * "replaced" line; else the harness entries (minus those the user removed, each with a warning), then the user's.
 */
function mergeDenyWrite(user: Record<string, unknown>, harness: readonly string[], before: readonly string[],
  r: MergeReport): unknown[] {
  const path = "sandbox.filesystem.denyWrite";
  const fs = user.filesystem;
  if (!isObject(fs) || !Object.hasOwn(fs, "denyWrite")) return [...harness];
  const list = fs.denyWrite;
  if (!Array.isArray(list)) {
    r.replaced.lists.push(replaced(path, "a list"));
    return [...harness];
  }
  const removed = harness.filter((h) => before.includes(h) && !list.includes(h));
  for (const p of removed) r.writable.push(`${safeText(p)} is writable by Bash inside the sandbox: it is not in ${path}`);
  return mergeList(list, harness.filter((h) => !removed.includes(h)), before, path, r.entries.filesystem);
}

/**
 * `sandbox.filesystem.allowWrite`: the harness paths, then the user's (not one the harness wrote last time).
 * No key when the harness writes none and the user has none.
 */
function mergeAllowWrite(user: Record<string, unknown>, harness: readonly string[], before: readonly string[],
  fs: Record<string, unknown>, r: MergeReport): void {
  const old = isObject(user.filesystem) ? user.filesystem.allowWrite : undefined;
  const path = "sandbox.filesystem.allowWrite";
  if (!harness.length && old === undefined) return;
  if (!harness.length) {
    // The harness writes none: the user's key stays as theirs, minus what the harness wrote last time.
    const kept = Array.isArray(old) ? old.filter((v) => !(typeof v === "string" && before.includes(v))) : old;
    if (Array.isArray(kept) && !kept.length && Array.isArray(old) && old.length) return;
    fs.allowWrite = kept;
    r.keys.filesystem.push(path);
  } else if (Array.isArray(old)) {
    fs.allowWrite = mergeList(old, harness, before, path, r.entries.filesystem);
  } else {
    if (old !== undefined) r.replaced.lists.push(replaced(path, "a list"));
    fs.allowWrite = [...harness];
  }
}

/**
 * Merge the user's `sandbox` object of settings.json one level deeper (Model table): the user's weaker switch
 * and other keys stay, list entries are added after the harness entries. `merged` is settings.json as the
 * other merges left it (its `sandbox` is the harness block); `existing` is the settings.json on disk.
 * `kept` goes after today's `customSettings`; `lines` are printed with the other sandbox lines.
 */
export function mergeSandbox(
  existing: string,
  merged: string,
  before: GeneratedSandbox
): { content: string; kept: string[]; lines: SandboxLine[] } {
  const none = { content: merged, kept: [], lines: [] };
  let old: unknown;
  try {
    old = JSON.parse(existing);
  } catch {
    return none;
  }
  if (!isObject(old) || !Object.hasOwn(old, "sandbox")) return none;
  const next = JSON.parse(merged) as Record<string, unknown>;
  const harness = next.sandbox as SandboxBlock; // `merged` comes from buildSettings: its shape is known
  const user = old.sandbox;
  const warn = (text: string): SandboxLine => ({ kind: "warn", text });
  if (!isObject(user)) {
    return { content: merged, kept: [], lines: [warn(replaced("sandbox", "an object"))] };
  }
  const r: MergeReport = {
    switches: [],
    keys: { sandbox: [], filesystem: [], network: [] },
    entries: { filesystem: [], network: [] },
    warnings: [],
    replaced: { objects: [], lists: [] },
    readable: [],
    writable: [],
  };
  const out: Record<string, unknown> = {};
  for (const key of ["enabled", "allowUnsandboxedCommands", "failIfUnavailable"] as const) {
    const v = user[key];
    if (!Object.hasOwn(user, key) || v === harness[key]) {
      out[key] = harness[key];
      continue;
    }
    out[key] = v; // a weaker value: the user wins, with a warning
    r.switches.push(`sandbox.${key}: ${safeValue(v)}`);
    r.warnings.push(`sandbox.${key} is ${safeValue(v)} in .claude/settings.json: ${SWITCH_WARNINGS[key]!}`);
  }
  const writes = harness.filesystem.allowWrite ?? [];
  const skip = ["denyWrite", "allowWrite"];
  const place = mergePlace(user, "filesystem", harness.filesystem.denyRead, before.denyRead, r, skip);
  const denyWrite = mergeDenyWrite(user, harness.filesystem.denyWrite, before.denyWrite ?? [], r);
  const { denyRead, ...rest } = place;
  const fsOut: Record<string, unknown> = { denyRead, denyWrite, ...rest }; // the key order: denyRead, denyWrite
  mergeAllowWrite(user, writes, before.allowWrite ?? [], fsOut, r);
  out.filesystem = fsOut;
  out.network = mergePlace(user, "network", harness.network.allowedDomains, before.allowedDomains, r);
  for (const [k, v] of Object.entries(user)) {
    if (Object.hasOwn(out, k) || k === "__proto__") continue;
    out[k] = v;
    r.keys.sandbox.push(`sandbox.${safeText(k)}`);
  }
  next.sandbox = out;
  return {
    content: JSON.stringify(next, null, 2) + "\n",
    kept: [
      ...r.switches,
      ...r.keys.sandbox,
      ...r.keys.filesystem,
      ...r.keys.network,
      ...r.entries.filesystem,
      ...r.entries.network,
    ],
    lines: [...r.warnings, ...r.replaced.objects, ...r.replaced.lists, ...r.readable, ...r.writable].map(warn),
  };
}

/** The detected domain list inside a built settings.json (`buildSettings` output). */
export function builtDomains(settings: string): string[] {
  const s: unknown = JSON.parse(settings);
  const sandbox = isObject(s) ? s.sandbox : undefined;
  const network = isObject(sandbox) ? sandbox.network : undefined;
  return strings(isObject(network) ? network.allowedDomains : undefined);
}

/** The `filesystem.allowWrite` paths of a built settings.json. */
export function builtWritePaths(settings: string): string[] {
  const s = JSON.parse(settings) as Record<string, unknown>;
  return isObject(s.sandbox) && isObject(s.sandbox.filesystem) ? strings(s.sandbox.filesystem.allowWrite) : [];
}

/** A built settings.json with its sandbox block rebuilt for `domains`; the key keeps its place. */
export function withDomains(settings: string, domains: readonly string[]): string {
  const s = JSON.parse(settings) as Record<string, unknown>;
  const old = isObject(s.sandbox) && isObject(s.sandbox.filesystem) ? s.sandbox.filesystem.allowWrite : undefined;
  s.sandbox = buildSandboxBlock(domains, strings(old));
  return JSON.stringify(s, null, 2) + "\n";
}
