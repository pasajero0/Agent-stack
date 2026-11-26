import { describe, it, expect } from "vitest";
import { buildHarnessFiles } from "../../src/claude/harness.js";
import { buildSandboxBlock, detectedDomains, SECRET_FOLDERS } from "../../src/claude/sandbox.js";
import type { HarnessParams } from "../../src/detect/harness-params.js";
import { TS_PARAMS } from "../hooks/fixture.js";

// The Contract's secret folders, in order (docs/specs/sandbox1/SPEC.md).
const SECRETS = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.kube",
  "~/.docker",
  "~/.netrc",
  "~/.npmrc",
  "~/.config/gcloud",
  "~/.azure",
  "~/.config/gh",
];

// The Contract block for a pnpm repo with a GitHub remote, as it stands inside settings.json.
const CONTRACT_BLOCK = `  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "failIfUnavailable": true,
    "filesystem": {
      "denyRead": [
        "~/.ssh",
        "~/.aws",
        "~/.gnupg",
        "~/.kube",
        "~/.docker",
        "~/.netrc",
        "~/.npmrc",
        "~/.config/gcloud",
        "~/.azure",
        "~/.config/gh"
      ],
      "denyWrite": [
        "./.claude/gates.json",
        "./.claude/bin",
        "./CLAUDE.md"
      ],
      "allowWrite": [
        "~/Library/pnpm/store",
        "~/Library/Caches/pnpm",
        "~/.local/share/pnpm/store",
        "~/.cache/pnpm"
      ]
    },
    "network": {
      "allowedDomains": [
        "registry.npmjs.org",
        "github.com",
        "api.github.com"
      ]
    }
  },`;

const content = (params: HarnessParams, path: string): string =>
  buildHarnessFiles(params).find((f) => f.path === path)!.content;

/** The lines from `  "sandbox": {` to its closing `  },`. */
function sandboxLines(settings: string): string[] {
  const lines = settings.split("\n");
  const start = lines.indexOf('  "sandbox": {');
  const end = lines.indexOf("  },", start);
  return start < 0 || end < 0 ? [] : lines.slice(start, end + 1);
}

describe("sandbox1: the generated sandbox block", () => {
  it("sandbox1 AC-1: settings.json holds the exact 37-line Contract block for pnpm + gh", () => {
    const lines = sandboxLines(content(TS_PARAMS, ".claude/settings.json"));
    expect(lines).toHaveLength(37);
    expect(lines.join("\n")).toBe(CONTRACT_BLOCK);
  });

  it("sandbox1 AC-1: sandbox sits between permissions and hooks, keys in the Contract order", () => {
    const s = JSON.parse(content(TS_PARAMS, ".claude/settings.json"));
    expect(Object.keys(s)).toEqual(["$schema", "permissions", "sandbox", "hooks"]);
    expect(Object.keys(s.sandbox)).toEqual([
      "enabled",
      "allowUnsandboxedCommands",
      "failIfUnavailable",
      "filesystem",
      "network",
    ]);
    expect(Object.keys(s.sandbox.filesystem)).toEqual(["denyRead", "denyWrite", "allowWrite"]);
    expect(Object.keys(s.sandbox.network)).toEqual(["allowedDomains"]);
    expect(s.sandbox.filesystem.denyRead).toEqual(SECRETS);
    expect(s.sandbox.network.allowedDomains).toEqual(detectedDomains("pnpm", "gh"));
  });

  it("sandbox1 AC-1: the secret folders and the block builder follow the Contract", () => {
    expect([...SECRET_FOLDERS]).toEqual(SECRETS);
    expect(buildSandboxBlock(["a.com"])).toEqual({
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { denyRead: SECRETS, denyWrite: ["./.claude/gates.json", "./.claude/bin", "./CLAUDE.md"] },
      network: { allowedDomains: ["a.com"] },
    });
  });

  it("Q1: the built block and generate hold ~/.config/gh as the last denyRead entry", () => {
    expect(buildSandboxBlock([]).filesystem.denyRead.at(-1)).toBe("~/.config/gh");
    const s = JSON.parse(content(TS_PARAMS, ".claude/settings.json"));
    expect(s.sandbox.filesystem.denyRead.at(-1)).toBe("~/.config/gh");
    const m = JSON.parse(content(TS_PARAMS, ".claude/.harness.json"));
    expect(m.generatedSandbox.denyRead.at(-1)).toBe("~/.config/gh");
  });

  it("sandbox1 AC-2: gates.json has sandbox.allowedDomains right before routing", () => {
    const g = JSON.parse(content(TS_PARAMS, ".claude/gates.json"));
    const keys = Object.keys(g);
    expect(keys.slice(-2)).toEqual(["sandbox", "routing"]);
    expect(g.sandbox).toEqual({ allowedDomains: ["registry.npmjs.org", "github.com", "api.github.com"] });
  });

  it("sandbox1 AC-2: the manifest records generatedSandbox with the same lists", () => {
    const m = JSON.parse(content(TS_PARAMS, ".claude/.harness.json"));
    expect(m.generatedSandbox).toEqual({
      denyRead: SECRETS,
      denyWrite: ["./.claude/gates.json", "./.claude/bin", "./CLAUDE.md"],
      allowedDomains: ["registry.npmjs.org", "github.com", "api.github.com"],
      allowWrite: ["~/Library/pnpm/store", "~/Library/Caches/pnpm", "~/.local/share/pnpm/store", "~/.cache/pnpm"],
    });
    expect(Object.keys(m.generatedSandbox)).toEqual(["denyRead", "denyWrite", "allowedDomains", "allowWrite"]);
    expect(Array.isArray(m.generatedAllow)).toBe(true); // the old field stays
  });
});

