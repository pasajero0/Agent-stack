# Usage analytics — how to read what the harness did

`agent-stack usage` answers two questions: what in the harness ever acted, and what each agent cost.
It reads Claude Code's session logs and keeps only counts. This guide says when to run it, how to read
the report, and how to decide what to keep.

It does **not** say whether a part helped. A `guard-bash` block shows a push was stopped, not that the
push would have been a mistake. For that, run the same tasks with and without the harness (evals).

## 1. Collect

Claude Code deletes session logs after `cleanupPeriodDays` (30 by default), so save a summary while
the logs exist:

```bash
cd <project>
agent-stack usage --days 7 --save     # once a week, in every project that runs the harness
```

- **Always use the same window.** Snapshots are compared, never added up: two saves with
  `--days 30` a week apart count the same three weeks twice. A weekly `--days 7` gives
  non-overlapping weeks.
- **One file per day.** `.claude/tmp/usage/<YYYY-MM-DD>.json`; a second save on the same day replaces
  the first. A snapshot holds counts and the names of harness parts, no conversation text.
- **Logs from another machine:** copy `~/.claude/projects/<project-dir>/` and pass
  `--logs <copy>`. `<project-dir>` is the project path with every non-alphanumeric character
  replaced by `-`.

## 2. Read the report

| Section | What it counts | Read it as |
| --- | --- | --- |
| Hooks that blocked | A tool call denied by a PreToolUse hook, by script | Each block is either a mistake caught or a false positive — check which (§3) |
| Context added by hooks | Text a hook added, by event (`PostToolUse:Edit`, `SessionStart:startup`) | Cost: every line here lands in the context window |
| Stop hooks — runs | How often each Stop hook ran | Runs only. The log does not say which hook acted, and plugins run there too |
| Subagents | Agent tool calls by type | Is the work delegated? Compare with the token table |
| Skills | `Skill` calls plus reads of a `SKILL.md` | Agents often follow a skill by reading it |
| Commands | Slash commands the human typed | |
| `.claude/bin` | `verify`, `trace`, `health` run through Bash | |
| Tokens | Cache write / output / cache read, per agent and model | Where the money goes |
| Never acted | Installed parts with no event in the window | Candidates for removal — not proof (§4) |

Known blind spots:

- **Hooks that allow a call leave no trace.** A guard that never blocked may still have run thousands of
  times; "never acted" means no block, not no run.
- **Permission prompts (`ask`) are not counted.**
- **Context is credited by event, not by script.** `PostToolUse` context goes to `post-edit-lint`,
  `SessionStart` to `session-start-context`. A custom hook on the same event shares the credit.
- **The log format is Claude Code's internal one** and can change between versions. If a section
  suddenly drops to zero after a Claude Code update, suspect the format first.

## 3. Check blocks for false positives

The report counts blocks; to judge them, read the reasons. From the project's log folder:

```bash
cd ~/.claude/projects/<project-dir>
cat *.jsonl */subagents/*.jsonl | jq -r '
  select(.type == "user") | .message.content[]?
  | select(.type == "tool_result" and .is_error == true)
  | (.content | if type == "string" then . else (map(.text? // "") | join("\n")) end)
  | select(test("^\\s*(PreToolUse|PostToolUse):\\w+ hook error: "))
  | .[0:220]' | sort | uniq -c | sort -rn
```

Mark each reason **caught** (the block stopped something wrong) or **false** (it stopped legitimate
work). A hook with more false blocks than caught ones costs more than it saves: fix its pattern or drop it.

## 4. Decide what to keep

Look at a part only after several weeks of snapshots from **at least two real projects** — one fresh
project leaves most parts idle (there is no code for `pattern-scout`, no PR for `/mr-description`).

| Finding | Decision |
| --- | --- |
| Never acted, cheap (a short file, no cost per session) | Keep, mark experimental, look again next revision |
| Never acted across projects and weeks | Remove |
| Acts, mostly false positives | Fix the pattern; drop if it stays noisy |
| Adds a lot of context per edit or per session | Shrink the output or make it conditional |
| Main session holds most output tokens while subagents exist | Delegation is not happening — a rule, not a hook, is failing |

Delegation share, from one snapshot:

```bash
jq '[.report.tokens[] | {agent, out: .output}]
    | (map(select(.agent == "main") | .out) | add) / (map(.out) | add)' .claude/tmp/usage/2026-11-16.json
```

## 5. Compare snapshots

```bash
cd .claude/tmp/usage
# hook blocks per week
for f in *.json; do printf '%s ' "${f%.json}"; jq -c '.report.hookBlocks' "$f"; done
# what stopped being idle, or became idle, between two weeks
diff <(jq -r '.neverActed | to_entries[] | .key as $k | .value[] | "\($k) \(.)"' 2026-11-09.json) \
     <(jq -r '.neverActed | to_entries[] | .key as $k | .value[] | "\($k) \(.)"' 2026-11-16.json)
```

A part that leaves "never acted" has found a use; a part that joins it may have been broken by a change.

## 6. Revision checklist

Before a release, or when the harness feels heavy:

1. In each project: `agent-stack usage --days 30` (or read the saved weekly snapshots).
2. Check the blocks of every hook that blocked (§3).
3. List parts that never acted in every project; apply §4.
4. Read the token table: main session share, the most expensive subagent, context-heavy hooks.
5. Write the result down with numbers and dates, and the decisions with their reason, so the next
   revision can tell whether a removal or a fix worked.
