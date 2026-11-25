import { describe, it, expect, vi, afterEach } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessFiles } from "../../src/claude/harness.js";
import { generateCommand } from "../../src/commands/generate.js";
import { checkRouting } from "../../src/run/routing.js";
import { TS_PARAMS } from "../hooks/fixture.js";

// The Contract's default routing block (docs/specs/effort1/SPEC.md).
const CONTRACT = {
  S: { low: "sonnet·low", medium: "sonnet·medium", high: "opus·high" },
  M: { low: "sonnet·low", medium: "sonnet·medium", high: "opus·high" },
  L: { low: "sonnet·medium", medium: "opus·medium", high: "opus·high" },
  retry: "opus·high",
  risky: "opus·high",
};

const SHIPPED = join(__dirname, "..", "..", "templates", "claude");
const MSG = "templates/claude/_routing.json is not a valid routing; reinstall agent-stack.";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "routing-default-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("default routing", () => {
  it("effort1 AC-10: a generated gates.json has routing equal to the default", () => {
    const files = buildHarnessFiles(TS_PARAMS);
    const gates = JSON.parse(files.find((f) => f.path === ".claude/gates.json")!.content);
    expect(gates.routing).toEqual(CONTRACT);
    expect(Object.keys(gates).at(-1)).toBe("routing");
    // _routing.json is generator input, not deployed
    expect(files.find((f) => f.path.endsWith("_routing.json"))).toBeUndefined();
  });

  it("effort1 AC-19: the shipped file is valid and equals the Contract's block", () => {
    const shipped = JSON.parse(readFileSync(join(SHIPPED, "_routing.json"), "utf-8"));
    expect(shipped).toEqual(CONTRACT);
    expect(checkRouting(shipped)).toEqual([]);
  });

  it("effort1 AC-19: a broken template file makes generate exit 1 and write nothing", async () => {
    for (const broken of ['{"S": 1', JSON.stringify({ ...CONTRACT, retry: "gpt·high" }), null]) {
      const root = tmp();
      cpSync(SHIPPED, root, { recursive: true });
      if (broken === null) rmSync(join(root, "_routing.json"));
      else writeFileSync(join(root, "_routing.json"), broken);
      const project = tmp();
      vi.spyOn(process, "cwd").mockReturnValue(project);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as never);
      await expect(generateCommand({ templatesDir: root })).rejects.toThrow("exit");
      expect(exit).toHaveBeenCalledWith(1);
      const printed = [...err.mock.calls, ...out.mock.calls].flat().join("\n");
      expect(printed).toContain(MSG);
      expect(readdirSync(project)).toEqual([]);
      expect(existsSync(join(project, ".claude"))).toBe(false);
      vi.restoreAllMocks();
    }
  });
});
