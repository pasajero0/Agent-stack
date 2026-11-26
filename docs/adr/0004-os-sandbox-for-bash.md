# 0004. The wall for Bash is Claude Code's own OS sandbox

- **Status:** Proposed <!-- Accepted once a human merges it -->
- **Decided:** 2026-11-26 (the sandbox1 grill; rule S7 "built into Claude Code first" from the security plan,
  2026-11-17)
- **Recorded:** 2026-11-26
- **Applies to:** All stages (project-wide decision). Details: [sandbox1](../specs/sandbox1/SPEC.md), which
  records its choices without an ADR.
- **Supersedes:** —

## Context

- **The threat is text.** The agent reads a web page, an MCP answer, an issue or a dependency's README. It is
  dangerous when one session has untrusted input, access to secrets and a channel out. Before 0.5.0 all three
  were open: the sandbox was not on, and README Limits said "the network is not restricted".
- **Hooks are a blocklist.** guard-bash catches mistakes; it does not stop a command written to get past a
  regex (GLOSSARY: "a hook catches mistakes; walls come from other layers").
- **Claude Code has a sandbox** (audit of 2026-11-25, Claude Code 2.1.329): Seatbelt on macOS, `bwrap` and
  `socat` on Linux, Bash only, network through a proxy with an allowlist that starts empty. The model can
  retry outside it with `dangerouslyDisableSandbox`, unless `allowUnsandboxedCommands: false`.
- **The live check of 2026-11-26** (12 probes, real `claude`) found two blockers that tests and evals did not see:
  installs failed on the package cache, and `Read(...)` deny rules also stopped Bash from reading
  `node_modules`.

## Decision

`generate` and `update` turn on Claude Code's OS sandbox for Bash in the project `settings.json`:
`enabled: true`, `allowUnsandboxedCommands: false`, `failIfUnavailable: true`, nine secret folders unreadable,
network only to `gates.json → sandbox.allowedDomains`, and write access only to the detected package
manager's cache. We build no sandbox of our own. Hooks stay as the layer that catches mistakes and covers the
tools the sandbox does not (Read, Edit, Write).

## Alternatives considered

| Option | Why not (what it would cost us) |
| --- | --- |
| Stronger hooks only | A blocklist; every bypass is a new regex, and the rule S1 says hooks are not walls |
| A container or VM per run (Docker, devcontainer, cloud VM) | A new dependency and setup for every user; cloud VMs are on the roadmap's "not taken" list; Claude Code already ships a sandbox (rule S7) (agent's inference) |
| Do nothing; README tells the user to run `/sandbox` | The 0.4.x state; all three legs stay open for anyone who does not read the README |

## Consequences

- **Good:** Bash cannot read `~/.ssh` and the other secret folders, cannot reach an unlisted domain, and cannot
  write `.claude/settings*.json`, `.claude/hooks/` or `.git/hooks/` (live check 2026-11-26).
- **Bad, accepted:**
  - a `false` in user, `--settings` or managed settings wins over the project block, so the README never says
    the model cannot leave the sandbox;
  - Linux needs `bwrap` and `socat`; without them `failIfUnavailable` stops every Bash command;
  - native Windows is not a sandbox platform; this is not checked;
  - the sandbox covers Bash only; WebFetch, MCP servers and the browser extension stay outside it.
- **Follow-ups:** a write ban on `.claude/hooks`, `bin`, `settings*` and `gates.json` for all tools, the
  browser extension and the MCP trifecta — roadmap 0.5, phase B.
