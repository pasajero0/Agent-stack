import { readdirSync } from "node:fs";

/** Scopes from CONTRIBUTING.md: code areas, doc kinds, a quick run of the driver, a spec with its release. */
const SCOPES = ["run", "hooks", "harness", "cli", "ci", "deps", "release", "readme", "changelog", "glossary", "adr", "contributing", "quick"];
const SPEC_SCOPE = /^[a-z]+-\d+\.\d+\.\d+$/;

/**
 * A stage the driver commits for (`feat(c1): …`, `docs(c1): spec — …`): only a stage that has a spec folder, so a
 * made-up scope still fails. Read at lint time, so a spec branch that adds the folder passes.
 */
function stageScopes(): string[] {
  try {
    return readdirSync("docs/specs", { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name.toLowerCase());
  } catch {
    return [];
  }
}

type Outcome = [boolean, string];

export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        "scope-known": ({ scope }: { scope?: string | null }): Outcome => {
          if (!scope) return [false, "a scope is required, e.g. fix(hooks): … — see CONTRIBUTING.md"];
          const ok = SCOPES.includes(scope) || SPEC_SCOPE.test(scope) || stageScopes().includes(scope);
          return [ok, `scope must be one of ${SCOPES.join(", ")}, <spec>-<version> like driver-0.4.2, or a stage with a folder in docs/specs/ — see CONTRIBUTING.md`];
        },
      },
    },
  ],
  rules: {
    "scope-known": [2, "always"],
  },
};
