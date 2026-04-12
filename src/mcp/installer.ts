import type { ProviderAdapter } from "../providers/types.js";
import type { McpServerDefinition } from "./types.js";
import { spinner } from "../utils/logger.js";

export async function installMcpServers(
  providers: ProviderAdapter[],
  servers: McpServerDefinition[],
  envValues: Record<string, string>
): Promise<void> {
  for (const provider of providers) {
    const s = spinner(
      `Configuring MCP servers for ${provider.displayName}...`
    );
    s.start();

    try {
      await provider.configureMcp(servers, envValues);
      s.succeed(`MCP servers configured for ${provider.displayName}`);
    } catch (err) {
      s.fail(`Failed to configure MCP for ${provider.displayName}`);
      throw err;
    }
  }
}
