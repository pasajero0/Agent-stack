import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolVersion } from "../../src/claude/harness.js";
import { commandName, HARNESS_FLOOR, requireHarness } from "../../src/run/engine/command.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp folder with a cli.mjs, and a bin folder for PATH. */
function layout(name = "pkg"): { cli: string; bin: string } {
  // The real path: macOS's tmpdir is a symlink (/var → /private/var), and the name follows symlinks.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "as-cmd-")));
  dirs.push(root);
  const pkg = join(root, name);
  mkdirSync(join(pkg, "bin"), { recursive: true });
  const cli = join(pkg, "bin", "cli.mjs");
  writeFileSync(cli, "");
  const bin = join(root, "path-bin");
  mkdirSync(bin);
  return { cli, bin };
}

describe("command name (AC-73)", () => {
  it("v04 AC-73: agent-stack when the one on PATH is the running cli.mjs through a symlink", () => {
    const { cli, bin } = layout();
    symlinkSync(cli, join(bin, "agent-stack"));
    chmodSync(cli, 0o755);
    expect(commandName(["node", cli], { PATH: bin })).toBe("agent-stack");
  });

  it("v04 AC-73: agent-stack when a shim on PATH prints the same version, node <path> when it does not", () => {
    const { cli, bin } = layout();
    const shim = join(bin, "agent-stack");
    writeFileSync(shim, `#!/bin/sh\necho ${toolVersion()}\n`);
    chmodSync(shim, 0o755);
    expect(commandName(["node", cli], { PATH: bin })).toBe("agent-stack");
    writeFileSync(shim, "#!/bin/sh\necho 0.0.1\n");
    expect(commandName(["node", cli], { PATH: bin })).toBe(`node ${cli}`);
  });

  it("v04 AC-73: node <path> with nothing on PATH, and a path with a space is quoted", () => {
    const { cli } = layout("my pkg");
    expect(commandName(["node", cli], { PATH: "" })).toBe(`node '${cli}'`);
  });

  it("v04 AC-73: agent-stack when the driver does not run from cli.mjs (tests, an import)", () => {
    expect(commandName(["node", "/x/vitest.mjs"], { PATH: "" })).toBe("agent-stack");
  });
});

describe("harness floor (AC-72)", () => {
  function project(manifest: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "as-floor-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".claude"));
    if (manifest !== null) writeFileSync(join(dir, ".claude", ".harness.json"), manifest);
    return dir;
  }

  it("v04 AC-72: a harness at or above the floor passes; numbers compare part by part", () => {
    expect(() => requireHarness(project(JSON.stringify({ templateVersion: HARNESS_FLOOR })))).not.toThrow();
    expect(() => requireHarness(project(JSON.stringify({ templateVersion: "0.10.0" })))).not.toThrow();
  });

  it("v04 AC-72: an older harness is refused with code 1 and the update hint", () => {
    expect(() => requireHarness(project(JSON.stringify({ templateVersion: "0.4.0" })))).toThrow(
      /The harness is 0\.4\.0; this driver needs 0\.4\.1 or later: run agent-stack update, then commit \.claude\//
    );
  });

  it.each([null, "{ not json", JSON.stringify({}), JSON.stringify({ templateVersion: "0.4" })])(
    "v04 AC-72: a missing or unreadable version counts as missing: %s",
    (m) => {
      expect(() => requireHarness(project(m))).toThrow(/The harness is missing; this driver needs/);
    }
  );
});
