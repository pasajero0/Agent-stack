import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
const glossary = readFileSync(new URL("../../docs/GLOSSARY.md", import.meta.url), "utf8");

/** A `## ` section of a Markdown text: from its heading to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + 3);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

const SECRET_FOLDERS = [
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

describe("sandbox1 AC-21: README Limits and Configuration", () => {
  const limits = section(readme, "## Limits");

  it("sandbox1 AC-21: Limits holds the renamed blocklists bullet with its facts", () => {
    expect(limits).toContain("Blocklists for the tools");
    expect(limits).not.toContain("Blocklists, not a sandbox");
    expect(limits).toContain("sed -i");
    expect(limits).toContain("heredoc");
    expect(limits).toContain("regex");
  });

  it("sandbox1 AC-21: Limits holds the OS sandbox (Bash only) bullet with its keywords", () => {
    expect(limits).toContain("OS sandbox (Bash only)");
    for (const word of [
      "allowUnsandboxedCommands",
      "failIfUnavailable",
      "--settings",
      "managed",
      "~/.config/gh",
      "bwrap",
      "socat",
      "guard-file",
      "allowedDomains",
      "excludedCommands",
      "Windows",
      "WSL2",
      "WebFetch",
      "only the listed domains are reached without a question",
    ]) {
      expect(limits, word).toContain(word);
    }
  });

  it("sandbox1 AC-21: Limits names all nine secret folders", () => {
    for (const folder of SECRET_FOLDERS) expect(limits, folder).toContain(folder);
  });

  it("sandbox1 AC-21: Limits shows the managed-settings lock block", () => {
    expect(limits).toContain(
      '{"sandbox": {"enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false}}',
    );
  });

  it("sandbox1 AC-21: the README has neither forbidden phrase", () => {
    expect(readme).not.toContain("turn on Claude Code's `/sandbox`");
    expect(readme).not.toMatch(/cannot (escape|leave|get out of) the sandbox/i);
  });

  it("sandbox1 AC-21: Configuration has a sandbox row", () => {
    const config = section(readme, "## Configuration");
    const row = config.split("\n").find((l) => l.startsWith("| `sandbox` |")) ?? "";
    expect(row).toContain("allowedDomains");
    expect(row).toContain("update");
  });
});

describe("sandbox1 AC-22: CHANGELOG 0.5.0", () => {
  it("sandbox1 AC-22: has a 0.5.0 entry above 0.4.8 with '### Upgrading from 0.4.8'", () => {
    const at050 = changelog.indexOf("## 0.5.0");
    expect(at050).toBeGreaterThan(-1);
    expect(at050).toBeLessThan(changelog.indexOf("## 0.4.8"));
    expect(section(changelog, "## 0.5.0")).toContain("### Upgrading from 0.4.8");
  });

  it("sandbox1 AC-22: the upgrade notes name each point by its key word", () => {
    const up = section(changelog, "## 0.5.0").split("### Upgrading from 0.4.8")[1] ?? "";
    for (const word of [
      "agent-stack update",
      "allowedDomains",
      "bwrap",
      "socat",
      "Windows",
      "SSH",
      "warning",
      "git push",
    ]) {
      expect(up, word).toContain(word);
    }
  });
});

describe("sandbox1 AC-23: glossary terms", () => {
  it("sandbox1 AC-23: Harness parts defines OS sandbox and Sandbox block", () => {
    const parts = section(glossary, "## Harness parts");
    expect(parts).toContain("- **OS sandbox**");
    expect(parts).toContain("- **Sandbox block**");
  });

  it("sandbox1 AC-23: trace --terms sandbox1 passes", () => {
    expect(() =>
      execFileSync(".claude/bin/trace", ["--terms", "sandbox1"], { cwd: root, stdio: "pipe" }),
    ).not.toThrow();
  });
});
