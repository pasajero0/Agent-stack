import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderAdapter, ProviderInfo } from "./types.js";
import type { McpServerDefinition, McpServerConfig } from "../mcp/types.js";
import { commandExists, run, runSilent } from "../utils/shell.js";
import { log } from "../utils/logger.js";

export class ClaudeCodeAdapter implements ProviderAdapter {
  id = "claude-code";
  displayName = "Claude Code";

  async detect(): Promise<ProviderInfo> {
    const home = homedir();
    const configPaths = [
      join(home, ".claude"),
      join(home, ".config", "claude"),
    ];

    const installed = await commandExists("claude");
    let version: string | undefined;

    if (installed) {
      const result = await runSilent("claude", ["--version"]);
      if (result.exitCode === 0) {
        version = result.stdout.trim();
      }
    }

    return {
      name: this.id,
      displayName: this.displayName,
      installed,
      version,
      configPaths: configPaths.filter((p) => existsSync(p)),
    };
  }

  async install(): Promise<void> {
    log.step("Installing Claude Code via npm...");
    const result = await run("npm", ["install", "-g", "@anthropic-ai/claude-code"]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to install Claude Code: ${result.stderr}`);
    }
    log.success("Claude Code installed successfully");
  }

  async configureMcp(
    servers: McpServerDefinition[],
    envValues: Record<string, string>
  ): Promise<void> {
    for (const server of servers) {
      const args = ["mcp", "add", server.name, "--transport", server.transport];

      if (server.command) {
        args.push("--", server.command);
      }
      if (server.args) {
        args.push(...server.args);
      }

      const env: Record<string, string> = {};
      if (server.env) {
        for (const key of Object.keys(server.env)) {
          if (envValues[key]) {
            env[key] = envValues[key];
          }
        }
      }

      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(env)) {
        envArgs.push("-e", `${key}=${value}`);
      }

      const fullArgs = [...args, ...envArgs];
      const result = await run("claude", fullArgs);
      if (result.exitCode !== 0) {
        log.warn(`Failed to add MCP server "${server.name}": ${result.stderr}`);
      } else {
        log.success(`MCP server "${server.displayName}" configured`);
      }
    }
  }

  async removeMcp(serverName: string): Promise<void> {
    const result = await run("claude", ["mcp", "remove", serverName]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to remove MCP server "${serverName}": ${result.stderr}`);
    }
  }

  async listMcp(): Promise<McpServerConfig[]> {
    const result = await runSilent("claude", ["mcp", "list"]);
    if (result.exitCode !== 0) {
      return [];
    }

    const lines = result.stdout.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      const parts = line.split(/\s+/);
      return {
        name: parts[0] ?? line,
        command: parts[1] ?? "",
        args: parts.slice(2),
      };
    });
  }
}
