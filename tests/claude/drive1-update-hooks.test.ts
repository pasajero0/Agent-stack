import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateCommand } from "../../src/commands/generate.js";
import { updateCommand } from "../../src/commands/update.js";
import { pinPlatform } from "./pin-platform.js";

pinPlatform();

const dirs: string[] = [];
let project: string;
let out: string[];

const GATE = ".claude/hooks/evidence-gate.sh";
const VERIFY = ".claude/hooks/post-edit-verify.sh";
const PARTS = [
  GATE,
  ".claude/agents/test-writer.md",
  ".claude/agents/task-analyzer.md",
  ".claude/skills/ci-testing-patterns.md",
  ".claude/skills/repo-structure.md",
  ".claude/skills/team-conventions.md",
];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "drive1-update-hooks-"));
  dirs.push(project);
  out = [];
  vi.spyOn(process, "cwd").mockReturnValue(project);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  await generateCommand();
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out.push(a.join(" ").replace(ANSI, ""));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const read = (p: string) => readFileSync(join(project, p), "utf-8");
const put = (p: string, s: string) => {
  mkdirSync(dirname(join(project, p)), { recursive: true });
  writeFileSync(join(project, p), s);
};

/** Make the repo look like an earlier version deployed it. */
function deployOld(opts: { hashes: boolean; retired: string[]; listed?: string[]; userStop?: boolean }) {
  const manifest = JSON.parse(read(".claude/.harness.json"));
  for (const p of PARTS) {
    put(p, `old ${p}\n`);
    if (opts.hashes && (opts.listed ?? PARTS).includes(p)) manifest.files[p] = sha(`old ${p}\n`);
  }
  if (!opts.hashes) delete manifest.files;
  put(".claude/.harness.json", JSON.stringify(manifest, null, 2) + "\n");
  const settings = JSON.parse(read(".claude/settings.json"));
  const hook = (h: string) => ({ type: "command", command: `"$CLAUDE_PROJECT_DIR"/.claude/hooks/${h}` });
  if (opts.retired.includes(GATE)) settings.hooks.Stop.push({ hooks: [hook("evidence-gate.sh")] });
  if (opts.retired.includes(VERIFY)) settings.hooks.PostToolUse.push({ hooks: [hook("post-edit-verify.sh")] });
  if (opts.userStop) settings.hooks.Stop.push({ hooks: [{ type: "command", command: "my-stop.sh" }] });
  put(".claude/settings.json", JSON.stringify(settings, null, 2) + "\n");
}

const stopCommands = () =>
  (JSON.parse(read(".claude/settings.json")).hooks.Stop as { hooks: { command: string }[] }[]).flatMap((e) =>
    e.hooks.map((h) => h.command)
  );
const gateLines = () => out.filter((l) => l.includes("evidence-gate.sh"));
const DROPPED = "  dropped evidence-gate.sh from settings.json — no longer part of the harness";

describe("drive1 update retired-hook line", () => {
  it("drive1 AC-9: unchanged removed files are deleted, Stop entries kept, no delete clause", async () => {
    deployOld({ hashes: true, retired: [GATE], userStop: true });
    await updateCommand();
    const cmds = stopCommands();
    expect(cmds.some((c) => c.includes("evidence-gate.sh"))).toBe(false);
    expect(cmds.some((c) => c.includes("stop-flag-reflect.sh"))).toBe(true);
    expect(cmds).toContain("my-stop.sh");
    for (const p of PARTS) expect(existsSync(join(project, p)), p).toBe(false);
    expect(out.filter((l) => l.includes("dropped evidence-gate.sh"))).toEqual([DROPPED]);
  });

  it("drive1 AC-10: a changed evidence-gate.sh and parts are kept; the delete is named once", async () => {
    deployOld({ hashes: true, retired: [GATE] });
    for (const p of PARTS) put(p, `changed ${p}\n`);
    await updateCommand();
    for (const p of PARTS) expect(existsSync(join(project, p)), p).toBe(true);
    expect(gateLines()).toEqual([
      DROPPED,
      `  left ${GATE} — no longer part of the harness, but you changed it; delete it if unused`,
    ]);
    expect(out.filter((l) => l.includes(`delete ${GATE}`))).toHaveLength(0);
  });

  it("drive1 AC-11: without hashes and the file there, the line asks to delete it; the file stays", async () => {
    deployOld({ hashes: false, retired: [GATE] });
    await updateCommand();
    expect(existsSync(join(project, GATE))).toBe(true);
    expect(gateLines()).toEqual([`${DROPPED}; delete ${GATE}`]);
  });

  it("drive1 AC-11: hashes that do not list evidence-gate.sh give the same line", async () => {
    deployOld({ hashes: true, retired: [GATE], listed: [] });
    await updateCommand();
    expect(existsSync(join(project, GATE))).toBe(true);
    expect(gateLines()).toEqual([`${DROPPED}; delete ${GATE}`]);
  });

  it("drive1 AC-11: without hashes and without the file, no delete clause", async () => {
    deployOld({ hashes: false, retired: [GATE] });
    rmSync(join(project, GATE));
    await updateCommand();
    expect(gateLines()).toEqual([DROPPED]);
  });

  it("drive1 AC-31: both retired hooks are dropped, one line each", async () => {
    deployOld({ hashes: false, retired: [GATE, VERIFY] });
    put(VERIFY, "old\n");
    rmSync(join(project, GATE));
    await updateCommand();
    const settings = read(".claude/settings.json");
    expect(settings).not.toContain("evidence-gate.sh");
    expect(settings).not.toContain("post-edit-verify.sh");
    const dropped = out.filter((l) => l.includes("dropped "));
    expect(dropped).toHaveLength(2);
    expect(dropped).toContain(DROPPED);
    expect(dropped).toContain(
      `  dropped post-edit-verify.sh from settings.json — no longer part of the harness; delete ${VERIFY}`
    );
  });
});
