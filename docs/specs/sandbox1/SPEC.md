---
stage: sandbox1
---

# OS sandbox block for Bash in the generated settings.json

## Purpose

After this stage, every repo the harness deploys to runs the Bash tool inside Claude Code's OS sandbox. `generate`
writes a sandbox block into `.claude/settings.json`. `update` adds it to an existing `settings.json` and keeps the
user's other keys. The block turns the sandbox on, stops the model from retrying a command outside it, keeps the
secret folders unreadable for Bash, and lets Bash reach only the domains listed in `gates.json`. `detect` reports
whether the tools the sandbox needs are found. The README Limits section and the CHANGELOG say what the sandbox
covers and what it does not.

What exists today:
- the generated `settings.json` has `$schema`, `permissions` and `hooks`, and no `sandbox` key
  (`src/claude/harness.ts:75-93`);
- `update` merges `settings.json` with `keepUserSettings` (`src/claude/update-plan.ts:81`): the harness wins at the
  top level, so a harness `sandbox` object would replace a user's whole `sandbox` object;
- `gates.json` has no network or sandbox key (`src/claude/gates.ts:14`);
- `detect` reports the project and Claude Code only (`src/commands/detect.ts`);
- README Limits says "the network is not restricted … turn on Claude Code's `/sandbox`" (`README.md:298`);
- `.claude/tmp/sources/guardrails-map-2026-11-17.md` §3: all three legs of the trifecta are open, the sandbox is not turned on.
  This is roadmap 0.5 phase A, item V4 (`.claude/tmp/roadmap-plan.md:116`).

Facts about Claude Code's sandbox come from `.claude/tmp/sources/audit-0.5-phase0-2026-11-25.md` §1 and §8
(Claude Code 2.1.329). Automated tests do not check them; the pre-build check in How to verify checks the ones this
stage depends on, by hand, on macOS, before any code. The Linux facts (`bwrap`, `socat`, `failIfUnavailable`, the gh
token in `~/.config/gh`) are not checked by hand in this stage. Native Windows is not a sandbox platform in the audit
(only macOS, Linux and WSL2), so with `failIfUnavailable: true` Bash commands there most likely fail; this is not
checked either, and the README and CHANGELOG say so (AC-21, AC-22).

## Decisions

No ADR. Leonid decided these in the grill (2026-11-26):

- **The project block holds all three switches:** `enabled: true`, `allowUnsandboxedCommands: false`,
  `failIfUnavailable: true`. A `false` in user settings, `--settings` or managed settings wins over a project value.
  Loosening entries in the repo's settings files are ignored only when managed settings or `--settings` set
  `allowUnsandboxedCommands: false`. The README says exactly that, shows the block for managed
  settings or `--settings`, and never claims the model cannot leave the sandbox.
- **Domain list in `gates.json`:** a new key `sandbox: { allowedDomains: [...] }`. `generate` seeds it from
  detection: the registry of the detected package manager, plus `github.com` and `api.github.com` when the forge is
  GitHub. Nothing else. The user edits `gates.json` to add more.
- **`update` and `gates.json`:** `update` reads `gates.json` → `sandbox.allowedDomains`. If the key is there, `update`
  uses it. If it is missing, `update` uses the detected domain list, writes it to `settings.json`, and prints one
  line: `add sandbox.allowedDomains to .claude/gates.json to change the list`. `update` does not edit `gates.json`.
- **Merge one level deeper, the user wins:** if the user already set `enabled`, `allowUnsandboxedCommands` or
  `failIfUnavailable`, `update` keeps the user's value and prints one warning for each value that is weaker than
  the harness value. Other user keys are kept. For `filesystem.denyRead` and `network.allowedDomains`, `update` adds
  the user's entries to the harness entries. Each kept entry is reported in `kept` (in code: `customSettings`).
- **Secret folders, fixed in code:** `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`,
  `~/.config/gcloud`, `~/.azure`. Not `~/.config/gh`: on Linux the gh token is there, and the allowed `gh pr view`
  would break. The README names the list and says the Read tool is not covered (guard-file still handles it).

Leonid confirmed or changed these after the first version of this spec (2026-11-26):

- **The registries per package manager** (Contract table "Detected domain list") — approved. A Python or Rust
  install needs two hosts, so the "registry" is two domains there. Hosts a tool reaches only sometimes (Go module
  zips on other hosts, `uv` downloading Python builds from GitHub) are left to the user.
- **The manifest records the generated sandbox lists** (`generatedSandbox`), as it records `generatedAllow` today —
  approved. Without it, a domain the user removed from `gates.json` would stay in `settings.json` as "the user's"
  forever (AC-14), and `update` could not tell a removed secret folder from a new one (AC-18).
- **A secret folder the user removed stays removed** (AC-18). The user wins, as for the switches. `update` adds
  nothing and prints one warning per removed folder. A repo deployed by 0.4.8 or older (no `generatedSandbox`)
  still gets every secret folder added.
- **On Linux, `generate` and `update` warn when `bwrap` or `socat` is missing** (AC-26), because
  `failIfUnavailable: true` then stops every Bash command. `detect` keeps its line (AC-9, AC-16).
