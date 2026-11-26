import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "defect-causes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("defect-causes CLI", () => {
  it("causes1 AC-9: spawned --check with a failing cause exits 1", () => {
    const file = join(dir, "defects.md");
    writeFileSync(
      file,
      "| # | Date | Cause | Test |\n|---|---|---|---|\n| 1 | d | c | — |\n| 2 | d | c | — |\n| 3 | d | c | — |\n",
    );
    const r = spawnSync("node", ["scripts/defect-causes.mjs", "--check", "--file", file], { encoding: "utf8", timeout: 15_000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("cause");
    expect(r.stderr).toBe("defect-causes: c has 3 rows and no test or planned check (rows 1,2,3)\n");
  });
});
