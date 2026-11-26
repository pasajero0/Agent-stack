/**
 * The OS sandbox for the Bash tool (docs/specs/sandbox1/SPEC.md): the secret folders, the detected domain list
 * and the sandbox block the harness writes into `.claude/settings.json`. The only place in `src/` that holds them.
 */

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

/** The manifest's `generatedSandbox`: the lists the harness wrote, without the user's entries. */
export interface GeneratedSandbox {
  denyRead: string[];
  allowedDomains: string[];
}

export function generatedSandbox(domains: readonly string[]): GeneratedSandbox {
  return { denyRead: [...SECRET_FOLDERS], allowedDomains: [...domains] };
}
