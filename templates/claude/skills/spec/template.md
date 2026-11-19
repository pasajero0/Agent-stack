---
stage: <stage id>
---

# <Stage title>

## Purpose

<What the user can do after this stage that they cannot do now, and what already exists.>

## Decisions

<The ADRs behind this stage. A criterion that follows from one cites it: (ADR-NNNN).>

| ADR | Decided | What it means here |
| --- | --- | --- |
| [NNNN](../../adr/NNNN-title.md) | YYYY-MM-DD or unknown | <one line> |

## Terms

<Domain words used below, one line each. Use the same word for the same thing everywhere.>

## Model and state transitions

| State | Event | New state | Criterion |
| --- | --- | --- | --- |
| <state> | <event> | <state> | AC-n |

## Contract

<API shape, types, events, CLI flags — whatever the outside world sees. Not the implementation.
If the shapes live in a contract package, name them here; fields are described only there.>

## Acceptance criteria (EARS)

<!-- A stage that spans parts (Backend and Frontend, api and web) groups the three headings below under a
     heading per part: "### Backend" → "#### Happy path" … AC ids run on through all parts, so each stays
     unique in this file. One part only: keep the headings as they are. -->

### Happy path

- **AC-1:** WHEN <trigger>, THE SYSTEM SHALL <observable outcome> (ADR-NNNN).

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

<Empty for the first version. Later: date — what changed in this spec and why (link the ADR if a decision changed).>