- **Native Windows:** one block for every platform; the README and CHANGELOG warn (AC-21, AC-22).
- **The pre-build check comes first.** If a step of it fails, the builder stops and the spec changes before code
  (How to verify). Two results are decided in advance:
  - if `pnpm add` fails only because the sandbox stops the write to the pnpm store outside the repo, the block gets
    `filesystem.allowWrite` with the detected package manager's store or cache path only, and the README names it.
    The builder still stops first: the spec gets a "## Changes" entry with the exact path per package manager;
  - if Claude Code asks the user about a domain not in the list instead of refusing, that is not a stop. The README
    then says "only the listed domains are reached without a question".

Added by this spec:

- **An absent place gets the harness value** (Model table). If the user's `settings.json` has no `denyRead`,
  `filesystem` or `sandbox` key, `update` writes all nine secret folders with no line, as it writes an absent switch.
  Only a folder missing from a `denyRead` list that is there counts as removed by the user.

## Terms

Shared words are defined in [docs/GLOSSARY.md](../../GLOSSARY.md): harness, hook, guards, `gates.json`, seed files,
OS sandbox, sandbox block. Below is only what this spec makes precise.

- **OS sandbox** — as in the glossary: Claude Code's sandbox for the Bash tool and its child processes (macOS
  Seatbelt; Linux and WSL2 `bwrap` + `socat`).
- **Sandbox block** — as in the glossary: the `sandbox` object the harness writes into `.claude/settings.json`
  (Contract).
- **Secret folders** (local): the nine paths of the Contract's `denyRead` list.
- **Detected domain list** (local): the domains the harness derives from the detected package manager and forge
  (Contract table). `generate` seeds `gates.json` with it; `update` falls back to it.
- **Domain source** (local): where `update` takes `allowedDomains` from: `gates.json`, or the detected domain list.
- **Switch** (local): one of the three keys `sandbox.enabled`, `sandbox.allowUnsandboxedCommands`,
  `sandbox.failIfUnavailable`.
