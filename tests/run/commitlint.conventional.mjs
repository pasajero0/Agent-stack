// The commit rules of a target repo: plain Conventional Commits. This repo's own scope list
// (commitlint.config.ts) does not apply to the commits the driver makes elsewhere.
export default { extends: ["@commitlint/config-conventional"] };
