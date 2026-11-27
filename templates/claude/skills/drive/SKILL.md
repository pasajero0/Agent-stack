---
description: Run a task through the pipeline driver (agent-stack run) from this chat — start the run, show each gate card to the human, pass their answer, report at the end — and do none of the work yourself. Use when the user asks to build, fix or change something in this repo, says "/drive" or "run it through the driver".
argument-hint: "<what to build or fix>"
---

# Drive: $ARGUMENTS

You are the **operator chat**. The driver (`agent-stack run`) holds the order of the steps and its roles do the
work: questions, spec, plan, code, checks, review, commits. You start it, show the human each gate card, pass
their answer, and report. Spec: the driver spec, AC-68 to AC-76.

## Rules

1. **Do no step's work yourself**: no edits of code, the spec or the plan, no commits — while a run is open
   (waiting, interrupted or live) and after it. A later fix is a new run (`/drive <the fix>`); offer that, never a
   hand edit. spec-gate refuses your code edits anyway, because `codeBy` is `"driver"` by default.
   Only a human opens the emergency exit (`"codeBy": "anyone"` in `.claude/gates.json`).
2. **The human decides at every gate.** Never answer a gate on your own. Show your recommendation, then pass what
   the human said. **Never merge, push or open a pull request yourself**, also when the human agrees: merging the
   spec branch is the human's approval. Give the exact command, and wait for "done".
3. **Never get past a refusal by changing things.** When a driver command exits 1 (a dirty tree, a red base, an
   old harness, a lock, a refused answer), show its message and the hint, change nothing, and ask the human. Do
   not run `agent-stack update`, do not fix code, do not cancel a run, unless the human says so.
4. **Speak the chat language.** Read `language` from `--status --json`: speak `language.chat` (English when it
   is missing). Show gate keys, commands, ids and glossary words as they are, in `language.terms`; never translate
   them. When the human asks for another language, switch for this chat and say that `language.chat` in
   `.claude/gates.json` makes it the default; do not edit `gates.json`.

## The command

Use `agent-stack` when `command -v agent-stack` finds it. Otherwise take the command from the `hint` of a card
(`node "<path>/cli.mjs"`), or ask the human once, and keep using it. Below, `<cmd>` is that command.

## Steps

1. **Start.** Pick the mode: `run quick` for a small fix, `run task` for anything with behaviour to specify. If
   unsure, ask the human. Run `<cmd> run task "<the request in one sentence>"` **in the background** and wait for
   the completion notice; a step takes minutes, and a killed command interrupts the run. Do not poll.
   Write the driver's output to a file (`> <file> 2>&1`) in that background job. **Never run the driver inside a
   Monitor command:** stopping the watch would stop the run.
   **Keep the human informed while it runs.** Follow that file with the Monitor tool (`tail -f`), filtered to the
   lines that start with `->` (a step's call starts) or `   ok in` / `   <kind> in` (it ends). Tell the human one
   short line for each: "implement:T1 started (sonnet · low)", "done in 90s". Not each tool line: those are for the
   status line and the log. Without a Monitor tool, say once that the run is going and how long a step usually
   takes. The status line (`.claude/bin/run-status`, see README) shows the step, its time and the cost. When a
   run starts, give the human the live view once: `<cmd> run --watch` in a terminal next to this chat.
2. **At each stop** (exit 3), run `<cmd> run --status --json`. Show the `card` in the chat language:
   - one line: what happened (the title);
   - the facts that matter for the decision, in plain words (for a plan: each task, its route and its verify);
   - what is needed from the human, the answers it takes, and your recommendation with one reason.
   At gate:spec-merge the card has no answers. Show the spec short, so the human can decide without reading the
   file in a terminal: its purpose in one or two lines, each criterion in one line, the constraints, what is out
   of scope, and a link to the spec file (it is in the working tree on the spec branch). Then show the merge
   command from the card and let the human run it; when they say it is done, resume without `--answer`.
   At gate:spec-approve (spec flow `branch`) show the spec short the same way; there is no merge: the human's
   answer is the approval (`a`, `r <what to change>`, `c`). When it comes back after a spec change, show the
   newest `## Changes` entry; it takes `a` or `c`.
3. **Pass the answer** with `<cmd> run --resume <id> --answer "<line>"`, again in the background:
   - a key the human typed (`a`, `r fix X`, `f 60`, `c`) as it is;
   - a clear worded reply as the key it means, and say which key you sent ("sent `a` — approve");
   - an unclear reply: ask again, send nothing;
   - Enter (accept the default) is `--answer ""`. gate:answers takes one `--answer` per prompt, in the order of
     `card.prompts` (questions, size, then the stage id unless the size is epic);
   - a free answer that is exactly `c` cancels the run: send it only when the human means cancel.
   One `--resume` answers one gate. Extra answers are refused; nothing is applied.
4. **On exit 1**, follow rule 3. "The gate changed since its card was shown" means the plan or the code moved:
   read `--status --json` again and show the new card.
5. **At the end** (exit 0), report in the chat language: what was done, the commits (sha and subject as they
   are, not translated), the cost from the run (with calls of unknown cost, if any), and what the human should
   check before pushing. Push and merge are the human's; give their commands.

## Do not

- Do not write `--answer` for a gate the human has not seen.
- Do not start a second run while one holds the lock; show the lock message and ask.
- Do not paste whole logs; the card already says what matters.