- **Harness value** (local): what the sandbox block holds at a switch (`true`, `false`, `true` in that order) or at a
  place (the Contract's object or list there).
- **Place** (local): one of the five keys of the block that hold an object or a list: `sandbox`,
  `sandbox.filesystem`, `sandbox.network`, `sandbox.filesystem.denyRead`, `sandbox.network.allowedDomains`.
- **Weaker value** (local): a user's switch value that is not strictly equal (`!==`) to the harness value. A
  non-boolean value is weaker too.
- **Removed secret folder** (local): a secret folder that is in the manifest's `generatedSandbox.denyRead` and not in
  the user's `denyRead`, while that `denyRead` is an array in `settings.json`.
- **Sandbox readiness** (local): what `detect` reports: whether the tools the OS sandbox needs are found. It does not
  start the sandbox.
- **Missing sandbox tools** (local): on `linux`, the names of `bwrap` and `socat` that are not found on `PATH`
  (`bwrap` first). On every other platform the list is empty.
- **Safe text** (local): a string as `update` prints it: each U+0000 to U+001F, U+007F to U+009F, U+2028, U+2029,
  U+202A to U+202E and U+2066 to U+2069 replaced by `?`. For `JSON.stringify` output this changes only the ranges
  from U+007F on: `JSON.stringify` already writes U+0000 to U+001F as escape sequences (`\n`, `\u001b`, …).

## Model and state transitions

How `update` builds the sandbox block of `settings.json`. In each group the rows are checked in order; the first
that fits wins. The rows of the group "a place of the block" are checked at each of the five places during the
merge: `sandbox`, `sandbox.filesystem`, `sandbox.network`, `sandbox.filesystem.denyRead`,
`sandbox.network.allowedDomains`.

| Group | On disk | What update writes | Criterion |
| --- | --- | --- | --- |
| domain source | `gates.json` is a JSON object with `sandbox.allowedDomains` an array of strings | that array | AC-4 |
| domain source | `gates.json` is a JSON object without `sandbox`, or with a `sandbox` object without `allowedDomains` | the detected domain list, and the "add" line | AC-5 |
| domain source | `gates.json` is a JSON object whose `sandbox` or `sandbox.allowedDomains` has a wrong type | the detected domain list, and the "bad list" warning | AC-11 |
| domain source | `gates.json` is not valid JSON, not an object, or missing on disk | the detected domain list, no extra line | AC-12 |
| `settings.json` | not valid JSON | nothing (as today); no sandbox line; manifest keeps its old `generatedSandbox` | AC-10 |
| `settings.json` | missing | the sandbox block with the domain source's list | AC-24 |
| `settings.json` | valid JSON, no `sandbox` key | the sandbox block with the domain source's list | AC-4 |
| `settings.json` | valid JSON with a `sandbox` key | the merge: the rows below | AC-6 |
| a place of the block | absent (the key is not there) | the harness value at that place (at `denyRead`: all nine secret folders), no line | AC-6 |
| a place of the block | the harness writes an object or array there and the user's value is present and of another type | the harness value at that place, and the "replaced" warning | AC-13 |
| a place of the block | the user's value is of the right type | merged as the rows below | AC-6 |
| a switch | user value strictly equal to the harness value | the harness value; not reported | AC-6 |
| a switch | user value is a weaker value | the user's value, reported in `customSettings`, and its warning | AC-7 |
| a switch | absent | the harness value | AC-6 |
| a secret folder | a removed secret folder (the user's `denyRead` is an array without it, and `generatedSandbox.denyRead` has it) | not written, and the "readable" warning | AC-18 |
| a secret folder | not in the user's `denyRead` array, and not in `generatedSandbox.denyRead` (never deployed, e.g. a 0.4.8 repo) | written at its harness place, no line | AC-18 |
| a list entry | any other harness entry | kept, in harness order, first | AC-8 |
| a list entry | an entry the harness wrote last time (`generatedSandbox`) and does not write now | dropped, not reported | AC-14 |
| a list entry | any other user entry | added after the harness entries, reported in `customSettings` | AC-8 |
| other key | the key `__proto__` at any place | skipped, not reported (as `keepUserSettings` does today) | AC-25 |
| other key | any other key under `sandbox`, `sandbox.filesystem` or `sandbox.network` | kept as it is, reported in `customSettings` | AC-8 |

## Contract

**The sandbox block** in `.claude/settings.json`. Keys in this order: `$schema`, `permissions`, `sandbox`, `hooks`
(then any user key `update` keeps, as today). Inside `sandbox`, `filesystem` and `network`, the harness keys come
first in the order below, then the user's other keys in their order on disk. For a pnpm repo with a GitHub remote,
`generate` writes this, as `JSON.stringify(…, null, 2)` prints it inside the file:

```json
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "failIfUnavailable": true,
    "filesystem": {
      "denyRead": [
        "~/.ssh",
        "~/.aws",
        "~/.gnupg",
        "~/.kube",
        "~/.docker",
        "~/.netrc",
        "~/.npmrc",
        "~/.config/gcloud",
        "~/.azure"
      ],
      "allowWrite": [
        "~/Library/pnpm/store",
        "~/Library/Caches/pnpm",
        "~/.local/share/pnpm/store",
        "~/.cache/pnpm"
      ]
    },
    "network": {
      "allowedDomains": [
        "registry.npmjs.org",
        "github.com",
        "api.github.com"
      ]
    }
  },
```

- `allowWrite` (Q1) is the cache folders of the detected package manager, so an install does not fail with EPERM.
  npm: `~/.npm`. pnpm: the four paths above. yarn: `~/Library/Caches/Yarn`, `~/.cache/yarn`, `~/.yarn/berry/cache`.
  bun: `~/.bun/install/cache`. Any other package manager: no `allowWrite` key. `update` adds the missing paths,
  keeps the user's entries, and drops a path the manifest's `generatedSandbox.allowWrite` has and the harness no
  longer writes. `generatedSandbox.allowWrite` is in the manifest only when the harness writes any.

- `denyRead` is the secret folders, always in this order. On `update`, a removed secret folder is left out
  (AC-18); the others keep this order.
- `allowedDomains`: `generate` writes the detected domain list; `update` writes the list of the domain source. A
  domain that appears twice in the domain source is written once, at its first place (JSON equality). A user entry
  that appears twice is kept and reported once.
- The sandbox block never holds `excludedCommands`, `allowWrite`, `allowRead` or `deniedDomains` of its own. The
  one possible exception is `filesystem.allowWrite` for the package manager store, decided in advance in Decisions;
  it comes only through a "## Changes" entry after the pre-build check.

**Detected domain list.** Registry domains of `packageManager` (`HarnessParams`), then the forge domains. No
duplicates; order as in the tables.

| `packageManager` | Registry domains |
| --- | --- |
| `pnpm`, `npm`, `bun` | `registry.npmjs.org` |
| `yarn` | `registry.yarnpkg.com` |
| `uv`, `poetry`, `pipenv`, `pip` | `pypi.org`, `files.pythonhosted.org` |
| `go` | `proxy.golang.org`, `sum.golang.org` |
| `cargo` | `index.crates.io`, `static.crates.io` |
| `""` or any other | none |

| `forgeCli` | Forge domains |
| --- | --- |
| `gh` (the forge is GitHub; also the default when there is no `origin`, `src/detect/harness-params.ts:86`) | `github.com`, `api.github.com` |
| `glab` | none |

**`gates.json` → `sandbox`.** A new key of `GatesConfig`: `sandbox: { allowedDomains: string[] }`. `generate` writes
it right before `routing`, with the detected domain list. An empty array is valid: Bash then has no network.
`update` never adds it to an existing `gates.json`; when `gates.json` is missing, `update` creates the file as
today, and the new file holds `sandbox`.

**Manifest `.claude/.harness.json`.** A new field `generatedSandbox: { denyRead: string[], allowedDomains: string[] }`:
`denyRead` is always all nine secret folders, removed ones included, so a removed secret folder stays removed on the
next `update`. `allowedDomains` is the domain source's list that `update` wrote this time (after removing
duplicates). Neither list holds the user's kept entries. Each list is read on its own: a list that is missing
or not an array reads as empty; inside an array, non-string entries are dropped (as `generatedAllow` is read,
`src/claude/update-plan.ts:207`). A `generatedSandbox` that is missing or not an object reads as two empty lists.

**`update` output.** The sandbox lines of this table are printed at the end of `reportExtras`
(`src/commands/update.ts:83`), after its last line today, in the order of this table; so in a dry run they come
before the `N unchanged` line. The kept entries print earlier, with the other `customSettings` lines. `<v>` is the safe
text of `JSON.stringify(value)`. `<entry>` and `<key>` are safe text.

| When | Kind | Line |
| --- | --- | --- |
| domain source is the detected list because the key is missing (AC-5) | `log.dim` | `  add sandbox.allowedDomains to .claude/gates.json to change the list` |
| `gates.json` `sandbox` or `sandbox.allowedDomains` has a wrong type (AC-11) | `log.warn` | `.claude/gates.json sandbox.allowedDomains must be a list of domain names, so the detected list was used. Fix it, then run update again.` |
| `sandbox.enabled` is a weaker value | `log.warn` | `sandbox.enabled is <v> in .claude/settings.json: Bash runs without the sandbox` |
| `sandbox.allowUnsandboxedCommands` is a weaker value | `log.warn` | `sandbox.allowUnsandboxedCommands is <v> in .claude/settings.json: the model can run a command outside the sandbox` |
| `sandbox.failIfUnavailable` is a weaker value | `log.warn` | `sandbox.failIfUnavailable is <v> in .claude/settings.json: Bash runs without the sandbox when the sandbox cannot start` |
| a place of the block has a wrong type (AC-13), one line per place | `log.warn` | `replaced <path> in .claude/settings.json: it was not an object` or `… it was not a list` |
| a removed secret folder (AC-18), one line per folder, in the secret folders' order | `log.warn` | `<entry> is readable inside the sandbox: it is not in sandbox.filesystem.denyRead` |
| the missing sandbox tools are not empty (AC-26) | `log.warn` | the "tools" line below |

**The "tools" line** (AC-26), printed by `generate` and `update` alike, `<names>` as in the `detect` line below:
`missing <names> on PATH: every Bash command fails, because sandbox.failIfUnavailable is true. Install bubblewrap and socat, then run agent-stack detect.`
`generate` prints it right after `Generated N harness file(s).` and before the next steps. `update` prints it as the
last sandbox line; it is the one sandbox line `update` prints also when `settings.json` is not valid JSON (AC-10).

`<path>` is one of the five places. Kept entries go to `customSettings`, after today's top-level and `permissions.*`
entries, in this order: switches (in the harness order), other keys of `sandbox`, of `sandbox.filesystem`, of
`sandbox.network` (each in their order on disk), then `denyRead` entries, then `allowedDomains` entries (in their
order on disk). They print through today's line `  kept your setting in settings.json — <entry>`, where `<entry>` is:
- a switch: `sandbox.<key>: <v>`;
- another key: `sandbox.<key>`, `sandbox.filesystem.<key>` or `sandbox.network.<key>`;
- a list entry: `sandbox.filesystem.denyRead: <entry>` or `sandbox.network.allowedDomains: <entry>` (a string as
  safe text, any other value as `<v>`).

`--dry-run` prints the same lines and writes nothing. `--force` changes nothing here: `settings.json` is merged,
never a tracked file (`src/claude/update-plan.ts:143`).

**`agent-stack detect`: sandbox readiness.** One more line, directly after the Claude Code line and before the blank
line that follows it (`src/commands/detect.ts:28-29`), printed with the same layout (`  <name padded to 20> <status>`). The colour codes are not part of the contract; tests remove them first.

| `process.platform` | Check | Line |
| --- | --- | --- |
| `darwin` | none | `  OS sandbox           ✔ built in (macOS Seatbelt)` |
| `linux` | `bwrap` and `socat` both found on `PATH` | `  OS sandbox           ✔ found bwrap, socat` |
| `linux` | one or both not found | `  OS sandbox           ✖ missing <names> — Bash commands will fail; install bubblewrap and socat` |
| any other | none | `  OS sandbox           ? not checked on <platform> — see Claude Code's sandbox docs` |

`<names>` is the missing sandbox tools joined by `, `: `bwrap`, `socat` or `bwrap, socat`. `detect` exits 0 in every
row. Two functions in `src/claude/sandbox.ts` hold the check:
- `missingSandboxTools(platform: string, exists: (cmd: string) => Promise<boolean>): Promise<string[]>` returns the
  missing sandbox tools; it calls `exists` only on `linux`;
- `sandboxReadiness(platform: string, exists: (cmd: string) => Promise<boolean>): Promise<string>` returns the
  status part of the `detect` line (after the padded name) and uses `missingSandboxTools`.

`detect`, `generate` and `update` pass `process.platform` and `commandExists` (`src/utils/shell.ts:3`). `generateCommand`
and `updateCommand` get an optional test seam for both, as `templatesDir` is one today, so tests do not depend on
the machine.

## Constraints

- **Must not:** add a dependency, or more than one new source file: `src/claude/sandbox.ts` holds the secret
  folders, the detected domain list, the block builder, the merge and `sandboxReadiness`. Check: review of
  `package.json` and `git diff --stat src/`.
- **Must not:** hold the secret folders or the registry table in more than one file in `src/`: `generate`, `update`'s
  fallback and the `gates.json` seed all use `src/claude/sandbox.ts`. Check: `grep -rl '~/.ssh' src/` and
  `grep -rl 'registry.npmjs.org' src/` each list only that file.
- **Must not:** edit `gates.json` from `update` for the sandbox. Check: the AC-5 and AC-11 tests (the file stays byte
  for byte).
- **Must keep:** how `update` merges every key outside `sandbox` (`keepUserSettings`, `keepCustomHooks`), and the
  existing `generatedAllow` field. Check: `tests/claude/update-plan.test.ts`, `tests/claude/harness.test.ts` stay
  green; only fixtures that compare a whole `settings.json` or manifest gain the sandbox block or `generatedSandbox`.
- **Must keep:** hooks and `bin/` scripts unchanged; they ignore the new `gates.json` key. Check: `tests/hooks/`
  stays green.
- **Must keep:** strict TS, no `any`; outside JSON (`settings.json`, `gates.json`, the manifest) is checked before use
  (`isObject`, `Array.isArray`), and every key and string from under `sandbox` is printed as safe text. Today's lines
  for other keys stay as they are. Check: `pnpm typecheck`, AC-25, code review.
- **When goals conflict:** the user's explicit setting > the harness default > silence. `update` never overwrites a
  user's switch and never adds back a removed secret folder; it warns instead. The harness value replaces the user's
  in one case only, with a line: a wrong-typed place (AC-13). A secret folder that was never deployed is added without
  a line: nothing of the user's is undone.

## Acceptance criteria (EARS)

### Happy path

- **AC-1:** WHEN `generate` writes `.claude/settings.json`, THE SYSTEM SHALL write the sandbox block of the Contract
  between `permissions` and `hooks`, with `denyRead` equal to the secret folders and `allowedDomains` equal to the
  detected domain list.
- **AC-2:** WHEN `generate` writes `.claude/gates.json`, THE SYSTEM SHALL write `sandbox: { allowedDomains: [...] }`
  right before `routing`, with the same detected domain list as AC-1, and write `generatedSandbox` into the manifest.
- **AC-3:** THE SYSTEM SHALL build the detected domain list from `packageManager` and `forgeCli` as the Contract
  tables say. The tests check every row of both tables, e.g. pnpm + gh → `registry.npmjs.org`, `github.com`,
  `api.github.com`; uv + glab → `pypi.org`, `files.pythonhosted.org`.
- **AC-4:** WHEN `update` runs and `.claude/settings.json` is valid JSON without a `sandbox` key, THE SYSTEM SHALL
  add the sandbox block, with `allowedDomains` from the domain source. WHEN `gates.json` has
  `sandbox.allowedDomains` as an array of strings, the domain source SHALL be that array without duplicates, also
  when it is empty, and no "add" line SHALL be printed. Example: `["a.com", "a.com"]` → `["a.com"]` in
  `settings.json` and in `generatedSandbox.allowedDomains`.
- **AC-5:** WHEN `update` runs and `gates.json` is a JSON object without `sandbox`, or with a `sandbox` object
  without `allowedDomains`, THE SYSTEM SHALL use the detected domain list, print the Contract's "add" line once, and
  leave `gates.json` byte for byte as it was, apart from the routing block or keys that effort1 AC-9 and AC-16 may
  add.
- **AC-6:** WHEN `update` runs and `settings.json` has a `sandbox` object, THE SYSTEM SHALL merge it as the Model
  table says: a switch that is absent gets the harness value; a switch equal to the harness value stays and is not
  reported.
- **AC-7:** WHEN a switch in the user's `sandbox` object is a weaker value, THE SYSTEM SHALL keep the user's value,
  report it in `customSettings` as `sandbox.<key>: <v>`, and print that switch's warning line of the Contract once. Example:
  `"enabled": false` stays false and prints `sandbox.enabled is false in .claude/settings.json: Bash runs without
  the sandbox`.
- **AC-8:** WHEN the user's `sandbox` object holds other keys (e.g. `excludedCommands`, `filesystem.allowWrite`,
  `network.deniedDomains`) or entries in `denyRead` or `allowedDomains` that the harness does not write, THE SYSTEM
  SHALL keep them and report each in `customSettings`, in the Contract's order and form. A list SHALL be the harness entries in
  their order, then the user's entries in their order, with no entry twice (JSON equality). The user's other keys
  SHALL follow the harness keys at their place.
