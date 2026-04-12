import type { McpServerDefinition, McpServerConfig } from "../mcp/types.js";
import type { AgentDefinition } from "../agents/types.js";

export interface ProviderInfo {
  name: string;
  displayName: string;
  installed: boolean;
  version?: string;
  configPaths: string[];
}

export interface GeneratedFile {
  path: string;
  content: string;
  action: "create" | "overwrite" | "merge";
}

export interface ProviderAdapter {
  id: string;
  displayName: string;

  detect(): Promise<ProviderInfo>;
  install(): Promise<void>;

  configureMcp(servers: McpServerDefinition[], envValues: Record<string, string>): Promise<void>;
  removeMcp(serverName: string): Promise<void>;
  listMcp(): Promise<McpServerConfig[]>;

  generateAgentConfig(
    agents: AgentDefinition[],
    projectDir: string
  ): Promise<GeneratedFile[]>;
}
