/**
 * The routing block of `.claude/gates.json`: which model and effort a task runs on. The default values live in
 * `templates/claude/_routing.json` only — no route value is written in this file.
 */

const MID = "·"; // U+00B7 MIDDLE DOT, the separator inside a route and a cell name

export const TIERS = ["S", "M", "L"] as const;
export const COMPLEXITIES = ["low", "medium", "high"] as const;
export type Tier = (typeof TIERS)[number];
export type Complexity = (typeof COMPLEXITIES)[number];

/** The 9 cell names, `S·low` … `L·high`. */
export const CELLS: readonly string[] = TIERS.flatMap((t) => COMPLEXITIES.map((c) => `${t}${MID}${c}`));

/** One of the 9 cell names → its tier and complexity; null for anything else (effort1 AC-28). */
export function parseCell(value: unknown): { tier: Tier; complexity: Complexity } | null {
  for (const tier of TIERS) {
    for (const complexity of COMPLEXITIES) {
      if (value === `${tier}${MID}${complexity}`) return { tier, complexity };
    }
  }
  return null;
}

export interface Route {
  model: "opus" | "sonnet" | "haiku";
  effort: string;
}

/** A routing that passed `checkRouting`: every value is a route string. */
export type Routing = Record<Tier, Record<Complexity, string>> & { retry: string; risky: string; scout: string };

const ROUTE_PATTERN = /^(opus|sonnet|haiku)·(low|medium|high|xhigh|max)$/;

/** "<model>·<effort>" → {model, effort}; null if the value breaks the route pattern. */
export function parseRoute(value: unknown): Route | null {
  if (typeof value !== "string") return null;
  const m = ROUTE_PATTERN.exec(value);
  // ROUTE_PATTERN limits group 1 to the three models.
  return m ? { model: m[1] as Route["model"], effort: m[2]! } : null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** JSON.stringify, then U+007F–U+009F shown as `?`, so a value cannot fake a line. */
export function show(v: unknown): string {
  return (JSON.stringify(v) ?? String(v)).replace(/[\u007f-\u009f]/g, "?");
}

const ROUTE_HINT = `"<model>${MID}<effort>"`;

function routeProblem(path: string, o: Record<string, unknown>, key: string): string | null {
  if (!has(o, key)) return `gates.json routing.${path} is missing. Add it as ${ROUTE_HINT}.`;
  if (parseRoute(o[key])) return null;
  return (
    `gates.json routing.${path} must be ${ROUTE_HINT} (model opus, sonnet or haiku; ` +
    `effort low, medium, high, xhigh or max); got ${show(o[key])}.`
  );
}

/**
 * Every problem of a routing value, one line each, in the Contract's order: cells, retry, risky, unknown keys
 * of routing, unknown keys of S, M, L. `undefined` means the gates.json has no routing key. Empty = valid.
 */
export function checkRouting(value: unknown, cmd = "agent-stack"): string[] {
  if (value === undefined) {
    return [`gates.json has no routing block. Run ${cmd} update to add it (CHANGELOG: Upgrading from 0.4.7).`];
  }
  if (!isObject(value)) {
    return [`gates.json routing must be an object; got ${show(value)}. Fix it, or remove the key and run ${cmd} update.`];
  }
  const lines: string[] = [];
  for (const t of TIERS) {
    if (!has(value, t)) {
      lines.push(`gates.json routing.${t} is missing. Add it as an object with low, medium and high.`);
      continue;
    }
    const tier = value[t];
    if (!isObject(tier)) {
      lines.push(`gates.json routing.${t} must be an object with low, medium and high; got ${show(tier)}.`);
      continue;
    }
    for (const c of COMPLEXITIES) {
      const p = routeProblem(`${t}.${c}`, tier, c);
      if (p) lines.push(p);
    }
  }
  for (const k of ["retry", "risky", "scout"]) {
    if (k === "scout" && !has(value, k)) {
      lines.push(`gates.json routing.scout is missing. Run ${cmd} update to add it (CHANGELOG: Upgrading from 0.4.7).`);
      continue;
    }
    const p = routeProblem(k, value, k);
    if (p) lines.push(p);
  }
  const top = new Set<string>([...TIERS, "retry", "risky", "scout"]);
  for (const k of Object.keys(value)) {
    if (!top.has(k)) lines.push(`gates.json routing.${show(k)} is not a routing key; remove it.`);
  }
  const inner = new Set<string>(COMPLEXITIES);
  for (const t of TIERS) {
    const tier = value[t];
    if (!isObject(tier)) continue;
    for (const k of Object.keys(tier)) {
      if (!inner.has(k)) lines.push(`gates.json routing.${t}.${show(k)} is not a routing key; remove it.`);
    }
  }
  return lines;
}