- **AC-9:** WHEN `agent-stack detect` runs, THE SYSTEM SHALL print the sandbox readiness line of the Contract for
  the platform, after the Claude Code line, and exit 0.
- **AC-24:** WHEN `update` runs and `.claude/settings.json` is missing, THE SYSTEM SHALL create it with the sandbox
  block, with `allowedDomains` from the domain source (not always the detected list). Example: `gates.json` has
  `["example.com"]` → `settings.json` gets `["example.com"]`.

### Unhappy path

- **AC-10:** IF `settings.json` is not valid JSON, THEN `update` SHALL leave it as it was, print today's warning
  (`.claude/settings.json is not valid JSON, so it was left as is. …`), print no sandbox line of the Contract except
  the "tools" line of AC-26 (so not the "add" line, not the "bad list" warning), and keep the manifest's old `generatedSandbox` as it was read
  (partner of AC-4, AC-6).
- **AC-11:** IF `gates.json` is a JSON object whose `sandbox` is not an object, or whose `sandbox.allowedDomains` is
  not an array of strings (a non-string entry included), THEN `update` SHALL use the detected domain list, print the
  Contract's "bad list" warning, print no "add" line, and leave `gates.json` byte for byte as it was, apart from the
  routing block or keys that effort1 AC-9 and AC-16 may add (partner of AC-4, AC-5).
