import { join, dirname } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ProviderAdapter, GeneratedFile } from "../providers/types.js";
import type { AgentDefinition } from "./types.js";
import { log } from "../utils/logger.js";

export async function generateConfigs(
  adapters: ProviderAdapter[],
  agents: AgentDefinition[],
  projectDir: string
): Promise<GeneratedFile[]> {
  const allFiles: GeneratedFile[] = [];

  for (const adapter of adapters) {
    const files = await adapter.generateAgentConfig(agents, projectDir);
    allFiles.push(...files);
  }

  return allFiles;
}

export async function writeGeneratedFiles(
  files: GeneratedFile[],
  projectDir: string
): Promise<void> {
  for (const file of files) {
    const fullPath = join(projectDir, file.path);
    const dir = dirname(fullPath);

    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(fullPath, file.content, "utf-8");
    const action = file.action === "create" ? "Created" : "Updated";
    log.success(`${action}: ${file.path}`);
  }
}
