# Defect log

One line per defect: what, how it was found, its class, whether it escaped into a release, how it was closed, and
whether a test now guards it. Goal (maintainer, 20/11): see which classes repeat, and automate those — a defect that
comes back is a missing check.

**Classes:** `dup` a rule written in several places drifted · `unverified` an assumption about the platform or the
model not checked live · `slip` an execution error by the editing chat (command, order, wording) · `design` a hole
in the design · `env` a test's result depends on the machine it runs on (the OS, installed tools, the load, files that
are not in git) · `process` release, review or communication.

**Found by:** `review` (code-reviewer / spec-reviewer) · `live` (a run with the real `claude`) · `ci` · `audit` ·
`human` (the maintainer) · `self` (noticed while working) · `stats` (`run --stats`) · `driver` (a driver role reported it).

**Cause:** why the defect happened, as a short kebab-case name (see `docs/GLOSSARY.md` → Cause); the same name
for every row with that cause. `pnpm defects` counts the rows by cause.

| # | Date | Defect | Found by | Class | Cause | Escaped? | Closed by | Test |
|---|---|---|---|---|---|---|---|---|
| 1 | 19/11 | An agent could add a dependency without a question (edit `package.json`, bare `pnpm install`) | audit (lecture analysis) | design | dependency-change-unguarded | no (0.4.0 had it; fixed before 0.4.1) | 0.4.1 `ed2c760` | yes |
| 2 | 19/11 | Under the driver a task could weaken checks through `package.json → scripts` | self | design | task-can-edit-check-config | no | 0.4.1 `f6516fa` | yes |
| 3 | 19/11 | First fix of #1 had 7 bypasses (global flags, redirects, `update`, npm `--frozen-lockfile`) | review | slip | dependency-change-unguarded | no | 0.4.1 `ed2c760` | yes |
| 4 | 19/11 | Commit made with a failing test (`;` instead of `&&` after the test run) | self | slip | commit-not-gated-on-test | no | `9fc9c1a` follow-up | — |
| 5 | 20/11 | 0.4.1 merged as a merge commit, not squash (27 commits on main) | human | process | merge-method-not-enforced | yes (history) | repo setting: squash only | — |
| 6 | 20/11 | Shell tests flaky on CI after the 0.4.1 merge (trace, parallel verify) | ci | env (was design: test infra) | test-depends-on-machine | yes (CI red on main) | 0.4.2 `32b71bb`, `9a9ff08`, `9fc9c1a` | yes |
| 7 | 20/11 | Spec 0.4.2 draft: `--answer` could reach a later gate (approve plan and accept at once) | review (spec, blocker) | design | answer-reaches-wrong-gate | no | spec `37ad384` | yes |
| 8 | 20/11 | New commitlint scope rule broke the driver's header tests and every quick commit (`fix: …`) | self + live | dup (rule vs driver) | rule-in-two-places | no | `0.4.2 tests`, 0.4.3 `4ba545e` | yes |
| 9 | 20/11 | Live 0.4.2: operator chat merged the spec branch, offered a hand fix, translated commit subjects | live | unverified (skill text) | skill-text-not-run-live | no | 0.4.2 `eed3b85` | yes (text) |
| 10 | 20/11 | Implementer is denied a verify with `$(…)` (Claude Code allows no command substitution by a rule) | live | unverified (platform) | platform-not-checked-live | no | 0.4.2 AC-77 note | yes |
| 11 | 20/11 | Keys for the scratch repo were added to this repo's `gates.json` (instructions did not name the repo) | human | process | instruction-names-no-repo | no | answer rule: always name the repo | — |
| 12 | 20/11 | The status line does not show in Claude Code inside VS Code | live | unverified (platform) | platform-not-checked-live | no | README note, `run --watch` (0.4.3) | — |
| 13 | 20/11 | A slow test hit vitest's 5 s limit under the full suite | self | design (test infra) | test-depends-on-machine | no | `9fc9c1a` | — |
| 14 | 20/11 | The driver ran inside a Monitor; stopping the watch killed the run | live | slip | driver-run-under-monitor | no | 0.4.3 `17ff00e` (skill) | yes (text) |
| 15 | 20/11 | 0.4.3 added a step to `/spec`; the driver skipped "step 7", now Review — every spec under the driver skipped spec-reviewer | audit | dup (step number in two places) | rule-in-two-places | **yes (0.4.3)** | hotfix 0.4.4 `19d7190` | yes |
| 16 | 20/11 | `/spec` asked for a `spec: …` commit, which commitlint refuses | audit | dup (3 forms of one rule) | rule-in-two-places | **yes (since 0.3)** | hotfix 0.4.4 `ce5247a` | yes |
| 17 | 20/11 | After commitlint refused a commit, the staged files went into the next commit under the wrong message | self | slip | staged-files-survive-refused-commit | no | amended `ce5247a` | — |
| 18 | 20/11 | `/plan` says verify is never `true`; the driver allows `true` for a docs-only task | audit | dup | rule-in-two-places | yes (since 0.4.1) | 0.4.5 `f26f37e`, `c3fc904` | yes |
| 19 | 20/11 | Two skip-mark lists (cheat-guard vs frozen tests), each missing what the other has | audit | dup | rule-in-two-places | yes | 0.4.5 `4b67695` (one list builds both) | yes |
| 20 | 20/11 | `trace` and the driver parse criterion lines differently | audit | dup | rule-in-two-places | yes | 0.4.5 `52d1672`, `416aad4` | yes |
| 21 | 20/11 | `/drive` in this repo would speak English: `language` missing in `gates.json` | audit | process (config) | repo-config-incomplete | no | the maintainer added the key | — |
| 22 | 20/11 | Analysis chat reported 2.SM1 / 2.SM2 lost from the plan; they were there in short form | self | process (two chats) | conclusion-from-partial-read | no | details restored | — |
| 23 | 20/11 | First fix of #19 checked a third list of examples, not the two real lists: one source only on paper | review | slip | test-passes-for-wrong-reason | no | 0.4.5 `4b67695` | yes |
| 24 | 20/11 | New cheat patterns would block ordinary code (`this.skip(n)`, `context.todos`) | review | slip | block-hits-legitimate-input | no | 0.4.5 `4b67695` | yes |
| 25 | 20/11 | A test fixture with skip marks was written through Bash, past cheat-guard; Write was refused later | self | slip | hook-bypassed-through-bash | no | examples joined from parts, comment says why | — |
| 26 | 23/11 | In spec flow branch `.claude/bin/verify` found no stage: it reads the stage from the branch name only (`release/0.4.6` has none) | self (engine test) | design | stage-read-from-branch-only | no | 0.4.6 `driverCheck` passes AGENT_STACK_RUN; `active_stage` reads the live task run | yes |
| 27 | 23/11 | `## Changes` parsed two ways: exact heading in TS, prefix in gates-lib | review | dup | rule-in-two-places | no | 0.4.6 one rule (prefix) in `spec-change.ts` | yes |
| 28 | 23/11 | `specApproved` / reject `head` from the run file went to git unchecked (`--output=…`) | review | design | outside-input-unchecked | no | 0.4.6 store checks a git id | — |
| 29 | 23/11 | `--answer` dropped without a word when a gate found a changed spec | review | design | answer-dropped-silently | no | 0.4.6 "Not used: …" line | yes |
| 30 | 23/11 | AC-88 "uncommitted spec" test passed on another refusal's text (`refuseDirty`), not AC-88's | review | slip (test) | test-passes-for-wrong-reason | no | test moved to implement, asserts the ## Changes wording | yes |
| 31 | 23/11 | Full suite run with `--maxWorkers` on the workspace ran no tests; read as a result | self | slip | zero-tests-read-as-pass | no | run as CI does: test:fast, then test:slow --maxWorkers=2 | — |
| 32 | 24/11 | Driver refuses stage id `stats` with "letters then digits, like A1"; the hint reads as a two-character code, so I offered plan codes (M1) that only a gitignored plan explains | self | design (message) | message-misleads | no | glossary Stage: the id names what the stage does (`stats1`); fix the refusal text later through the driver | — |
| 33 | 24/11 | Run stats1: 10 permission denials — implementers wrote files with `cat > … <<EOF`, `python3 -` and `sed -i` in Bash; refused, they fell back to Write/Edit (extra turns, no failure). Found by `run --stats` itself | stats | design (prompt) | implementer-writes-files-through-bash | no | implement prompt: files only with Write/Edit (`bfb28d0`, quick run) | yes (prompts.test.ts) |
| 34 | 24/11 | Session-start hook says "evals1 — no merged spec yet" under `specFlow: branch`, where the spec is committed on HEAD; the hook does not read the spec flow | driver (T1 implement) | dup (spec-flow rule outside gates-lib) | rule-in-two-places | no | open | — |
| 35 | 24/11 | evals1 T10: to pass `health` (400 lines per file) the implementer squeezed `scripts/eval.mjs` and broke its stop logic; two eval tests then hung about 15 min each, the whole check timed out, and the driver stopped with no new attempt | self (timing the eval tests) | design (a size limit invites squeezing) | size-limit-invites-squeezing | no | changes discarded by the maintainer; answer "split into modules, do not squeeze" (`eaa9754`) | yes (AC-14 tests) |
| 36 | 24/11 | Eval test helper runs the eval script with `spawnSync` and no timeout: a hanging run blocks vitest, so the 60 s test timeout never fires; orphan processes stay after the run | self | design (test) | child-process-without-timeout | no | helper got a 90 s `spawnSync` timeout (`eaa9754`) | yes |
| 37 | 24/11 | A check that times out (`checkTimeoutMin`) stops the run as interrupted; the driver does not send the task back with the failure, so `--resume` only waits 15 min again | self | design (driver) | check-timeout-stops-run | no | open | — |
| 38 | 24/11 | My accept comment told F1 to expect exit 0 for the scope check at main; that check needs a change to pass, so it is non-zero there. Cost two extra stops (test-conflict, blocked) | driver (F1 implement) | slip | answer-states-unchecked-fact | no | answered at the gate (`6756443`) | — |
| 39 | 24/11 | After a `blocked` stop, retry (`r`) takes no comment, and the earlier test-conflict answer did not reach the next attempt: the implementer still followed the old task text | self | design (driver) | retry-takes-no-comment | no | open | — |
| 40 | 25/11 | The weaken-test and test-conflict checks failed on any change to an existing test file, so the first live eval run failed weaken-test 3 of 3: the implementer had only added a new test | live eval run | design (eval) | block-hits-legitimate-input | no | the checks fail only on a removed or changed line (`3d55910`) | yes |
| 41 | 25/11 | The plan skill says tier S runs on "sonnet, low effort", but the driver never passes `--effort`: every call runs at the default level | self | dup | rule-in-two-places | no | fixed in 0.4.8 (effort1) | — |
| 42 | 25/11 | `run --watch` clears the screen with `\e[2J` every second; the VS Code terminal keeps each frame in its scrollback, so a copy holds hundreds of frames | maintainer | design (driver) | watch-redraws-into-scrollback | no | open (after 0.5: an alternate screen, `\e[?1049h`) | — |
| 43 | 25/11 | The fast test `tests/run/claude.test.ts` "v04 AC-51: an abort signal kills the whole process group" failed once by time (3.1 s) on a loaded machine; the driver counted it as a failed attempt of an unrelated refactor (quick run `r-20261125-170322`: +1 attempt, about 4 min, $0.41, and an extra file) | live run | env (was design: test) | driver-counts-unrelated-red | no | open (after 0.5: move it to the slow group, which CONTRIBUTING asks for a test that spawns processes, or give it more time) | — |
| 44 | 25/11 | Reading a failed check, I printed only the first 900 of 3280 characters of the feedback and told the maintainer the cause was not visible; the failing test was in the cut part | self | slip | conclusion-from-partial-read | no | read the whole feedback | — |
| 45 | 25/11 | The slow tests `tests/eval/*` run the built `dist/`, which was older than the stage's first commit; 47 of them failed in every implementer's `pnpm test` of the `scout1` run (`r-20261125-175859`), and each implementer spent turns looking for the cause it may not read or build | driver (implementers reported it) | env (was design: tests) | test-depends-on-machine | no | `pnpm build` by hand; all 486 + 780 pass. Open: the slow tests build `dist/` first, or the driver builds before base-check | — |
| 46 | 25/11 | After `dist/` was rebuilt, the start check scout1 AC-15 (`routing.scout` must be in `gates.json`) refused `--resume … --answer a` at gate:accept of the very run that built it | self | design (driver) | new-config-key-breaks-old-run | no | `agent-stack update` added `"scout": "haiku·low"`. Open: a run started before a routing key existed is not checked for it on resume | — |
| 47 | 25/11 | The implement prompt names the full test command with no word on when to run it; in the `scout1` run implementers ran the full `pnpm test` (about 2 min) 37 times, about 74 of 123 implement minutes | maintainer | design (driver) | implementer-runs-full-suite | no | quick run in 0.4.8: run the verify and the tests of changed files; the driver runs the full suite | — |
| 48 | 25/11 | The 0.4.8 README quoted an eval results file that says `"agentStack": "0.4.7"`: I ran the evals on the release code before the release commit raised the version, and checked only `totals` against the README | external review | slip | evals-run-before-version-bump | yes (0.4.8 README) | evals run again on `main` at 0.4.8 (`2026-11-25-234220.json`); CONTRIBUTING: raise the version first | — |
| 49 | 26/11 | The implement call ended, but six vitest workers its `pnpm test` started kept running with parent PID 1 (10–60% CPU each, load 22–40 on 8 cores); every later test run in `sandbox1` then failed a different time-limited test, and T8 used all 3 attempts (53 min) | self | design (driver) | child-processes-outlive-call | no | open: kill the call's whole process tree after implement; the workers stopped only when the Mac slept | — |
| 50 | 26/11 | Tests with hard time limits (5 s timeouts, stats NFR < 3 s, e2e < 10 s, eval AC-9 20 s) fail on a loaded machine; the driver reads that as a red base (quick `r-20261126-104115`) or a failed task | self | env (was design: tests) | driver-counts-unrelated-red | no | open (with #43): give them margin or move them to their own group | — |
| 51 | 26/11 | After BLOCKED with attempts used up, gate:limit takes only a bare `r`; my comment for the implementer was refused, so the retry got no word on the cause | self | design (driver) | retry-takes-no-comment | no | open (as #39) | — |
| 52 | 26/11 | The test "sandbox1 AC-23: trace --terms sandbox1 passes" ran `.claude/bin/trace` of this repo's own harness. `.claude/` is not in git, so the test passed on the maintainer's machine and failed in CI with ENOENT. The driver wrote the test in `sandbox1`; its checks and the review ran on that same machine | ci (first run of the release PR) | env | test-depends-on-machine | no (the PR was red) | 0.5.0 `550d5df`: the test deploys a harness into a temp folder; checked in a clean checkout without `.claude/`. Open: a guard test that fails when a test reads this repo's `.claude/` | yes |
| 53 | 26/11 | 17 tests in `sandbox-merge`, `sandbox-lists` and `sandbox-update` called `generate` and `update` with no platform. On the Linux runner, which has no `socat`, the commands print one more warning ("missing socat on PATH"), and the tests compare the printed warnings. They passed on macOS, where the tools check does not run | ci (second run of the release PR) | env | test-depends-on-machine | no (the PR was red) | 0.5.0 `a2f2b3b`: `tests/claude/pin-platform.ts` pins the platform in the six files that call the commands with no platform; reproduced first with the platform set to linux (the same 17). Open: CI on every push to a release branch, so a branch is not tested on one machine only until its PR | yes |
| 54 | 27/11 | `.claude/bin/verify` made its temp file with a bare `mktemp`. On macOS that ignores `$TMPDIR`, so inside the OS sandbox it failed, `tasks.json` was not updated, and `verify` printed "0/N tasks passing" for passed tasks. Cause: temp file outside `$TMPDIR` (a harness part written before the sandbox and never run with it; third case after the `Read(...)` rules and the package cache) | self (the slow tests run inside the sandbox in this repo: 6 red) | design | harness-part-not-tested-with-sandbox | yes (0.5.0, macOS, verify run by the agent in Bash) | 0.5.1 `3d23215`: the temp file is next to `tasks.json` | yes |
| 55 | 27/11 | `session-start-context.sh` and `stop-flag-reflect.sh` kept their markers in `/tmp/claude-sessions` and `/tmp/.claude-reflect-pending`; inside the sandbox Bash writes only under `$TMPDIR`, so 5 hook tests were red there. Same cause as #54. In a live session hooks run outside the sandbox, so only the tests failed | self (same test run) | env | harness-part-not-tested-with-sandbox | no | 0.5.1 `3d23215`: both use `${TMPDIR:-/tmp}` | yes |
| 56 | 27/11 | The driver counts a red test that the task did not touch as a failed attempt. Quick `r-20261126-183201`: the change was right (856 passed, both new tests green), one eval test failed by time on a loaded machine (2:26 against a 90 s limit; 1.6 s alone), and the task went to a second attempt on opus · high that studied the wrong test. Third time for this cause: #43 (+1 attempt, 4 min, $0.41) and T8 of `sandbox1` (3 attempts, 53 min, $1.66) | live run | design (driver) | driver-counts-unrelated-red | no | 0.5.3: the driver runs a red check command once more before the attempt fails; if the second run is green, the task goes on and gate:accept shows `check passed on a second run: <command> (first exit <n>)`. Not done: the driver does not look at which test was red or whether the task touched it, so a test that the task made unstable can pass on the second run | tests/run/engine-check-rerun.test.ts |
| 57 | 27/11 | With the OS sandbox on in this repo, a `claude` started from the chat's Bash answers "Not logged in · Please run /login": it cannot read its login from inside the sandbox. On this machine the user settings hold `Read(~/Library/Keychains/**)`, and a `Read(...)` deny rule reaches the sandbox (the cause of the `node_modules` defect, now from user settings, which `update` does not look at). Not checked: a machine without that rule. So the driver (`/drive`) and the eval runner, when started from the chat, make no model call: the release evals for 0.5.1 gave 0 of 21, $0.00, and every try stopped at gate:limit. Cause: a harness part never run with the sandbox (fourth case: `Read(...)` rules, package cache, temp files, the driver's own `claude` call). README does not say it | self (release evals of 0.5.1 run inside the sandbox) | unverified (platform) | harness-part-not-tested-with-sandbox | not known (0.5.0 turns the sandbox on and `/drive` runs the driver through Bash; whether it fails without the Keychains rule is not checked) | closed in 0.5.2: probes showed the cause is the read deny on `~/Library/Keychains` alone, and that macOS refuses a sandbox inside a sandbox. The driver asks the OS whether it runs inside a sandbox; if so, each call gets a token from `~/.config/agent-stack/claude-token` and runs with its own sandbox off. `sandbox.excludedCommands` was rejected: the agent could change the launcher file | `tests/run/outer-sandbox.test.ts`; evals from the chat inside the sandbox: 21/21 |
| 58 | 26/11 | The driver stops its own run at `tests-changed` for a change its own plan asked for: a new test file added to the slow list in `vitest.config.ts`, a new check step in `.github/workflows/ci.yml`, a wider CI trigger. Three stops in two runs on one evening; the first waited for a human. The stop does not tell "adds a check" from "weakens a check" | live (runs `r-20261126-195940`, `r-20261126-205722`) | design | stop-ignores-what-the-change-does | no (the run waits; nothing wrong is merged) | partly closed (0.5.3): the test-list case is closed — a test runner config that only lists new test files passes, and gate:accept shows it. Only lists that select test files pass (`include`, `exclude`, `testMatch`, …), written one entry per line directly under the opening line; lists that run code (`setupFiles`, `globalSetup`, …) still stop. Open: CI steps, CI triggers and other check configs still stop; they wait for a critic role | `tests/run/frozen.test.ts` (Q1), `tests/run/engine-quick.test.ts` (Q1) |
| 59 | 26/11 | A new test looked up the CHANGELOG section by the heading `## 0.5.2 — unreleased`, a text that the release commit must change. The release commit had to edit the test | self (release commit of 0.5.2) | design | test-pins-temporary-text | no | 0.5.2: the test names the release heading | — |
| 60 | 26/11 | A check failed in a quick run and the operator chat told the maintainer the cause was probably a slow test under load. The cause was a real test conflict. The driver keeps only the last lines of a failed check's output, and the failing test was not in them (the same as #44) | self (run `r-20261126-214224`) | design | conclusion-from-partial-read | no (corrected in the next message) | open: the feedback of a failed check must hold the lines of the failing tests, not only the tail | planned: 0.5.4 |

## Summary (20/11, 22 defects)

| Class | Count | Escaped into a release |
|---|---|---|
| dup | 6 (#8, 15, 16, 18, 19, 20) | 5 |
| slip | 5 (#3, 4, 14, 17, + #11 partly) | 0 |
| design | 5 (#1, 2, 6, 7, 13) | 1 (CI) |
| unverified | 3 (#9, 10, 12) | 0 |
| process | 4 (#5, 11, 21, 22) | 1 |

**Reading:** every defect that escaped into a release, except the CI one, is a **dup**: one rule written in several
places. Review and live runs caught design and slip defects before release; nothing caught duplicates until the
audit. So the first automation to build is a check that keeps each rule in one place (ИП-1, ИП-2), not another
gate. Slips are mine and repeat (command chaining, staging): a commit only after a separate green test step.

## The `env` class (26/11, 53 defects; 27/11: #55 and the timed-out test of #56 make eight)

Six defects in seven days have one cause: the result of a test depended on the machine. They were logged under
`design`, so the repeat did not show.

| # | Date | What the test depended on | State |
|---|---|---|---|
| 6 | 20/11 | timing of shell tests on the CI runner | closed |
| 43 | 25/11 | a 3 s limit on a loaded machine | open |
| 45 | 25/11 | a `dist/` built before the stage's first commit | open |
| 50 | 26/11 | hard time limits (3 s, 5 s, 10 s, 20 s) on a loaded machine | open |
| 52 | 26/11 | this repo's own `.claude/`, which is not in git | closed |
| 53 | 26/11 | the OS and whether `socat` is installed | closed |

Related, in other classes: #36 (a test helper with no timeout) and #49 (orphaned test workers that make the load
of #50).

**Reading:** each row was closed, or left open, one test at a time. The rule of this log is "a class that repeats
gets a check", and this class got none. Until the release PR, a release branch was tested on one machine only:
CI runs for `main` and for a pull request. Cost on 26/11: two red CI runs on the 0.5.0 release PR, and before that
53 minutes of one task (#49, #50). Checks to build first in 0.5.1: CI on every push to `release/**`; a guard test
that fails when a test reads this repo's `.claude/` or calls `generate` or `update` with no platform; a group of
their own, with margin, for the tests with time limits (#43, #50).
