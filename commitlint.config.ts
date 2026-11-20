/** Scopes from CONTRIBUTING.md: code areas, doc kinds, and a spec with its release (`driver-0.4.2`). */
const SCOPES = ["run", "hooks", "harness", "cli", "ci", "deps", "release", "readme", "changelog", "glossary", "adr", "contributing"];
const SPEC_SCOPE = /^[a-z]+-\d+\.\d+\.\d+$/;

type Outcome = [boolean, string];

export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        "scope-known": ({ scope }: { scope?: string | null }): Outcome => {
          if (!scope) return [false, "a scope is required, e.g. fix(hooks): … — see CONTRIBUTING.md"];
          const ok = SCOPES.includes(scope) || SPEC_SCOPE.test(scope);
          return [ok, `scope must be one of ${SCOPES.join(", ")}, or <spec>-<version> like driver-0.4.2 — see CONTRIBUTING.md`];
        },
      },
    },
  ],
  rules: {
    "scope-known": [2, "always"],
  },
};
