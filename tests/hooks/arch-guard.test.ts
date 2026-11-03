import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { cleanupProjects, deployHarness, edit, patchGates, runHook, write, writeTool } from "./fixture.js";

afterAll(cleanupProjects);

const LAYERS = [
  {
    name: "domain stays pure",
    files: ["src/domain/*", "app/domain/*"],
    forbid: ["infra/", "infra[.]", "express"],
    adr: "docs/adr/0003-layers.md",
  },
];

function project(): string {
  const dir = deployHarness();
  patchGates(dir, { layers: LAYERS });
  return dir;
}

describe("arch-guard", () => {
  it("blocks a new import across a boundary, and names the rule and the ADR", () => {
    const dir = project();
    const r = runHook(dir, "arch-guard.sh", edit(join(dir, "src/domain/order.ts"), 'import { db } from "../infra/db";', ""));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("domain stays pure");
    expect(r.stderr).toContain("docs/adr/0003-layers.md");
    expect(r.stderr).toContain('import { db } from "../infra/db"');
  });

  it("works on other languages' import lines", () => {
    const dir = project();
    const py = runHook(dir, "arch-guard.sh", writeTool(join(dir, "app/domain/order.py"), "from app.infra.db import session\n"));
    expect(py.code).toBe(2);
    const req = runHook(dir, "arch-guard.sh", edit(join(dir, "src/domain/http.js"), "const app = require('express');", ""));
    expect(req.code).toBe(2);
  });

  it("lets other layers, plain code and existing violations through", () => {
    const dir = project();
    const infra = edit(join(dir, "src/infra/db.ts"), 'import express from "express";', "");
    expect(runHook(dir, "arch-guard.sh", infra).code).toBe(0);
    const prose = edit(join(dir, "src/domain/order.ts"), "// the infra/ layer handles persistence", "");
    expect(runHook(dir, "arch-guard.sh", prose).code).toBe(0);

    write(dir, "src/domain/legacy.ts", 'import { db } from "../infra/db";\nexport const a = 1;\n');
    const keep = edit(
      join(dir, "src/domain/legacy.ts"),
      'import { db } from "../infra/db";\nexport const a = 2;',
      'import { db } from "../infra/db";\nexport const a = 1;'
    );
    expect(runHook(dir, "arch-guard.sh", keep).code).toBe(0);
  });

  it("is silent until layers are configured", () => {
    const dir = deployHarness();
    const r = runHook(dir, "arch-guard.sh", edit(join(dir, "src/domain/order.ts"), 'import "../infra/db";', ""));
    expect(r.code).toBe(0);
  });
});
