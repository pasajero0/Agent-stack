import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerDefinition } from "./types.js";

function getPackageRoot(): string {
  // In bundled mode (dist/index.js), go up one level
  // In dev mode (src/mcp/catalog.ts), go up two levels
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // Both cases: find mcp/catalog.json relative to package root
  // dist/ → .. is package root
  // src/mcp/ → ../.. is package root
  const candidates = [
    join(thisDir, "..", "mcp", "catalog.json"),
    join(thisDir, "..", "..", "mcp", "catalog.json"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf-8");
    } catch {
      continue;
    }
  }
  throw new Error("Could not find mcp/catalog.json");
}

const catalogData = JSON.parse(getPackageRoot());

export const MCP_CATALOG: McpServerDefinition[] = catalogData;
