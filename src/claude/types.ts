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
