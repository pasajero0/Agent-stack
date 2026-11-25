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

## Evals

`evals/` holds a regression task set for the driver; it is not shipped. Each `evals/tasks/<id>/` has a
`task.json` (a quick-mode description, the expected outcome, the gate answers, a `check` command) and a tiny
`fixture/` repo. Spec: [docs/specs/evals1/SPEC.md](docs/specs/evals1/SPEC.md).

```text
pnpm build
node scripts/eval.mjs [--k 3] [--task <id>]…
```

The runner copies each fixture to a temp folder, deploys the harness, runs `run quick` with the **real** `claude`
k times, then runs the `check`. It prints pass@1 and pass^k per task and in total, with the cost, and writes
`evals/results/<date>-<time>.json`; commit that file. A full run costs money (about $1.50 for 5 tasks × 3), so
it asks first. Run it after a change to the prompts, the roles or the checks, and compare with the last results
file. The tests (`tests/eval/`) use the fake `claude` only.

For a release, raise the version in `package.json` first, then run the evals: the results file records
`agentStack` from `package.json` next to the commit, and the README quotes that file (defect #48).

## Defects

Every defect gets one row in [docs/defects.md](docs/defects.md): what broke, who found it, its class, whether it
escaped into a release, what closed it, and whether a test now guards it. Write the row when the defect is found,
not when it is fixed.

- **Classes:** `dup` (a rule written in several places drifted), `unverified` (an assumption about the platform or
  the model, not checked live), `slip` (an execution error: a command, an order, a wording), `design` (a hole in
  the design), `process` (release, review or communication).
- **A fixed defect gets a regression test**, unless it is a slip with nothing to test; then the row says `—`.
- **A class that repeats gets a check, not more text.** When the same class shows up again, add a test, a hook or
  a driver check that catches it.
- `agent-stack run --stats` counts runs, not defects: the log stays human-written. A defect it shows (for example
  permission denials) still gets its row here.

## Pull requests

- One PR per release branch, into `main`.
- **Squash and merge only.** The PR title becomes the commit on `main`: `feat(release): <version> — <title>`.
  Example: `feat(release): 0.4.2 — readable gates (#4)`.
- The description has four parts: what changed, upgrading, what is not covered, and how it was verified
  (commands and their results).
- **Before the merge**, check the release once more (defect #48). A fix found after the merge is a separate
  `docs:` or `fix:` commit on `main`; the tag stays on the release commit.
  1. The version in `package.json` is raised, and the release evals ran after that.
  2. The evals results file the README quotes says the new version, a commit of the release branch, and the same
     `totals` as the README.
  3. Read the start of the README and its tables as a new reader: nothing in them contradicts the new numbers or
     the Limits section.

## Tags

`v<version>`, annotated, on the squash commit on `main`: `git tag -a v0.4.2 <sha> -m "0.4.2 — <title>"`.

`git push` is manual: the maintainer pushes the branch and the tag.
