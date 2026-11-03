---
stage: <stage id>
---

# <Stage title>

## Goal

<One sentence: what the user can do after this stage that they cannot do now.>

## Context

<What already exists. Links to ADRs (`docs/adr/NNNN-…`) and earlier specs.>

## Terms

<Domain words used below, one line each. Use the same word for the same thing everywhere.>

## Model and state transitions

| State | Event | New state | Criterion |
| --- | --- | --- | --- |
| <state> | <event> | <state> | AC-n |

## Contract

<API shape, types, events, CLI flags — whatever the outside world sees. Not the implementation.>

## Acceptance criteria (EARS)

| Pattern | Form |
| --- | --- |
| Always | `THE SYSTEM SHALL …` |
| Event | `WHEN <trigger>, THE SYSTEM SHALL …` |
| State | `WHILE <state>, THE SYSTEM SHALL …` |
| Unwanted | `IF <condition>, THEN THE SYSTEM SHALL …` |
| Option | `WHERE <feature is enabled>, THE SYSTEM SHALL …` |

### Happy path

- **AC-1:** WHEN <trigger>, THE SYSTEM SHALL <observable outcome>.

### Unhappy path

- **AC-2:** IF <invalid input / failure>, THEN THE SYSTEM SHALL <observable outcome> (partner of AC-1).

### Edge cases

- **AC-3:** <duplicates, limits, empty input, concurrency, timeouts, permissions — each as a criterion>.

## Non-functional requirements

- <metric> <threshold with a number> <under which load / where>.

## Out of scope

- <what this stage explicitly does not do, and edge cases deliberately left for later>.

## How to verify

```bash
<test command filtered by AC id, e.g. pnpm test -- -t "AC-"  /  pytest -k "AC_" >
```

## Changes

<Empty for the first version. Later: date — what changed in this spec and why (each change is its own MR).>