describe("sandbox1: the detected domain list", () => {
  const npm = ["registry.npmjs.org"];
  const py = ["pypi.org", "files.pythonhosted.org"];
  const gh = ["github.com", "api.github.com"];
  const rows: Array<[string, string[]]> = [
    ["pnpm", npm],
    ["npm", npm],
    ["bun", npm],
    ["yarn", ["registry.yarnpkg.com"]],
    ["uv", py],
    ["poetry", py],
    ["pipenv", py],
    ["pip", py],
    ["go", ["proxy.golang.org", "sum.golang.org"]],
    ["cargo", ["index.crates.io", "static.crates.io"]],
    ["", []],
    ["maven", []],
    ["constructor", []],
  ];

  for (const [pm, registry] of rows) {
    it(`sandbox1 AC-3: ${pm || '""'} + gh → registry then GitHub domains`, () => {
      expect(detectedDomains(pm, "gh")).toEqual([...registry, ...gh]);
    });
    it(`sandbox1 AC-3: ${pm || '""'} + glab → registry domains only`, () => {
      expect(detectedDomains(pm, "glab")).toEqual(registry);
    });
  }

  it("sandbox1 AC-3: the spec's examples", () => {
    expect(detectedDomains("pnpm", "gh")).toEqual(["registry.npmjs.org", "github.com", "api.github.com"]);
    expect(detectedDomains("uv", "glab")).toEqual(["pypi.org", "files.pythonhosted.org"]);
  });

  it("sandbox1 AC-3: generate uses the detected list for a uv + glab repo", () => {
    const params: HarnessParams = { ...TS_PARAMS, packageManager: "uv", forgeCli: "glab" };
    const s = JSON.parse(content(params, ".claude/settings.json"));
    expect(s.sandbox.network.allowedDomains).toEqual(py);
    expect(JSON.parse(content(params, ".claude/gates.json")).sandbox.allowedDomains).toEqual(py);
  });

  it('sandbox1 AC-20: packageManager "" + glab → allowedDomains [] in settings.json and gates.json', () => {
    const params: HarnessParams = { ...TS_PARAMS, packageManager: "", forgeCli: "glab" };
    const s = JSON.parse(content(params, ".claude/settings.json"));
    expect(s.sandbox.network.allowedDomains).toEqual([]);
    expect(s.sandbox.filesystem.denyRead).toEqual(SECRETS);
    const g = JSON.parse(content(params, ".claude/gates.json"));
    expect(g.sandbox).toEqual({ allowedDomains: [] });
    expect(JSON.parse(content(params, ".claude/.harness.json")).generatedSandbox.allowedDomains).toEqual([]);
  });
});