- **AC-12:** IF `gates.json` is not valid JSON or not a JSON object, THEN `update` SHALL use the detected domain
  list and print no sandbox line about `gates.json`; today's routing warning stays the one hint. IF `gates.json` is
  missing, THEN `update` SHALL create it as today, with `sandbox` (AC-2), and use its list (partner of AC-4).
- **AC-13:** IF `sandbox`, `sandbox.filesystem` or `sandbox.network` in `settings.json` is not an object, or
  `sandbox.filesystem.denyRead` or `sandbox.network.allowedDomains` is not an array, THEN `update` SHALL put the
  harness value at that place, keep every other user key around it, and print the "replaced" warning for that
  `<path>` once. It SHALL not stop and SHALL exit 0 (partner of AC-6, AC-8).
- **AC-14:** IF an entry of the user's `denyRead` or `allowedDomains` is in the manifest's `generatedSandbox` list of
  the same name and the harness does not write it now, THEN `update` SHALL drop it and not report it. Example:
  `gates.json` had `["registry.npmjs.org", "example.com"]` at the last update, now has `["registry.npmjs.org"]` →
  `example.com` leaves `settings.json`. `update` SHALL write the new `generatedSandbox` into the manifest
  (partner of AC-8).
- **AC-15:** IF the manifest has no `generatedSandbox` (a repo deployed by 0.4.8 or older), or a `generatedSandbox`
  that is not an object, or a list in it that is not an array, THEN `update` SHALL read each such list as empty, so
  every entry of the user's lists counts as the user's, and SHALL drop non-string entries of a list that is an array.
  It SHALL not stop and SHALL exit 0 (partner of AC-14).
