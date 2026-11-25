# run-panel — prototype, not shipped

A Claude Code mod that shows the latest `agent-stack run` of the repo, live. It is a prototype: it is not part of
the harness, `generate` and `update` do not install it, and it has no tests yet. The plan to ship it is in the
roadmap, under "Visualization of a run" (after 0.5).

## What it shows

- **A pane beside the chat** (`/run-panel`) and **a status line**: stage, status, plan progress, current step,
  model · effort, cost, the last 6 agent actions.
- **A dashboard in the VS Code integrated browser** (`/run-view`, or open `.claude/tmp/run-view.html` and press the
  globe in the editor header). A fixed template (`assets/run-view.html`) plus a data file `run-view.data.js` that the
  mod rewrites; the page reloads only the data and patches the DOM.
  - **task / story:** before-code steps on one line, the plan as a table, details per task on click (description,
    criteria, steps with time and cost, attempts, permission denials, commit and `+N −M`, the failed check output).
  - **quick:** a pipeline `base-check → implement → checks → review → commit → gate:accept`; a click on a step shows
    its details (the implementer's report per attempt, the failed check lines, the reviewer's notes, why a step
    was skipped).
  - "Needs you" banner and a toast when the driver waits at a gate; "no update for N" when the run looks stuck.
  - A live `evals` try (a temp copy with a run lock) wins over the repo's last run.
  - Theme from VS Code (`workbench.colorTheme`), or Auto / Light / Dark; language from `language.chat` in
    `.claude/gates.json` (`en` or `ru`).

It reads `.claude/tmp/runs/<id>/` (`run.json`, `now.json`, `progress.log`, `calls/*.json`) and
`.claude/tmp/<stage>/tasks.json`; it writes only `.claude/tmp/run-view.html` and `.claude/tmp/run-view.data.js`.
Polling: 2 s while running, 5 s at a gate, 15 s when finished, 30 s with no run.

## Use it

Load the folder as a plugin in every session: add it to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`, for example

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/Agent-stack-proto/prototypes/run-panel" } }
```

or start a session with `claude --plugin-dir /path/to/prototypes/run-panel`. Then `/run-panel` and `/run-view`.

## Known gaps

- The checks step shows the commands and their usual time, not their live output: the driver keeps only the last
  lines of a failed check.
- A failed command inside a task is not in `progress.log`.
- Only the latest run; no list of earlier runs; no summary view for a finished run; no epic or evals matrix view.
- `/run-view` opens the HTML in the integrated browser only when VS Code opens local HTML there by default.
