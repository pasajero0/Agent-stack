/** The gate:limit card's prompt text and answers; a new attempt names the retry route (effort1 AC-11, AC-20). */
import { parseRoute, type Routing } from "../routing.js";
import type { CardAnswer } from "../types.js";
import { A } from "./card.js";

export function limitPrompt(reason: string, routing: Routing): { text: string; answers: CardAnswer[] } {
  const r = parseRoute(routing.retry);
  const attempt = r ? `a new attempt, ${r.model} · ${r.effort}` : "a new attempt";
  switch (reason) {
    case "fuse":
      return { text: "raise the fuse for this run (in its own unit, above what is used), or cancel", answers: [{ key: "f", follows: "number", label: "new limit" }, A.cancel] };
    case "decision":
      return { text: "answer the role's questions", answers: [{ key: "r", follows: "text", label: "retry with your answer (the role gets it)" }, A.cancel] };
    case "tests-changed":
      return {
        text: "allow these test changes, or send the task back",
        answers: [{ key: "a", follows: null, label: "allow exactly these (the checks run next)" }, { key: "r", follows: "text", label: `retry with a comment (${attempt})` }, A.cancel],
      };
    case "test-conflict":
      return {
        text: "fix the test or the spec by hand if needed, then answer the implementer",
        answers: [{ key: "r", follows: "text", label: "retry with your answer for the implementer (no attempt is counted)" }, A.cancel],
      };
    default:
      return { text: "retry or cancel", answers: [{ key: "r", follows: null, label: `retry (${attempt})` }, A.cancel] };
  }
}

export const limitAnswers = (reason: string, routing: Routing): CardAnswer[] => limitPrompt(reason, routing).answers;