- **AC-16:** IF the platform is `linux` and `bwrap`, `socat` or both are not found on `PATH`, THEN `detect` SHALL
  print the "missing" line naming them and still exit 0. IF the platform is neither `darwin` nor `linux`, THEN it
  SHALL print the "not checked" line (partner of AC-9).
- **AC-25:** IF a key or a string list entry under `sandbox` in `settings.json` holds a character of the safe-text
  list (e.g. `"~/.x\u001b]0;pwned\u0007"` in `denyRead`, or `"‮evil"` as a key), THEN every line `update` prints
  about it SHALL show `?` for each such character, and a switch value SHALL print as the safe text of its
  `JSON.stringify` (so no raw control or bidi character reaches the terminal), while `settings.json` keeps the value as it was. IF the key
  `__proto__` appears under `sandbox`, `sandbox.filesystem` or `sandbox.network`, THEN `update` SHALL skip it and
  not report it (partner of AC-7, AC-8).

### Edge cases

- **AC-17:** WHEN `update` runs twice in a row with no change in between, THE SYSTEM SHALL write `settings.json` and
  the manifest byte for byte the same the second time, and print the same sandbox lines as the first run, minus the
  "replaced" lines (nothing is left to replace). The "readable" warnings print again on the second run.
- **AC-18:** WHEN `update` meets a removed secret folder, THE SYSTEM SHALL leave it out of `denyRead`, keep it in
  `generatedSandbox.denyRead`, and print its "readable" warning once. WHEN a secret folder is not in the user's
  `denyRead` array and not in `generatedSandbox.denyRead`, THE SYSTEM SHALL write it at its harness place with no
  line. WHEN the user's `denyRead`, `filesystem` or `sandbox` is absent, THE SYSTEM SHALL write all nine secret
  folders with no line. Examples:
  - a 0.4.8 repo with `"sandbox": {"filesystem": {"denyRead": ["~/.foo"]}}` and no `generatedSandbox` → the nine
    secret folders, then `~/.foo` (reported in `customSettings`), no "readable" line;
  - a 0.5.0 repo whose user deleted `"~/.npmrc"` from `denyRead` → the other eight secret folders, no `~/.npmrc`,
    and one line `~/.npmrc is readable inside the sandbox: it is not in sandbox.filesystem.denyRead`;
  - a 0.5.0 repo whose user deleted the whole `sandbox` key → the full block, no "readable" line.
- **AC-26:** WHERE the platform is `linux`, WHEN `generate` or `update` runs and the missing sandbox tools are not
  empty, THE SYSTEM SHALL print the Contract's "tools" line once and go on as before (exit code unchanged). Example:
  only `socat` is missing → `missing socat on PATH: every Bash command fails, …`. On `update --dry-run` the line
  prints too.
