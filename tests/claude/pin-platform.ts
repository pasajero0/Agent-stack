import { afterAll, beforeAll } from "vitest";

/**
 * Pins `process.platform` for a test file. `generate` and `update` read it for the sandbox tools check
 * (`missingSandboxTools`): on a Linux machine without `bwrap` or `socat` they print one more warning, so a test
 * that compares the printed warnings must not depend on the machine it runs on. Tests of the check itself pass
 * `platform` and `exists` to the command instead (tests/claude/sandbox-tools.test.ts).
 */
export function pinPlatform(platform: NodeJS.Platform = "darwin"): void {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  beforeAll(() => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  });
  afterAll(() => {
    if (real) Object.defineProperty(process, "platform", real);
  });
}
