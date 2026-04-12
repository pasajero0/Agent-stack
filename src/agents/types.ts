export interface AgentsConfig {
  version: number;
  project?: string;
  defaults?: {
    model?: string;
    temperature?: number;
  };
  agents: AgentDefinition[];
}

export interface AgentDefinition {
  name: string;
  role?: string;
  providers?: string[];
  systemPrompt?: string;
  rules?: string[];
  hooks?: HookDefinition[];
  subAgents?: string[];
}

export interface HookDefinition {
  event: string;
  command: string;
}