- **AC-27:** IF the platform is `linux` and both `bwrap` and `socat` are found, or the platform is not `linux`, THEN
  `generate` and `update` SHALL print no "tools" line, and on a platform other than `linux` SHALL not call `exists`
  (partner of AC-26).
- **AC-19:** WHEN `update` runs with `--dry-run`, THE SYSTEM SHALL print every sandbox line it would print without
  it, and write nothing (`settings.json`, `gates.json` and the manifest stay byte for byte).
- **AC-20:** WHEN the detected `packageManager` is `""` and the forge is `glab`, THE SYSTEM SHALL write
  `allowedDomains: []` in both files: Bash has no network, and the README says how to add domains.
- **AC-21:** THE SYSTEM SHALL rewrite the README:
  - **Limits**: the bullet "Blocklists, not a sandbox" keeps its facts under a new name, "Blocklists for the
    tools": a Bash write (`sed -i`, `>`) skips the Edit/Write gates, command matching is regex-based, the heredoc
    false positive. The line "the network is not restricted … turn on Claude Code's `/sandbox`" goes. A new bullet
    "OS sandbox (Bash only)" says:
    - it covers Bash and its child processes only. Read, Edit, Write, WebFetch, WebSearch, MCP servers and hooks run
      outside it;
    - Bash reaches only the domains in `gates.json` → `sandbox.allowedDomains` in these words: "only the listed
      domains are reached without a question" (true whether Claude Code refuses or asks about another domain);
      WebFetch is not limited by it;
    - the secret folders (all nine named) are unreadable for Bash; the Read tool is not covered, guard-file still
      handles it; `~/.config/gh` stays readable on purpose; git over SSH fails inside the sandbox, because `~/.ssh`
      is unreadable; if you remove a secret folder from `denyRead`, `update` keeps it removed and warns on each run;
    - a `false` in user settings, `--settings` or managed settings wins over the project value. Loosening entries
      in the repo's settings files are ignored only when managed settings or `--settings` set
      `allowUnsandboxedCommands: false`. It shows the block `{"sandbox": {"enabled": true, "failIfUnavailable":
      true, "allowUnsandboxedCommands": false}}` to put in managed settings or pass with `--settings`, for a lock the
      repo cannot loosen;
    - `sandbox.excludedCommands` runs a command outside the sandbox;
    - on Linux and WSL2 the sandbox needs `bwrap` and `socat`; without them Bash commands fail
      (`failIfUnavailable`); `generate` and `update` warn when one is missing; `agent-stack detect` reports whether
      they are found, not whether the sandbox starts;
    - on native Windows the sandbox is not documented, so Bash commands most likely fail; use WSL2;
  - **Configuration** gains a row `sandbox` (`allowedDomains`: the domains Bash may reach; seeded from detection;
    `update` reads it).
  - The test checks: Limits holds `Blocklists for the tools`, `sed -i`, `heredoc`, `allowUnsandboxedCommands`,
    `failIfUnavailable`, `--settings`, `managed`, the nine secret folders, `~/.config/gh`, `bwrap`,
    `socat`, `guard-file`, `allowedDomains`, `excludedCommands`, `Windows`; the README has no match of
    `turn on Claude Code's \`/sandbox\`` and none (case-insensitive) of `cannot (escape|leave|get out of) the sandbox`.
- **AC-22:** THE SYSTEM SHALL add a `0.5.0` entry to `CHANGELOG.md` above 0.4.8, with `### Upgrading from 0.4.8`,
  which says:
  - run `agent-stack update`: it adds the sandbox block to `settings.json`; the domain list comes from `gates.json`
    → `sandbox.allowedDomains`, or the detected list when that key is missing;
  - Bash now reaches only the listed domains; add a domain to `gates.json`, then run `update`;
  - on Linux and WSL2 install `bwrap` and `socat` first, or Bash commands fail; on native Windows Bash commands most
    likely fail (use WSL2);
  - git over SSH in Bash fails (`~/.ssh` is unreadable); `git push` stays manual;
  - a switch you set yourself is kept, with a warning; a secret folder you removed from `denyRead` stays removed,
    with a warning.

  The test checks the heading and each point by a key word: `update`, `allowedDomains`, `bwrap`, `socat`, `Windows`,
  `SSH`, `warning`.
- **AC-23:** THE SYSTEM SHALL add the terms OS sandbox and Sandbox block to `docs/GLOSSARY.md` under "Harness parts"
  in this change, and `.claude/bin/trace --terms sandbox1` SHALL pass.

## Non-functional requirements

- `detect` starts at most 2 more processes on Linux (one `PATH` lookup each for `bwrap` and `socat`) and 0 on other
  platforms.
- `generate` and `update` make 0 network calls for the sandbox. They start at most 2 more processes on Linux (the
  same two lookups) and 0 on other platforms. `update` reads `gates.json` at most once more than today.
