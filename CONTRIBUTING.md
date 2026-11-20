# Contributing

How branches, commits, pull requests and tags are named. commitlint checks the commit rules (husky `commit-msg`
and CI); the rest is by hand.

## Versions

- The second number is a theme: 0.4.x is the driver, 0.5.x is security and isolation.
- Each release inside a theme raises the third number: 0.4.1, 0.4.2, … New findings stay in the open theme.
- A caret range (`^0.4.0`) installs any 0.4.x by itself. So a release that needs a manual step says so first,
  under "Upgrading from …" in `CHANGELOG.md`.

## Branches

One branch per release: `release/<version>`, from `main`. Example: `release/0.4.2`.

Do not name a branch like a tag (`v0.4.2`): git then cannot tell them apart.

A **hotfix** — an urgent fix of a released version — gets its own branch from that version's tag:
`hotfix/<next version>`, e.g. `git switch -c hotfix/0.4.4 v0.4.3`. It holds only the fix (spec change, test,
code, release commit), one PR, squash, tag. Other work waits for the next release.

## Commits

[Conventional Commits](https://www.conventionalcommits.org): `type(scope): what changed`. The scope is required.

| Scope | For |
|---|---|
| `run` | the driver: `src/run/` |
| `hooks` | `templates/claude/hooks/` |
| `harness` | the rest of the deployed harness: skills, agents, `bin/`, settings |
| `cli` | commands, detect, mcp, usage: `src/commands/`, `src/detect/`, `src/mcp/`, `src/usage/`, `src/claude/` |
| `ci`, `deps` | CI workflows; dependency bumps |
| `release` | the version bump and the release title |
| `readme`, `changelog`, `glossary`, `adr`, `contributing` | that document |
| `<spec>-<version>` | a spec change, before the code: `docs(driver-0.4.2): …` |
| `<stage>` | a commit `agent-stack run` makes for a stage with a folder in `docs/specs/`: `feat(c1): …` |
| `quick` | a commit of `agent-stack run quick`: a small fix with no spec, `fix(quick): …` |

Tests take the scope of the code they test: `test(hooks): …`.

Examples:

```
docs(driver-0.4.2): the gate prints one card
feat(run): the gate prints one card
fix(hooks): a bare install asks first
chore(release): 0.4.2 — readable gates
```

Two release headers, on purpose: the version bump inside the branch is `chore(release): …`; the PR title, which
becomes the one commit on `main`, is `feat(release): …` (see Pull requests).

## Tests

Two groups (`vitest.config.ts`):

- **fast** — no outside process, about 2 s: `pnpm test:fast`;
- **slow** — spawns bash and git in temp repos (hooks, e2e, the driver engine, frozen, git): `pnpm test:slow`.

`pnpm test` runs fast, then slow. CI runs slow in 2 processes, since many at once on a loaded runner made
unrelated tests fail. A new test file that spawns bash or git goes into the `SLOW` list. A shell test prints the
tool's exit and output when it fails, so a CI failure says why.

## Pull requests

- One PR per release branch, into `main`.
- **Squash and merge only.** The PR title becomes the commit on `main`: `feat(release): <version> — <title>`.
  Example: `feat(release): 0.4.2 — readable gates (#4)`.
- The description has four parts: what changed, upgrading, what is not covered, and how it was verified
  (commands and their results).

## Tags

`v<version>`, annotated, on the squash commit on `main`: `git tag -a v0.4.2 <sha> -m "0.4.2 — <title>"`.

`git push` is manual: the maintainer pushes the branch and the tag.
