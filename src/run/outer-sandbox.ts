/**
 * The driver started inside an OS sandbox (a chat's sandboxed Bash on macOS).
 * There a `claude` child cannot read the login (the sandbox hides the keychain) and cannot start its own sandbox
 * (macOS refuses a sandbox inside a sandbox). So a call gets a token from a file, and its own sandbox is turned
 * off; the outer sandbox still holds every process the call starts. Defect #57.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Set to "0" to skip the probe (the tests pin it, so they do not depend on the machine). Only "0" is read. */
export const OUTER_SANDBOX_ENV = "AGENT_STACK_OUTER_SANDBOX";

/** A credential the child already has; with one of these the token file is not read. */
const CREDENTIAL_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** Where `claude setup-token`'s output is kept, under the home folder. */
export const TOKEN_FILE = join(".config", "agent-stack", "claude-token");

export type SeatbeltProbe = () => { status: number | null; stderr: string };

/** Tries to apply an allow-all Seatbelt profile to `true`. Inside a sandbox macOS refuses with `sandbox_apply`. */
const seatbeltProbe: SeatbeltProbe = () => {
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 5000 });
  return { status: r.status, stderr: typeof r.stderr === "string" ? r.stderr : "" };
};

/**
 * True when this process runs inside a macOS sandbox. Asks the OS (by absolute path), not an env variable a command could set:
 * a false "yes" would turn the child's sandbox off with no outer one. Other platforms: false (not handled).
 */
export function detectOuterSandbox(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  probe: SeatbeltProbe = seatbeltProbe
): boolean {
  if (env[OUTER_SANDBOX_ENV] === "0") return false;
  if (platform !== "darwin") return false;
  const r = probe();
  return r.status !== 0 && r.stderr.includes("sandbox_apply");
}

let memo: boolean | undefined;

/** `detectOuterSandbox` for this process, probed once. */
export function insideOuterSandbox(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env[OUTER_SANDBOX_ENV] === "0") return false;
  memo ??= detectOuterSandbox(env);
  return memo;
}

/** The token in `<home>/.config/agent-stack/claude-token`, whitespace removed (a pasted token can hold a line break); null when there is none. */
export function readTokenFile(home: string): string | null {
  const file = join(home, TOKEN_FILE);
  if (!existsSync(file)) return null;
  try {
    const token = readFileSync(file, "utf8").replace(/\s+/g, "");
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export const NO_TOKEN_MESSAGE =
  "the driver runs inside an OS sandbox, where claude cannot read the login. Run `claude setup-token` in a terminal " +
  `and save the token to ~/${TOKEN_FILE} (see README → Limits)`;

/**
 * The extra env for a call inside an outer sandbox: the token from the file, unless the env already holds a
 * credential. `null` when there is no credential at all.
 */
export function outerSandboxEnv(env: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> | null {
  if (CREDENTIAL_ENV.some((k) => (env[k] ?? "") !== "")) return {};
  const token = readTokenFile(home);
  return token === null ? null : { CLAUDE_CODE_OAUTH_TOKEN: token };
}
