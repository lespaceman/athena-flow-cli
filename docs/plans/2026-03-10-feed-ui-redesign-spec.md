# Feed UI Redesign Spec

**Date:** 2026-03-10
**Status:** Proposed
**Scope:** Feed table/header/row presentation in the TUI

## Summary

Redesign the feed to improve scanability by removing the `EVENT` column and making `DETAILS` the primary narrative surface.

The new feed keeps `TIME`, `ACTOR`, `ACTION`, `DETAILS`, and `RESULT`, but sharply reduces visual competition:

- `DETAILS` becomes the main reading lane.
- `RESULT` becomes the primary status lane for success/failure.
- `ACTION` remains useful, but as a compact, quieter type cue rather than a second status system.
- `ACTOR` stays visible, but narrower and more subdued.
- Lifecycle and low-signal rows recede further.

This spec is intentionally aligned to the current component boundaries:

- `src/ui/hooks/useFeedColumns.ts`
- `src/ui/components/FeedHeader.tsx`
- `src/ui/components/FeedRow.tsx`
- `src/core/feed/cellFormatters.ts`
- `src/core/feed/timeline.ts`

## Problem

The current feed is structurally clear but visually overloaded.

1. State is encoded three times:
   - `EVENT` text (`Tool OK`, `Tool Fail`, `Agent Msg`)
   - `TOOL` pills
   - `RESULT` outcomes
2. `DETAILS` contains the most important information but gets the least visual priority.
3. Success rows consume too much emphasis, making failures and summaries harder to spot.
4. Agent messages, lifecycle rows, tool runs, and summaries all look too similar at a glance.

The result is a feed that feels dense and "debuggy" rather than readable.

## Goals

1. Remove redundant state labeling.
2. Make the main story readable from `DETAILS` + `RESULT` alone.
3. Reserve strong color for exceptions, narrative, and user focus.
4. Preserve the terminal-native feel.
5. Keep the redesign implementable within the existing feed model.

## Non-Goals

1. No feed schema rewrite.
2. No event mapper redesign.
3. No expansion model changes.
4. No change to persistence or ordering semantics.

## Information Architecture

### Column model

Replace:

```text
TIME | EVENT | ACTOR | TOOL | DETAILS | RESULT
```

With:

```text
TIME | ACTOR | ACTION | DETAILS | RESULT
```

### Column roles

| Column    | Role                                 | Priority   |
| --------- | ------------------------------------ | ---------- |
| `TIME`    | chronological anchor                 | low        |
| `ACTOR`   | who produced the row                 | low        |
| `ACTION`  | operation/type cue                   | medium-low |
| `DETAILS` | primary narrative and target/context | high       |
| `RESULT`  | completion/error/outcome             | high       |

### Key principle

`EVENT` is removed because row meaning is already recoverable from:

- `ACTION` for action type
- `DETAILS` for intent/context
- `RESULT` for outcome
- row styling for row class

Example:

```text
17:42  AGENT  Bash    npx playwright test tests/faq.spec.ts                  exit 0
17:44  AGENT          Good progress - 35 passed, 6 still failing
17:46  AGENT  Spawn   General Purpose - Browse and fix FAQ page ...
17:47  SUB    Read    /tests/faq.spec.ts
17:49  AGENT  Edit    /e2e-plan/coverage-plan.md                             replaced 19 -> 52 lines
```

No extra `Tool OK` or `Agent Msg` label is needed.

## Row Taxonomy

The redesign should treat these row classes differently.

### 1. Tool execution rows

Examples:

- `Read`, `Edit`, `Write`, `Bash`, `Navigate`, `Find`

Rules:

- `ACTION` identifies the operation.
- `DETAILS` shows the target, command, selector, path, or compact request context.
- `RESULT` carries outcome when one exists.
- Success rows should be quiet.
- Failure rows should be obvious.

### 2. Agent narrative rows

Examples:

- root agent updates
- subagent output
- summaries

