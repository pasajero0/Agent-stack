import { SKIP_MARKS } from "../run/engine/skip-marks.js";
import type { HarnessParams } from "../detect/harness-params.js";
import { detectedDomains } from "./sandbox.js";

/** interactive: step-by-step diff confirmation (default). autonomous: no confirmations, hard limits. */
export type GateMode = "interactive" | "autonomous";

/** strict: no code edit without a merged spec for the active stage. stage: only while a stage is active. */
export type SpecGateMode = "strict" | "stage" | "off";

/**
 * `.claude/gates.json` — every stack-specific value the hooks need. Hooks read only this file, so the
 * harness works the same for any language. Edited by a human (guard-file blocks the agent).
 */
export interface GatesConfig {
  mode: GateMode;
  baseBranch: string;
  specsDir: string;
  adrDir: string;
  /** Bash regex on the branch's last path segment; capture group 1 is the stage id. */
  stagePattern: string;
  specGate: SpecGateMode;
  /** Case-globs (relative to the repo root) that stay editable without a merged spec. */
  openPaths: string[];
  /** Case-globs of generated files and lockfiles — never hand-edited. */
  protectedGlobs: string[];
  packageManager: string;
  forbiddenPackageManagers: string[];
  /** ERE fragments matched at a command start; ask in interactive mode, deny in autonomous. */
  installPatterns: string[];
  cheatGuard: boolean;
  /** ERE patterns whose count must not grow in an edit (skipped tests, suppressed checks). */
  cheatPatterns: string[];
  commands: { test: string; lint: string };
  /** Case-globs of files the lint hook checks. */
  lintMatch: string[];
  /** Case-globs of test files — `.claude/bin/trace` looks for "<stage> AC-n" there. */
  testGlobs: string[];
  /** Architecture boundaries (arch-guard): files in a layer may not add imports matching `forbid`. */
  layers: LayerRule[];
  /**
   * Case-globs where Markdown files belong; `health` reports a changed `.md` outside them (never
   * blocks). Markdown at the repo root always fits. Empty = no check.
   */
  docsLayout: string[];
  /** Code-health targets for `.claude/bin/health`, on files changed in the branch. null = report only. */
  slo: { maxFileLines: number | null; newDependencies: number | null };
  /** Project-specific health metrics: the command prints one number; {files} = changed code files. */
  health: HealthMetric[];
  /** The domains Bash may reach inside the OS sandbox; seeded from detection, read by `update`. */
  sandbox: { allowedDomains: string[] };
  /** Which model and effort each task runs on; the default is `templates/claude/_routing.json`. */
  routing: Record<string, unknown>;
}

export interface HealthMetric {
  name: string;
  command: string;
  max: number | null;
}

export interface LayerRule {
  name: string;
  /** Case-globs of the layer's files. */
  files: string[];
  /** ERE patterns an import line in those files must not match. */
  forbid: string[];
  /** The ADR that decided the boundary. */
  adr?: string;
}

// Union across stacks on purpose: a pattern for another language costs nothing and keeps the
// guard stack-agnostic. POSIX ERE only (no \b) — must behave the same in BSD and GNU grep.
export const CHEAT_PATTERNS = [
  // Skip marks come from the one list shared with the frozen-tests count (0.4.5).
  ...SKIP_MARKS.map((m) => m.ere),
  "@ts-ignore",
  "@ts-nocheck",
  "eslint-disable",
  "biome-ignore",
  "(:|[[:space:]]as)[[:space:]]*any([^A-Za-z0-9_]|$)",
  "#[[:space:]]*type:[[:space:]]*ignore",
  "#[[:space:]]*noqa",
  "//[[:space:]]*nolint",
];

export const INSTALL_PATTERNS = [
  // flags may come first: `pnpm add -D vitest`, `npm i --save x`; a flag stops at a shell operator, so
  // `pnpm i --frozen-lockfile; pnpm test` is no package. A bare `pnpm install` is guard-bash's own check.
  "(pnpm|npm|yarn|bun)[[:space:]]+(add|install|i)([[:space:]]+-[^[:space:];&|<>()]+)*[[:space:]]+[^-[:space:];&|<>()]",
  "(pip|pip3|pipx)[[:space:]]+install",
  "uv[[:space:]]+(add|pip[[:space:]]+install|tool[[:space:]]+install)",
  "poetry[[:space:]]+add",
  "brew[[:space:]]+(install|upgrade|tap)",
  "cargo[[:space:]]+(add|install)",
  "go[[:space:]]+(get|install)",
  "gem[[:space:]]+install",
  "apt(-get)?[[:space:]]+install",
  "claude[[:space:]]+(plugin|mcp)[[:space:]]+(install|add)",
];

/**
 * The default doc layout for a monorepo (api + web + contracts): project docs — specs, ADRs, guides —
 * under the docs dir, a README in each app or package (any depth: `*` matches `/`), package
 * CHANGELOGs, plus the harness and forge folders. A project
 * that keeps docs elsewhere changes `docsLayout` and records why in an ADR.
 */
export function monorepoDocsLayout(docsDir: string): string[] {
  return [`${docsDir}*`, "apps/*/README.md", "packages/*/README.md", "packages/*/CHANGELOG.md", ".claude/*", ".github/*"];
}

/** Default `stagePattern`: the stage id is the leading letters+digits of the branch's last segment. */
export const DEFAULT_STAGE_PATTERN = "^([A-Za-z]+[0-9]+)([-_.]|$)";

/** `routing` is the default routing the caller read (and checked) from `_routing.json`. */
export function buildGatesConfig(p: HarnessParams, routing: Record<string, unknown>): GatesConfig {
  const generated = p.generatedGlobs ? p.generatedGlobs.split("|") : [];
  return {
    mode: "interactive",
    baseBranch: p.mainBranch,
    specsDir: `${p.docsDir}specs`,
    stagePattern: DEFAULT_STAGE_PATTERN,
    adrDir: `${p.docsDir}adr`,
    specGate: "strict",
    openPaths: [`${p.docsDir}*`, "*.md", ".claude/*", ".gitignore"],
    protectedGlobs: [...generated, ...(p.lockfile ? [`*${p.lockfile}`] : [])],
    packageManager: p.packageManager,
    forbiddenPackageManagers: p.forbiddenPms ? p.forbiddenPms.split("|") : [],
    installPatterns: INSTALL_PATTERNS,
    cheatGuard: true,
    cheatPatterns: CHEAT_PATTERNS,
    commands: { test: p.testCommand, lint: p.lintCommand },
    lintMatch: p.lintMatch ? p.lintMatch.split("|") : [],
    testGlobs: p.testGlobs ? p.testGlobs.split("|") : [],
    // Boundaries are a decision, not a detection: empty until an ADR sets them.
    layers: [],
    docsLayout: p.monorepo ? monorepoDocsLayout(p.docsDir) : [],
    slo: { maxFileLines: 400, newDependencies: null },
    health: p.complexityCommand
      ? [{ name: "complexity", command: p.complexityCommand, max: 0 }]
      : [],
    sandbox: { allowedDomains: detectedDomains(p.packageManager, p.forgeCli) },
    routing,
  };
}
