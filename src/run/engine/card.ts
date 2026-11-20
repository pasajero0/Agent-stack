/**
 * Gate cards: built once per gate, kept in the run file, printed for a person and given to a program as JSON.
 * Spec: docs/specs/v04/SPEC.md, Term "Gate card", Contract "Gate card", AC-68, AC-70.
 */
import { RunError } from "../errors.js";
import type { CardAnswer, CardGate, CardPrompt, GateCard } from "../types.js";
import type { Ctx } from "./context.js";

/** The longest one-line fact the terminal prints, `…` included (AC-68). */
export const CUT = 100;

/** One sha256 for every source: the plan hash of AC-14 and the card source of AC-68 are the same. */
export { planSha256 as sha256 } from "./plan-file.js";

/** A fact for the terminal: one-line facts longer than CUT are cut, unless kept or multi-line (AC-68). */
function shownFact(fact: string, keep: boolean): string {
  if (keep || fact.includes("\n") || fact.length <= CUT) return fact;
  return `${fact.slice(0, CUT - 1)}…`;
}

const answerText = (a: CardAnswer): string => `${a.key}${a.follows === null ? "" : ` <${a.follows}>`} — ${a.label}`;

/** The card as the terminal shows it (AC-68). */
export function cardText(card: GateCard): string {
  const lines = [`━━ ${card.title} ━━`];
  card.facts.forEach((f, i) => {
    for (const l of shownFact(f, card.keep.includes(i)).split("\n")) lines.push(`  ${l}`);
  });
  const [first] = card.prompts;
  if (card.prompts.length === 1 && first !== undefined) {
    lines.push(`Needed from you: ${first.text}`);
    lines.push(`  ${first.answers.map(answerText).join(" · ")}`);
  } else if (card.prompts.length > 1) {
    lines.push("Needed from you: answer each prompt below. Enter accepts the default shown in [ ], c cancels.");
  }
  return lines.join("\n");
}

export interface CardInput {
  gate: CardGate;
  title: string;
  facts: string[];
  keep?: number[];
  prompts: CardPrompt[];
  source?: string | null;
  hint: string;
}

/**
 * Builds the card of the gate the run is at, keeps it in the run, and prints it (AC-68). Under `--answer` a gate
 * with no kept card (a run from an older driver) was never shown: the answer is refused until it is read.
 */
export function showCard(ctx: Ctx, input: CardInput): GateCard {
  const unseen = ctx.run.card === null || ctx.run.card.gate !== input.gate;
  const card: GateCard = {
    gate: input.gate,
    run: ctx.run.id,
    stage: ctx.run.stage,
    title: input.title,
    facts: input.facts,
    keep: input.keep ?? [],
    prompts: input.prompts,
    source: input.source ?? null,
    hint: input.hint,
  };
  ctx.run.card = card;
  ctx.out(cardText(card));
  if (unseen && ctx.answering) throw new GateChanged(input.hint);
  return card;
}

/** The human decisions as facts, kept whole (AC-32, AC-68). */
export function decisionFacts(ctx: Ctx): string[] {
  return ctx.run.humanDecisions.map((d) => `decision needed: ${d}`);
}

/** Adds facts, marking the ones the terminal never cuts. */
export class Facts {
  readonly list: string[] = [];
  readonly keep: number[] = [];
  add(...lines: string[]): this {
    this.list.push(...lines);
    return this;
  }
  whole(...lines: string[]): this {
    for (const l of lines) {
      this.keep.push(this.list.length);
      this.list.push(l);
    }
    return this;
  }
}

export const A = {
  approve: { key: "a", follows: null, label: "approve" },
  reject: { key: "r", follows: "text", label: "reject (a comment follows)" },
  cancel: { key: "c", follows: null, label: "cancel" },
} as const satisfies Record<string, CardAnswer>;

/**
 * An answer the gate does not take. At a terminal the gate says why and asks again; under `--answer` it is a
 * refusal: nothing of the gate is applied and the run keeps waiting (AC-70).
 */
export function invalid(ctx: Ctx, why: string): void {
  if (ctx.answering) throw new RunError(`${why} The gate keeps waiting; nothing was applied.`, 1);
  ctx.out(why);
}

/**
 * The gate's inputs changed since its card was shown: the card is rebuilt. At a terminal the gate shows it and
 * asks again; under `--answer` the run keeps waiting with the new card and exits 1 (AC-68).
 */
export class GateChanged extends RunError {
  constructor(hint: string) {
    super(`The gate changed since its card was shown; read the card again: ${hint}`, 1);
    this.name = "GateChanged";
  }
}