Rules:

- `DETAILS` is the content.
- `RESULT` is usually empty.
- Avoid stacking extra labels beyond what is needed to identify speaker.
- Blue/info styling is acceptable here because prose is meaningfully different from operations.

### 3. Lifecycle/control rows

Examples:

- session start/end
- run start/end
- subagent start/stop
- permission/stop flow bookkeeping

Rules:

- Render much quieter than tool or narrative rows.
- If already hidden by non-verbose mode, keep that behavior.
- When shown, they should not visually compete with operational rows.

### 4. Error/block rows

Examples:

- tool failures
- denied or blocked decisions
- terminal command failures

Rules:

- Red is reserved primarily for these rows and their `RESULT` content.
- The entire row does not need to be red; the outcome lane should be the main failure signal.

## Visual Hierarchy

### 1. Details-first reading flow

The user's eye should land in this order:

1. `DETAILS`
2. `RESULT`
3. `ACTION`
4. `ACTOR`
5. `TIME`

This is the inverse of the current table, where headers/status labels compete too early.

### 2. Single primary status channel

Status should no longer be communicated by a dedicated `EVENT` column.

Preferred status signals:

- `RESULT` text/color
- row-class styling
- optional focused-row treatment

Avoid:

- success-colored event labels
- multiple simultaneous status cues on one row

### 3. Quiet success, loud failure

Success is the baseline state, not the headline.

Success rows:

- muted or neutral result text
- no bright green unless the row is a summary/completion milestone

Failure rows:

- red `RESULT`
- optional subtle failure tint in `DETAILS` if needed

### 4. Action-cell de-emphasis

Keep the visual treatment for actionable rows, but make it secondary.

Rules:

- color by row class, not by row success/failure
- slightly lower saturation/contrast than today
- avoid bright fills that pull more attention than the row content

## Column Layout Spec

### Width strategy

Use fixed widths only where they buy alignment. Let `DETAILS` absorb most reclaimed width.

Suggested targets:

| Column    | Width                                 |
| --------- | ------------------------------------- |
| `TIME`    | 5                                     |
| `ACTOR`   | 6 to 8                                |
| `ACTION`  | 8 to 14                               |
| `DETAILS` | flexible remainder                    |
| `RESULT`  | 0 to 26 depending on visible outcomes |

### Width rules

1. Remove `EVENT_W` entirely.
2. Remove the dedicated `timeEventGapW`.
3. Use one consistent inter-column gap except when terminal width is very wide.
4. Give reclaimed `EVENT` width to `DETAILS` first, not `ACTION`.
5. Keep `RESULT` right-aligned and bounded.

### Header behavior

Header should become:

```text
TIME  ACTOR  ACTION  DETAILS  RESULT
```

Header style rules:

- keep all headers muted
- reduce border/divider prominence
- avoid making the grid feel heavier than the data

## Cell-Level Rules

### TIME

- Always muted.
- No special emphasis except focus/search overlays already supported by gutter.

### ACTOR

- Narrower than today.
- Duplicate actors may still collapse to a dot.
- Root agent should not be brighter than the message itself.
- Subagent labels should stay compact.

Recommended compact labels:

- `AGENT`
- `USER`
- `SYSTEM`
- `SUB`

If stronger subagent identity is needed, prefer compact forms such as:

- `SA:Plan`
- `SA:Explore`

### TOOL

### ACTION

`ACTION` is not a synonym for tool.

It represents the row's compact action verb or action class:

- actual tool name for real tool rows
- `Spawn` for subagent start
- `Return` for subagent stop
- blank for plain agent-message rows
- optional short control verbs for permission/lifecycle rows when shown

Rules:

- do not synthesize `Agent` into `ACTION`
- do not show subagent type as if it were a tool
- use sparse cells when the row is narrative rather than operational
- keep the current pill-like treatment only where it clarifies a real action

### DETAILS

This is now the dominant column.

Rules:

