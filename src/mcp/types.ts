export interface McpServerDefinition {
  name: string;
  package: string;
  displayName: string;
  description: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  envPrompts?: Record<string, string>;
  optional?: boolean;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}
