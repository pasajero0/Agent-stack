import type { McpServerDefinition } from "./types.js";
import { spinner } from "../utils/logger.js";
import { configureMcp, PROVIDER_NAME } from "../claude/provider.js";

export async function installMcpServers(
  servers: McpServerDefinition[],
  envValues: Record<string, string>
): Promise<void> {
  const s = spinner(`Configuring MCP servers for ${PROVIDER_NAME}...`);
  s.start();

  try {
    await configureMcp(servers, envValues);
    s.succeed(`MCP servers configured for ${PROVIDER_NAME}`);
  } catch (err) {
    s.fail(`Failed to configure MCP for ${PROVIDER_NAME}`);
    throw err;
  }
}