- tool rows: show target/context, not repeated tool names
- agent rows: show message text directly
- subagent start rows: show subagent type plus prompt/description
- subagent stop rows: show return summary when available
- lifecycle rows: concise and muted
- paths and commands should compact intelligently
- avoid repeating data already visible in `ACTION`

Examples:

```text
Bash    npx playwright test tests/faq.spec.ts
Edit    /tests/profile.spec.ts
Find    [agent-web-interface] button
Spawn   General Purpose - Browse and fix FAQ page ...
        Good progress - 35 passed, 6 still failing (all in profile.spec.ts).
```

### RESULT

This becomes the primary outcome lane.

Rules:

- right aligned
- empty when no outcome exists
- muted by default for success
- amber for zero-ish or cautionary outcomes
- red for failures

Examples:

- `exit 0`
- `exit 1`
- `replaced 12 -> 15 lines`
- `0 files`
- `1 found`

## Color And Contrast

### Overarching rule

Use fewer saturated colors at once.

Recommended emphasis policy:

- default text: readable neutral
- metadata (`TIME`, `ACTOR`, header, dividers): muted
- agent narrative text: info/blue
- warnings/zero results: amber
- errors: red
- tool pill fills: subdued

### Dividers and stripes

Current horizontal structure is too strong.

Adjustments:

- soften border color
- soften row stripes if kept
- avoid bright blue lines competing with content

## Interaction Rules

### Focused row

Focused row should still be easy to locate, but the focused treatment should not destroy text hierarchy.

Rules:

- preserve existing focused-row affordance
- ensure `RESULT` remains readable when focused
- avoid recoloring every segment independently on focus

### Search matches

Keep gutter-based search matching. No change required for this spec.

### Expanded rows

No behavioral change required, but the compact row should stand on its own better so users do not need expansion just to understand row type.

## Before / After Example

### Current direction

```text
17:44  Agent Msg  AGENT  Agent            Good progress - 35 passed...                 .
17:46  Tool OK    .      Bash             npx playwright test ...                      exit 0
17:49  Tool OK    AGENT  Edit             /e2e-plan/coverage-plan.md                   replaced 19 -> 52 lines
```

### Proposed direction

```text
17:44  AGENT         Good progress - 35 passed...
17:46  .      Bash   npx playwright test ...                                           exit 0
17:49  AGENT  Edit   /e2e-plan/coverage-plan.md                                        replaced 19 -> 52 lines
17:50  AGENT  Spawn  General Purpose - Browse and fix FAQ page ...
17:51  SUB    Read   /tests/faq.spec.ts
```

The feed becomes easier to read because the repeated event labels are gone and the important content moves left.

## Harness Compatibility

The spec should be defined against the shared feed model, not against a harness-specific event stream.

### Shared today across Claude and Codex

These row classes already normalize cleanly into the feed model for both harnesses:

- `tool.pre`
- `tool.post`
- `tool.failure`
- `permission.request`
- `session.start`
- root-agent narrative output

This means the `ACTION` redesign is already compatible for:

- tool rows
- permission rows
- root agent message rows
- basic lifecycle rows

### Claude-specific parity already present

Claude currently emits native subagent lifecycle into the shared feed mapper:

- `subagent.start`
- `subagent.stop`

The mapper also enriches `subagent.start` with the preceding `Task` description and emits subagent messages from transcript or fallback payloads.

So for Claude, the proposed rows are fully compatible:

- `ACTION=Spawn` on `subagent.start`
- `ACTION=Return` on `subagent.stop`
- blank `ACTION` for `agent.message`

### Codex gap to acknowledge

Codex currently translates:

- `turn.start`
- `turn.complete`
- `message.delta`
- `plan.delta`
- `reasoning.delta`
- `usage.update`
- item-based tool lifecycle

But it does not currently translate Codex collaboration events into shared:

- `subagent.start`
- `subagent.stop`

