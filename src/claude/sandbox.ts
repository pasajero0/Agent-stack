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

const NPM = ["registry.npmjs.org"];
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

/** The `sandbox` object of `.claude/settings.json`, keys in the Contract order. */
export interface SandboxBlock {
  enabled: true;
  allowUnsandboxedCommands: false;
  failIfUnavailable: true;
  filesystem: { denyRead: string[] };
  network: { allowedDomains: string[] };
}

export function buildSandboxBlock(domains: readonly string[]): SandboxBlock {
  return {
    enabled: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    filesystem: { denyRead: [...SECRET_FOLDERS] },
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
  allowedDomains: string[];
}

export function generatedSandbox(domains: readonly string[]): GeneratedSandbox {
  return { denyRead: [...SECRET_FOLDERS], allowedDomains: [...domains] };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The manifest's `generatedSandbox` as read back: each list on its own; not an array → empty; non-strings dropped. */
export function readGeneratedSandbox(v: unknown): GeneratedSandbox {
  const g = isObject(v) ? v : {};
  return { denyRead: strings(g.denyRead), allowedDomains: strings(g.allowedDomains) };
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

/** The detected domain list inside a built settings.json (`buildSettings` output). */
export function builtDomains(settings: string): string[] {
  const s: unknown = JSON.parse(settings);
  const sandbox = isObject(s) ? s.sandbox : undefined;
  const network = isObject(sandbox) ? sandbox.network : undefined;
  return strings(isObject(network) ? network.allowedDomains : undefined);
}

/** A built settings.json with its sandbox block rebuilt for `domains`; the key keeps its place. */
export function withDomains(settings: string, domains: readonly string[]): string {
  const s = JSON.parse(settings) as Record<string, unknown>;
  s.sandbox = buildSandboxBlock(domains);
  return JSON.stringify(s, null, 2) + "\n";
}
