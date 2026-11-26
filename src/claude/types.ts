/** Detected Claude Code install info. */
export interface ProviderInfo {
  name: string;
  displayName: string;
  installed: boolean;
  version?: string;
  configPaths: string[];
}

/** A file the harness emitter produces for a target repo. */
export interface GeneratedFile {
  path: string;
  content: string;
  action: "create" | "overwrite" | "merge";
}

/** What `planUpdate` (update-plan.ts) found: what `update` writes, keeps and reports. */
export interface UpdatePlan {
  created: string[];
  changed: string[];
  unchanged: number;
  /** Seed files already on disk — the user's, left untouched. */
  kept: string[];
  /** What `update` actually writes: new files + changed emitter-owned files. */
  toWrite: GeneratedFile[];
  /** The user's own hook entries carried over into the regenerated settings.json. */
  customHooks: string[];
  /** Hooks an earlier version registered and this one dropped (their files stay on disk). */
  retiredHooks: string[];
  /** settings.json on disk was not valid JSON: its custom hooks, if any, could not be carried over. */
  settingsUnreadable: boolean;
  /** The user's own settings.json keys and permission entries carried over (variant A2). */
  customSettings: string[];
  /** Harness files the user changed since they were deployed: left as they are (`--force` overwrites). */
  edited: string[];
  /** Harness files no longer shipped, untouched since deployment: `update` deletes them. */
  removed: string[];
  /** Harness files no longer shipped but changed by the user: left in place. */
  orphaned: string[];
  /** The manifest predates file hashes (≤ 0.2): edits cannot be told apart this time. */
  noHashes: boolean;
  /** gates.json is a JSON object without `routing`: `update` adds the default routing (it stays in `kept`). */
  routingAdded: boolean;
  /** gates.json has a `routing` object missing some top-level keys: `update` adds these (in the order S, M, L, retry, risky, scout). */
  routingKeysAdded: string[];
  /** The gates.json to write when `routingAdded`. */
  gatesWithRouting: GeneratedFile | null;
  /** gates.json is not valid JSON, or not an object: left as it was; the warning to print. */
  gatesWarning: string | null;
}
