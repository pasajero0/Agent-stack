import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommand } from "../../src/commands/generate.js";
import { updateCommand } from "../../src/commands/update.js";
import { pinPlatform } from "./pin-platform.js";

pinPlatform();

const ROOT = join(__dirname, "..", "..");
const dirs: string[] = [];
let project: string;

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "drive1-evidence-"));
  dirs.push(project);
  vi.spyOn(process, "cwd").mockReturnValue(project);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await generateCommand();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe("drive1 evidence-gate is removed", () => {
  it("drive1 AC-8: the Stop hooks are exactly stop-flag-reflect; no evidence-gate is written", () => {
    const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf-8"));
    const commands = (settings.hooks.Stop as { hooks: { command: string }[] }[]).flatMap((e) =>
      e.hooks.map((h) => h.command)
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("stop-flag-reflect.sh");
    expect(existsSync(join(project, ".claude", "hooks", "evidence-gate.sh"))).toBe(false);
    expect(existsSync(join(ROOT, "templates", "claude", "hooks", "evidence-gate.sh"))).toBe(false);
  });

  it("drive1 AC-8: gates.json has no evidenceGate", () => {
    const gates = JSON.parse(readFileSync(join(project, ".claude", "gates.json"), "utf-8"));
    expect(gates).not.toHaveProperty("evidenceGate");
  });

  it("drive1 AC-12: update keeps an existing evidenceGate key", async () => {
    const path = join(project, ".claude", "gates.json");
    const gates = JSON.parse(readFileSync(path, "utf-8"));
    gates.evidenceGate = false;
    writeFileSync(path, JSON.stringify(gates, null, 2) + "\n");
    await updateCommand();
    expect(JSON.parse(readFileSync(path, "utf-8")).evidenceGate).toBe(false);
  });

  it("drive1 AC-12: no hook, bin script or src code reads evidenceGate", () => {
    const roots = [
      join(ROOT, "src"),
      join(ROOT, "templates", "claude", "hooks"),
      join(ROOT, "templates", "claude", "bin"),
    ];
    for (const root of roots) {
      for (const f of filesUnder(root)) {
        expect(readFileSync(f, "utf-8"), f).not.toMatch(/evidenceGate/);
      }
    }
  });
});
