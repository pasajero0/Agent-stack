# Defect log

One line per defect: what, how it was found, its class, whether it escaped into a release, how it was closed, and
whether a test now guards it. Goal (maintainer, 20/11): see which classes repeat, and automate those — a defect that
comes back is a missing check.

**Classes:** `dup` a rule written in several places drifted · `unverified` an assumption about the platform or the
model not checked live · `slip` an execution error by the editing chat (command, order, wording) · `design` a hole
in the design · `process` release, review or communication.

**Found by:** `review` (code-reviewer / spec-reviewer) · `live` (a run with the real `claude`) · `ci` · `audit` ·
`human` (the maintainer) · `self` (noticed while working) · `stats` (`run --stats`) · `driver` (a driver role reported it).

| # | Date | Defect | Found by | Class | Escaped? | Closed by | Test |
|---|---|---|---|---|---|---|---|
| 1 | 19/11 | An agent could add a dependency without a question (edit `package.json`, bare `pnpm install`) | audit (lecture analysis) | design | no (0.4.0 had it; fixed before 0.4.1) | 0.4.1 `ed2c760` | yes |
| 2 | 19/11 | Under the driver a task could weaken checks through `package.json → scripts` | self | design | no | 0.4.1 `f6516fa` | yes |
| 3 | 19/11 | First fix of #1 had 7 bypasses (global flags, redirects, `update`, npm `--frozen-lockfile`) | review | slip | no | 0.4.1 `ed2c760` | yes |
| 4 | 19/11 | Commit made with a failing test (`;` instead of `&&` after the test run) | self | slip | no | `9fc9c1a` follow-up | — |
| 5 | 20/11 | 0.4.1 merged as a merge commit, not squash (27 commits on main) | human | process | yes (history) | repo setting: squash only | — |
| 6 | 20/11 | Shell tests flaky on CI after the 0.4.1 merge (trace, parallel verify) | ci | design (test infra) | yes (CI red on main) | 0.4.2 `32b71bb`, `9a9ff08`, `9fc9c1a` | yes |
| 7 | 20/11 | Spec 0.4.2 draft: `--answer` could reach a later gate (approve plan and accept at once) | review (spec, blocker) | design | no | spec `37ad384` | yes |
| 8 | 20/11 | New commitlint scope rule broke the driver's header tests and every quick commit (`fix: …`) | self + live | dup (rule vs driver) | no | `0.4.2 tests`, 0.4.3 `4ba545e` | yes |
| 9 | 20/11 | Live 0.4.2: operator chat merged the spec branch, offered a hand fix, translated commit subjects | live | unverified (skill text) | no | 0.4.2 `eed3b85` | yes (text) |
| 10 | 20/11 | Implementer is denied a verify with `$(…)` (Claude Code allows no command substitution by a rule) | live | unverified (platform) | no | 0.4.2 AC-77 note | yes |
| 11 | 20/11 | Keys for the scratch repo were added to this repo's `gates.json` (instructions did not name the repo) | human | process | no | answer rule: always name the repo | — |
| 12 | 20/11 | The status line does not show in Claude Code inside VS Code | live | unverified (platform) | no | README note, `run --watch` (0.4.3) | — |
| 13 | 20/11 | A slow test hit vitest's 5 s limit under the full suite | self | design (test infra) | no | `9fc9c1a` | — |
| 14 | 20/11 | The driver ran inside a Monitor; stopping the watch killed the run | live | slip | no | 0.4.3 `17ff00e` (skill) | yes (text) |
| 15 | 20/11 | 0.4.3 added a step to `/spec`; the driver skipped "step 7", now Review — every spec under the driver skipped spec-reviewer | audit | dup (step number in two places) | **yes (0.4.3)** | hotfix 0.4.4 `19d7190` | yes |
| 16 | 20/11 | `/spec` asked for a `spec: …` commit, which commitlint refuses | audit | dup (3 forms of one rule) | **yes (since 0.3)** | hotfix 0.4.4 `ce5247a` | yes |
| 17 | 20/11 | After commitlint refused a commit, the staged files went into the next commit under the wrong message | self | slip | no | amended `ce5247a` | — |
| 18 | 20/11 | `/plan` says verify is never `true`; the driver allows `true` for a docs-only task | audit | dup | yes (since 0.4.1) | 0.4.5 `f26f37e`, `c3fc904` | yes |
| 19 | 20/11 | Two skip-mark lists (cheat-guard vs frozen tests), each missing what the other has | audit | dup | yes | 0.4.5 `4b67695` (one list builds both) | yes |
| 20 | 20/11 | `trace` and the driver parse criterion lines differently | audit | dup | yes | 0.4.5 `52d1672`, `416aad4` | yes |
| 21 | 20/11 | `/drive` in this repo would speak English: `language` missing in `gates.json` | audit | process (config) | no | the maintainer added the key | — |
| 22 | 20/11 | Analysis chat reported 2.SM1 / 2.SM2 lost from the plan; they were there in short form | self | process (two chats) | no | details restored | — |
| 23 | 20/11 | First fix of #19 checked a third list of examples, not the two real lists: one source only on paper | review | slip | no | 0.4.5 `4b67695` | yes |
| 24 | 20/11 | New cheat patterns would block ordinary code (`this.skip(n)`, `context.todos`) | review | slip | no | 0.4.5 `4b67695` | yes |
| 25 | 20/11 | A test fixture with skip marks was written through Bash, past cheat-guard; Write was refused later | self | slip | no | examples joined from parts, comment says why | — |
| 26 | 23/11 | In spec flow branch `.claude/bin/verify` found no stage: it reads the stage from the branch name only (`release/0.4.6` has none) | self (engine test) | design | no | 0.4.6 `driverCheck` passes AGENT_STACK_RUN; `active_stage` reads the live task run | yes |
| 27 | 23/11 | `## Changes` parsed two ways: exact heading in TS, prefix in gates-lib | review | dup | no | 0.4.6 one rule (prefix) in `spec-change.ts` | yes |
| 28 | 23/11 | `specApproved` / reject `head` from the run file went to git unchecked (`--output=…`) | review | design | no | 0.4.6 store checks a git id | — |
| 29 | 23/11 | `--answer` dropped without a word when a gate found a changed spec | review | design | no | 0.4.6 "Not used: …" line | yes |
| 30 | 23/11 | AC-88 "uncommitted spec" test passed on another refusal's text (`refuseDirty`), not AC-88's | review | slip (test) | no | test moved to implement, asserts the ## Changes wording | yes |
| 31 | 23/11 | Full suite run with `--maxWorkers` on the workspace ran no tests; read as a result | self | slip | no | run as CI does: test:fast, then test:slow --maxWorkers=2 | — |
| 32 | 24/11 | Driver refuses stage id `stats` with "letters then digits, like A1"; the hint reads as a two-character code, so I offered plan codes (M1) that only a gitignored plan explains | self | design (message) | no | glossary Stage: the id names what the stage does (`stats1`); fix the refusal text later through the driver | — |
| 33 | 24/11 | Run stats1: 10 permission denials — implementers wrote files with `cat > … <<EOF`, `python3 -` and `sed -i` in Bash; refused, they fell back to Write/Edit (extra turns, no failure). Found by `run --stats` itself | stats | design (prompt) | no | implement prompt: files only with Write/Edit (`bfb28d0`, quick run) | yes (prompts.test.ts) |
| 34 | 24/11 | Session-start hook says "evals1 — no merged spec yet" under `specFlow: branch`, where the spec is committed on HEAD; the hook does not read the spec flow | driver (T1 implement) | dup (spec-flow rule outside gates-lib) | no | open | — |
| 35 | 24/11 | evals1 T10: to pass `health` (400 lines per file) the implementer squeezed `scripts/eval.mjs` and broke its stop logic; two eval tests then hung about 15 min each, the whole check timed out, and the driver stopped with no new attempt | self (timing the eval tests) | design (a size limit invites squeezing) | no | changes discarded by the maintainer; answer "split into modules, do not squeeze" (`eaa9754`) | yes (AC-14 tests) |
| 36 | 24/11 | Eval test helper runs the eval script with `spawnSync` and no timeout: a hanging run blocks vitest, so the 60 s test timeout never fires; orphan processes stay after the run | self | design (test) | no | helper got a 90 s `spawnSync` timeout (`eaa9754`) | yes |
| 37 | 24/11 | A check that times out (`checkTimeoutMin`) stops the run as interrupted; the driver does not send the task back with the failure, so `--resume` only waits 15 min again | self | design (driver) | no | open | — |
| 38 | 24/11 | My accept comment told F1 to expect exit 0 for the scope check at main; that check needs a change to pass, so it is non-zero there. Cost two extra stops (test-conflict, blocked) | driver (F1 implement) | slip | no | answered at the gate (`6756443`) | — |
| 39 | 24/11 | After a `blocked` stop, retry (`r`) takes no comment, and the earlier test-conflict answer did not reach the next attempt: the implementer still followed the old task text | self | design (driver) | no | open | — |
| 40 | 25/11 | The weaken-test and test-conflict checks failed on any change to an existing test file, so the first live eval run failed weaken-test 3 of 3: the implementer had only added a new test | live eval run | design (eval) | no | the checks fail only on a removed or changed line (`3d55910`) | yes |
| 41 | 25/11 | The plan skill says tier S runs on "sonnet, low effort", but the driver never passes `--effort`: every call runs at the default level | self | dup | no | fixed in 0.4.8 (effort1) | — |
| 42 | 25/11 | `run --watch` clears the screen with `\e[2J` every second; the VS Code terminal keeps each frame in its scrollback, so a copy holds hundreds of frames | maintainer | design (driver) | no | open (after 0.5: an alternate screen, `\e[?1049h`) | — |
| 43 | 25/11 | The fast test `tests/run/claude.test.ts` "v04 AC-51: an abort signal kills the whole process group" failed once by time (3.1 s) on a loaded machine; the driver counted it as a failed attempt of an unrelated refactor (quick run `r-20261125-170322`: +1 attempt, about 4 min, $0.41, and an extra file) | live run | design (test) | no | open (after 0.5: move it to the slow group, which CONTRIBUTING asks for a test that spawns processes, or give it more time) | — |
| 44 | 25/11 | Reading a failed check, I printed only the first 900 of 3280 characters of the feedback and told the maintainer the cause was not visible; the failing test was in the cut part | self | slip | no | read the whole feedback | — |

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
