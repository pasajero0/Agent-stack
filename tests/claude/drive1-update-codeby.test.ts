import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommand } from "../../src/commands/generate.js";
import { updateCommand } from "../../src/commands/update.js";
import { pinPlatform } from "./pin-platform.js";

pinPlatform();

const dirs: string[] = [];
let project: string;
let out: string[];

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const LINE =
  'gates.json has no codeBy, so only the driver edits code (/drive). To let a chat edit code again, a human adds "codeBy": "anyone" to .claude/gates.json.';
const GATES = ".claude/gates.json";

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "drive1-update-codeby-"));
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

const read = () => readFileSync(join(project, GATES), "utf-8");
const put = (s: string) => writeFileSync(join(project, GATES), s);
const count = () => out.filter((l) => l.includes(`⚠ ${LINE}`)).length;

/** The generated gates.json with `codeBy` set to `value`, or removed when `present` is false. */
function withCodeBy(value: unknown, present = true): string {
  const g = JSON.parse(read()) as Record<string, unknown>;
  if (present) g.codeBy = value;
  else delete g.codeBy;
  return JSON.stringify(g, null, 2) + "\n";
}

describe("drive1 update codeBy line", () => {
  it("drive1 AC-21: a missing codeBy prints the line once and leaves gates.json as it was", async () => {
    put(withCodeBy(undefined, false));
    const before = read();
    await updateCommand();
    expect(count()).toBe(1);
    expect(read()).toBe(before);
  });

  it("drive1 AC-21: null and empty string print the line, in a dry run too", async () => {
    for (const v of [null, ""]) {
      out.length = 0;
      put(withCodeBy(v));
      await updateCommand({ dryRun: true });
      expect(count()).toBe(1);
    }
  });

  it("drive1 AC-21: the line comes before the no-hashes warning", async () => {
    put(withCodeBy(undefined, false));
    const manifest = JSON.parse(readFileSync(join(project, ".claude/.harness.json"), "utf-8"));
    delete manifest.files;
    writeFileSync(join(project, ".claude/.harness.json"), JSON.stringify(manifest, null, 2) + "\n");
    await updateCommand({ dryRun: true });
    const i = out.findIndex((l) => l.includes(LINE));
    const j = out.findIndex((l) => l.includes("predates file hashes"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
  });

  it("drive1 AC-21: update that creates gates.json writes codeBy driver and prints no line", async () => {
    rmSync(join(project, GATES));
    await updateCommand();
    expect(JSON.parse(read()).codeBy).toBe("driver");
    expect(count()).toBe(0);
  });

  it("drive1 AC-22: a codeBy value other than null or empty prints no line", async () => {
    for (const v of ["driver", "anyone", "other", 0, false, {}]) {
      out.length = 0;
      put(withCodeBy(v));
      await updateCommand({ dryRun: true });
      expect(count()).toBe(0);
    }
  });

  it("drive1 AC-22: invalid JSON or a non-object prints no codeBy line", async () => {
    for (const s of ["{ not json", "[]", '"x"', "null"]) {
      out.length = 0;
      put(s);
      await updateCommand({ dryRun: true });
      expect(count()).toBe(0);
    }
  });
});