- The sandbox block adds at most 31 lines to the generated `settings.json` (`JSON.stringify(…, null, 2)`) for a
  domain list of 3 (the Contract example, with its pnpm `allowWrite`, is exactly 31 lines; 25 without it).

## Out of scope

- Starting the sandbox in `detect` to prove it works (for example, AppArmor on Ubuntu 23.10+ can stop `bwrap` even
  when it is found). `detect` reports only what it found.
- Writing to user settings (`~/.claude/settings.json`), managed settings or `settings.local.json`. A sandbox key the
  user put in `settings.local.json` is not read or merged.
- Write limits (`allowWrite`, `denyWrite`), and limits on Bash writes inside `.claude/` (roadmap A, item 2),
  `permissions.blockReadsOutsideWorkingDirectories`, `blockWritesOutsideWorkingDirectories`. The pre-build check
  only proves that today's harness writes still work.
- Domains beyond the registry and GitHub: GitLab hosts for `glab`, mirrors, private registries from `.npmrc`,
  `pip.conf` or `GOPROXY`, hosts a tool reaches only sometimes. The user adds them to `gates.json`.
- A check that a domain in `gates.json` is a well-formed host name; Claude Code reads the list as it is.
- Native Windows support: `detect` says "not checked", and the README and CHANGELOG warn that Bash commands most
  likely fail there. The block is the same on every platform.
- Checking Claude Code's sandbox behaviour in automated tests (needs a real `claude`); How to verify does it by hand.
- This repo's own `.claude/settings.json` (git-excluded); the maintainer runs `update` by hand.
- The 0.5.0 release edits (version in `package.json`, CODEMAP): a separate release step.

## How to verify

**Pre-build check — by hand, before any code.** On macOS with a real `claude`, in a fresh pnpm repo with a GitHub
remote, paste the Contract block into `.claude/settings.json` by hand, then start `claude` and ask it to run each
command below. If a step does not give the expected result, stop: the builder writes no code, and the human changes
this spec first. Two results are decided in advance (Decisions): a prompt that asks about an unlisted domain is
not a failure, and a `pnpm add` that fails only on the store write leads to a "## Changes" entry with
`filesystem.allowWrite` for the store path.

Before it: remove or rename any `sandbox` key in `~/.claude/settings.json` and in any managed settings file (both
win over the project), and check that `ls ~/.ssh` works in a plain terminal (so "refused" below means the sandbox,
not a missing folder).

```bash
d=$(mktemp -d) && cd "$d" && git init -q -b main \
  && echo '{"name":"x","dependencies":{"is-number":"7.0.0"}}' > package.json \
  && pnpm install && git add -A && git commit -qm init \
  && git remote add origin https://github.com/x/y.git && node <repo>/bin/cli.mjs generate >/dev/null
# edit .claude/settings.json: add the Contract's "sandbox" block between "permissions" and "hooks"
claude
#   ls ~/.ssh                                    -> refused (denyRead; the `~` form works)
#   curl -sI https://example.com                 -> refused, or Claude Code asks first (answer no: refused)
#   then: "retry it without the sandbox"         -> still refused (project allowUnsandboxedCommands: false holds)
#   curl -sI https://registry.npmjs.org          -> allowed
#   pnpm add is-odd   (approve guard-bash's ask) -> works: the registry fetch and the pnpm store write
#                                                   (outside the repo) pass, and denyRead ~/.npmrc does not break pnpm
#   gh pr view 1 -R cli/cli                      -> works (the gh token is readable)
#   git commit --allow-empty -m test             -> works (writes to .git)
#   mkdir -p .claude/tmp/x && echo ok > .claude/tmp/x/f   -> works (verify and health write there)
```

**After the build:**

```bash
pnpm typecheck
pnpm build                              # bin/cli.mjs imports dist/
pnpm vitest run -t "sandbox1 AC-"       # every criterion of this spec
pnpm test                               # v04, effort1, scout1 and the hooks stay green
.claude/bin/trace --terms sandbox1
.claude/bin/trace sandbox1
grep -rl '~/.ssh' src/; grep -rl 'registry.npmjs.org' src/   # each prints src/claude/sandbox.ts only
# Manual: the generated block, a weaker switch kept with a warning, and detect
d=$(mktemp -d) && cd "$d" && git init -q -b main && echo '{"name":"x"}' > package.json && : > pnpm-lock.yaml \
  && git remote add origin https://github.com/x/y.git && node <repo>/bin/cli.mjs generate >/dev/null \
  && jq .sandbox .claude/settings.json            # the Contract block
jq '.sandbox.enabled = false' .claude/settings.json > s && mv s .claude/settings.json \
  && node <repo>/bin/cli.mjs update | grep 'sandbox.enabled is false'
node <repo>/bin/cli.mjs detect | grep 'OS sandbox'
```

## Changes

- 2026-11-26 — AC-10, AC-17, AC-18, AC-21, AC-22 changed; AC-26, AC-27 added; NFRs, Contract and How to verify
  changed. Why: Leonid's answers to the open decisions. A removed secret folder stays removed, with a warning. On
  Linux, `generate` and `update` warn about missing `bwrap` or `socat`. The `allowWrite` store path and the domain
  prompt are decided in advance. No ADR.