Codex protocol does expose collaboration events, but the translator does not yet normalize them into the feed model.

Implication:

- the spec is compatible with Codex for tools and root-agent narrative
- the spec is not yet full-parity for subagent `Spawn` / `Return` rows on Codex

### Compatibility requirement for full parity

To make the spec fully compatible across both harnesses, add Codex translator normalization:

- collaboration spawn begin -> `subagent.start`
- collaboration spawn end or close/end -> `subagent.stop`
- subagent message output -> `agent.message` with `scope: 'subagent'`

This should happen in the harness translation layer, not in feed rendering.

### Design rule

The feed renderer should consume only shared feed semantics:

- tool row
- subagent lifecycle row
- narrative row
- control/lifecycle row

It should not infer harness identity from raw protocol details.

## Implementation Notes

This design should be implemented without changing feed event construction.

### `src/ui/hooks/useFeedColumns.ts`

- remove `EVENT_W`
- remove `timeEventGapW`
- recalculate fixed overhead for 5 visible columns
- rebalance reclaimed width into `detailsW`

### `src/ui/components/FeedHeader.tsx`

- remove the `EVENT` header cell
- update both string formatter and Ink component branches

### `src/ui/components/FeedRow.tsx`

- remove `event` from `lineParts()`
- rename the visual `TOOL` cell to `ACTION`
- join rows as `gutter + time + actor + action + detail + result`
- re-check row cache key fields after column-shape changes
- keep `opTag` for styling decisions even though `EVENT` text is gone
- remove the synthetic `Agent` action inserted by `defaultEventPillLabel(...)`
- render blank `ACTION` for `agent.message`
- render `Spawn` / `Return` from shared event kind, not from harness-specific state

### `src/core/feed/cellFormatters.ts`

- `formatEvent()` can be removed or left as dead code until cleanup
- adjust actor/text emphasis rules
- tone down action-cell palettes
- keep `formatResult()` as the main status formatter

### `src/core/feed/timeline.ts`

- keep `eventOperation()` and `opTag` because row class semantics still matter
- `eventLabel()` may become internal-only or removable if nothing renders it
- preserve `toolColumn`, `summary`, and `summaryOutcome`
- add a lightweight action resolver for non-tool rows:
  - `subagent.start` -> `Spawn`
  - `subagent.stop` -> `Return`
  - `agent.message` -> `''`

### `src/harnesses/codex/runtime/eventTranslator.ts`

- required for full parity only
- normalize Codex collaboration events into shared `subagent.start` / `subagent.stop`
- keep renderer free of Codex-specific branching

## Acceptance Criteria

1. Feed header has no `EVENT` column.
2. Typical tool rows remain understandable without `EVENT`.
3. `DETAILS` visibly gains width in the same terminal size.
4. Success rows feel quieter than failures.
5. Agent messages are clearly distinct from tool operations.
6. Failures are primarily surfaced in `RESULT`, not duplicated across multiple columns.
7. `agent.message` rows do not show fake `Agent` in `ACTION`.
8. Claude subagent rows render naturally as `Spawn` / `Return`.
9. Codex remains compatible for all shared non-subagent rows immediately.
10. Full Codex parity for subagent rows requires translator normalization, not renderer hacks.

## Open Questions

1. Should `subagent.stop` use `Return`, `Done`, or blank `ACTION`?
2. Should subagent type always lead the `DETAILS` text, or only when the description is truncated?
3. Should zero-result outcomes like `0 files` remain amber, or become muted to reduce visual noise in search-heavy sessions?

## Recommendation

Implement this in one pass with a small test update set around:

- feed header text
- computed column widths
- row formatting snapshots
- result/status color expectations
- agent-message rows with blank `ACTION`
- Claude subagent lifecycle rows
- Codex translator coverage for collaboration normalization if parity is required

The core design decision is simple: remove `EVENT`, make `DETAILS` the feed, let `RESULT` carry outcome, and use `ACTION` only when the row actually represents an action.
