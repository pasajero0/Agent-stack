import type { ProviderAdapter, ProviderInfo } from "./types.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { KiroAdapter } from "./kiro.js";

const adapters: ProviderAdapter[] = [
  new ClaudeCodeAdapter(),
  new KiroAdapter(),
];

export function getAllAdapters(): ProviderAdapter[] {
  return adapters;
}

export function getAdapter(id: string): ProviderAdapter | undefined {
  return adapters.find((a) => a.id === id);
}

export async function detectAll(): Promise<
  Array<{ adapter: ProviderAdapter; info: ProviderInfo }>
> {
  const results = await Promise.all(
    adapters.map(async (adapter) => ({
      adapter,
      info: await adapter.detect(),
    }))
  );
  return results;
}
