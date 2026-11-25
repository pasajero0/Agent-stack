/**
 * Q1: the scout call has its own caps: 3 minutes and 20 turns, never above the shared limits.
 */
import { describe, expect, it } from "vitest";
import { callLimits } from "../../src/run/engine/call.js";

describe("callLimits (Q1)", () => {
  it("Q1: with the default shared limits the scout gets 3 minutes and 20 turns", () => {
    expect(callLimits({ maxTurns: 60, stepTimeoutMin: 30 }, "scout")).toEqual({ timeoutMs: 180_000, maxTurns: 20 });
  });

  it("Q1: the scout never gets more than the shared limits", () => {
    expect(callLimits({ maxTurns: 10, stepTimeoutMin: 0.005 }, "scout")).toEqual({ timeoutMs: 300, maxTurns: 10 });
  });

  it("Q1: other roles keep the shared limits", () => {
    for (const role of ["clarify", "spec", "plan", "implement", "review"] as const) {
      expect(callLimits({ maxTurns: 60, stepTimeoutMin: 30 }, role)).toEqual({ timeoutMs: 1_800_000, maxTurns: 60 });
    }
  });
});
