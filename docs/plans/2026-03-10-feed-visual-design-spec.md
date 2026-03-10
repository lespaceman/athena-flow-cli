# Feed Visual Design Spec

**Date:** 2026-03-10
**Status:** Final
**Companion to:** `docs/plans/2026-03-10-feed-ui-redesign-spec.md`
**Scope:** Color, typography, contrast, and spatial rules for the redesigned feed

---

## Purpose

This document defines the visual language for Athena's feed after the column
restructure from `TIME | EVENT | ACTOR | TOOL | DETAILS | RESULT` to
`TIME | ACTOR | ACTION | DETAILS | RESULT`.

It is not a code change list. It explains _why_ each visual choice exists, so
that implementers can make consistent decisions when edge cases arise.

---

## 1. The Central Problem

The feed's job is to answer one question per row:

> "What just happened?"

The current design answers that question **three times per row**: once in EVENT
(`Tool OK`), once in the tool pill (`Edit`), and once in RESULT
(`replaced 2 → 2 lines`). All three carry similar brightness. The user's eye
has nowhere to rest because every column shouts at equal volume.

The redesign solves this by establishing a clear reading hierarchy: DETAILS tells
you _what_, RESULT tells you _how it went_, and everything else recedes.

---

## 2. Design Principles

### 2.1 One loud thing per row

A row should have at most one element at high visual weight. For tool rows that
element is DETAILS (the filename or command). For failure rows, RESULT takes
over as the loudest element because the _outcome_ is more important than the
_target_ when something goes wrong.

Two saturated colors on the same row create visual competition — the eye
ping-pongs between them. This is why we never pair a bright blue agent label
with an amber result badge. Only one wins.

### 2.2 Details-first reading flow

The user's natural reading direction in a left-to-right table is TIME → ACTOR
→ ACTION → DETAILS. But the _informational_ priority is the reverse:

```
DETAILS  →  what happened       (highest priority)
RESULT   →  how it went         (high, when present)
ACTION   →  what kind of thing  (medium-low)
ACTOR    →  who did it          (low)
TIME     →  when                (lowest)
```

We enforce this priority through contrast. The leftmost columns (TIME, ACTOR)
are the dimmest. DETAILS gets the brightest default text. This means the eye
_starts_ scanning from the left for spatial orientation but _lands_ on DETAILS
for content.

### 2.3 Quiet success, loud failure

Success is the baseline state of the system. In a healthy session, 90%+ of rows
are successful tool calls. If every success row glows green, the feed becomes
a wall of green where failures are just a different shade of bright.

By making success _invisible_ (muted text, no background badge), we establish
a quiet baseline. When a failure appears in red, it breaks the pattern
immediately. No scanning needed — the anomaly finds the user.

This is the same principle behind monitoring dashboards: green-everything means
nothing is wrong, but also nothing is readable. The best dashboards are mostly
gray, with red for the one thing that matters.

### 2.4 Color as semantics, not decoration

Every color choice must answer: "what does this color _mean_?"

- Red means something failed or was blocked
- Amber means something is empty, zero, or cautionary
- Blue means narrative (a human or agent is speaking, not executing)
- Bright neutral means content worth reading
- Dim neutral means structural/contextual information

If a color doesn't map to one of these meanings, it shouldn't be there. The
action pills are the one exception — they use family tints (warm/cool) to
_classify_ the action type. But even those are kept desaturated enough that
they read as "tinted label" rather than "status indicator."

---

## 3. Column Roles and Visual Treatment

### 3.1 TIME

**Role:** Chronological anchor. Helps the user orient within a session.

**Visual weight:** Lowest. The user glances at TIME to answer "when was this?"
but never needs it urgently. It should be visible but never compete with content.

**Treatment:**
- Always `theme.textMuted` regardless of row class
- Format: `HH:MM` (5 characters fixed)
- No special coloring for any row type — if a failure happened at 17:41,
  the timestamp doesn't need to be red

**Reasoning:** Timestamps are metadata. Making them bright would waste
visual budget on information that's only useful for correlation ("when did the
failure happen relative to the edit?"), not for primary comprehension.

### 3.2 ACTOR

**Role:** Identifies who produced the row — the root agent, a subagent, the
user, or the system.

**Visual weight:** Low. In most sessions, the same actor produces many
consecutive rows, so the column is repetitive. Duplicate suppression (showing
`·` instead of repeating `AGENT`) already handles this.

**Treatment:**
- `theme.textMuted` for all actors
- Duplicate actors collapse to `·` in `theme.textMuted`
- Width: 6-8 characters (down from current 10)
- Compact labels: `AGENT`, `SUB`, `USER`, `SYS`

**Reasoning:** The actor is context, not content. You need to know _who_ is
acting, but once established (usually by the first row in a sequence), it
doesn't need to keep announcing itself. Narrowing the column reclaims space
for DETAILS.

### 3.3 ACTION

**Role:** Compact type classifier. Tells you the operation _kind_ without
forcing you to parse DETAILS.

**Visual weight:** Medium-low. ACTION exists so you can visually distinguish
"this row is a file read" from "this row is a bash command" without reading the
detail text. But it should never be brighter than the detail text it
accompanies.

**Treatment:**
- Dot-and-label pill format: `● Read`, `● Bash`, `● Spawn`
- Desaturated family palettes (see Section 5)
- Blank for agent message rows (no synthetic `Agent` pill)
- `Spawn` for subagent start, `Return` for subagent stop

**Reasoning for pills over plain text:** The pill format (colored dot + tinted
background label) provides two benefits:
1. The dot creates a vertical rhythm that helps the eye track rows
2. The background tint groups tool families visually (all file ops share a
   cool blue; all mutations share warm amber)

**Reasoning for desaturation:** The current pills are vivid — `#7dd3fc` for
safe tools, `#fbbf24` for mutating tools. These bright colors compete with
DETAILS for attention. By desaturating ~30%, the pills still classify but stop
shouting. The dot color remains slightly more saturated than the label to serve
as the primary anchor point within the pill.

**Reasoning for blank agent messages:** Agent prose rows don't represent an
_action_. Showing `● Agent` as if "Agent" is a tool creates false parallelism.
A blank ACTION cell signals "this row is narrative, not operational" — the
absence of a pill is itself informative.

### 3.4 DETAILS

**Role:** Primary narrative surface. The most important column. This is where
the user reads what actually happened.

**Visual weight:** Highest for content text. This column gets `theme.text`
(the brightest neutral) by default, making it the natural landing point for
the eye.

**Treatment by segment role:**
- **Filename** (`/tests/faq.spec.ts`): `theme.text` — bright, the scan anchor
- **Directory prefix** (`/tests/`): `theme.textMuted` — dim the structural path
- **Command/target** (`npx playwright test ...`): `theme.text` — readable content
- **Agent prose** (`Good progress — 35 passed`): `chalk.dim(theme.status.info)` — dimmed blue
- **Lifecycle text** (`Session started`): `chalk.dim(theme.textMuted)` — barely visible
- **Error context** (`ENOENT: no such file`): `theme.text` — keep readable; the red is in RESULT

**Why segment-based coloring matters:**

The current implementation has a critical bottleneck in `FeedRow.tsx` where
the `cell()` wrapper is applied to the DETAILS column:

```ts
const detail = cell(
    formatDetails({...}),
    focused ? theme.text : theme.textMuted,
);
```

This `cell()` call strips all ANSI codes from the formatted details and
replaces them with a single flat color. The rich segment system in
`renderSegments()` — which already knows how to color filenames brighter
than verbs — gets completely flattened to `textMuted`.

Removing this override is the single highest-leverage visual change. It
immediately makes filenames scannable, agent prose distinguishable, and
the DETAILS column genuinely useful at a glance.

**Why agent prose gets dimmed blue, not full blue:**

Full `theme.status.info` (`#58a6ff`) is the same brightness as
`theme.accent`, which is used for the focus indicator and links. In a feed
with frequent agent messages, that much blue competes with the focus bar.

`chalk.dim(chalk.hex(theme.status.info))` drops the blue to roughly a
`#3d7ab8` range — still recognizably blue (so you know it's narrative, not
a tool operation), but low enough that it doesn't dominate the feed. The
blue _tint_ says "someone is talking," while the _dimming_ says "this is
commentary, not an alert."

### 3.5 RESULT

**Role:** Primary status/outcome lane. The only column where semantic status
color appears.

**Visual weight:** High when present, zero when absent. RESULT is right-aligned
and only populated when the row has a meaningful outcome. Empty RESULT cells
don't waste visual attention.

**Treatment by outcome type:**
- **Routine success** (`exit 0`, `replaced 2→2 lines`): `theme.textMuted`
- **Notable success** (`42 files`, `200 passed`): `theme.textMuted`
- **Zero/empty** (`0 files`, `0 found`): `theme.status.warning`
- **Failure** (`exit 1`, `denied`, `ENOENT`): `theme.status.error`
- **Milestone** (run completion): `chalk.dim(theme.status.success)` (rare)

**Why no background badges:**

The current design uses filled background badges: green `bgHex('#10321d')` for
success, amber `bgHex('#4a3a0c')` for zero results. These create "visual speed
bumps" — rectangular colored blocks that interrupt the vertical scan rhythm.

When 90% of rows have green badges, the badges stop conveying information.
They become decoration. The eye learns to ignore them, which means the amber
badge for `0 files` also gets lost in the noise.

Text-only coloring creates a cleaner vertical gutter. The column reads as a
smooth stream of dim gray text (successes) with occasional pops of red
(failures) or amber (zeros). No rectangles. No visual interruptions. The
anomalies find the user instead of the user hunting for them.

**One exception:** If a specific use case demands a badge (e.g., run-level
completion or session summary), a single badge on a rare row is acceptable.
The rule is: badges are for milestones, not for every tool call.

---

## 4. Row Classes

Not all rows are equal. The feed contains fundamentally different kinds of
information, and each kind deserves a distinct visual treatment.

### 4.1 Tool execution rows

The workhorse of the feed. These rows represent concrete actions: reading
files, editing code, running commands, searching.

```
17:42  ·      Edit   /tests/profile.spec.ts                   replaced 12→15 lines
```

**Character:** Workmanlike. Neutral. The content matters more than the event.

**Rules:**
- DETAILS at `theme.text` — this is the primary information
- RESULT at `theme.textMuted` for success, `theme.status.error` for failure
- ACTION pill classifies the tool family but doesn't add emphasis
- The row should feel like a log line, not an announcement

### 4.2 Agent narrative rows

Agent messages are qualitatively different from tool calls. They're
_commentary_ — progress updates, reasoning, summaries. They deserve a
different visual register to signal "this is prose, not an operation."

```
17:44  AGENT         Good progress — 35 passed, 6 still failing
```

**Character:** Conversational. Slightly set apart from the operational rows.

**Rules:**
- ACTION is blank — agents don't perform a "tool" when speaking
- DETAILS in `chalk.dim(theme.status.info)` — the blue tint distinguishes
  prose from operations, but dimming keeps it from dominating
- RESULT is empty
- The row should feel like a brief aside from a colleague, not a status badge

**Why blue and not plain text?**

If agent messages were the same brightness and color as tool DETAILS, there
would be no way to distinguish "the agent said something" from "the agent
did something" without reading every word. The blue tint provides a fast
visual cue: "skip this if you're scanning for operations, read this if you
want context."

### 4.3 Subagent lifecycle rows

Subagent spawning and returning are structural events — they mark boundaries
in the work. They need to be visible (so the user knows a subagent is
active) but not as prominent as the work the subagent actually does.

```
17:46  AGENT  Spawn   General Purpose — Browse and fix FAQ page...
17:51  SUB    Return  Fixed FAQ selectors and updated assertions
```

**Character:** Transitional. Marks a boundary, then gets out of the way.

**Rules:**
- Spawn: ACTION pill in subagent family tint, DETAILS at `theme.text`
- Return: ACTION pill in dimmer subagent tint, DETAILS at `theme.textMuted`
- Return RESULT: `theme.textMuted` when a completion summary exists
  (e.g., "Fixed FAQ selectors", "All 14 tests pass"), blank (`—`) when
  the subagent has no meaningful outcome to report
- Spawn is slightly brighter than Return because starting is more
  informational than stopping

**Why Spawn > Return in visual weight?**

The spawn row answers "what is this subagent going to do?" — that's useful
context. The return row answers "it's done" — which is less useful because
you can infer it from the absence of further SUB rows. So spawn gets full
brightness, return dims.

The return row "gets out of the way" by dimming DETAILS, not by hiding
RESULT. When the subagent produced a concrete outcome (test counts, a
summary sentence), that outcome still appears in RESULT at `textMuted` —
quiet enough to maintain the subdued feel, present enough that the user
doesn't have to expand the row to learn what the subagent accomplished.

### 4.4 Lifecycle and control rows

Session start/end, run start/end, permission bookkeeping, stop flow events.
These are system plumbing. Important for debugging, irrelevant for daily use.

```
17:30  SYS           Session started from resume
```

**Character:** Nearly invisible. Like commit hashes in a git log — there if
you need them, ignorable otherwise.

**Rules:**
- Everything at `chalk.dim(theme.textMuted)` — the dimmest level
- No ACTION pill (or dim neutral if one is needed)
- These rows should almost disappear in normal scrolling

### 4.5 Error and failure rows

The rows that actually matter. When something fails, the user needs to find
it fast.

```
17:41  AGENT  Bash   npx playwright test tests/faq.spec.ts       Exit code 1
```

**Character:** Unmistakable. Red RESULT breaks the gray baseline immediately.

**Rules:**
- DETAILS stays at `theme.text` — the user needs to read what failed
- RESULT at `theme.status.error` — this is the signal
- ACTION pill keeps its family tint (don't also make the pill red)
- The error signal comes from one place (RESULT), not three

**Why not red DETAILS too?**

Red text is harder to read than neutral text, especially on dark backgrounds.
If both DETAILS and RESULT are red, you have a wall of red that's hard to
parse. Keeping DETAILS neutral means the user can comfortably read the file
path or command, then glance right to see the red outcome. Information and
status in separate lanes.

---

## 5. Action Pill Palettes

### 5.1 Design intent

Pills classify, they don't emphasize. Think of them as colored labels on
manila folders — enough tint to sort by family, not enough to distract from
the document inside.

### 5.2 Family definitions

**File-read** — Cool, receded. Reading doesn't change state; the pill should
feel passive.

```
Dot: #2d8abf    Pill BG: #0e2233    Pill FG: #5ba3cc
Tools: Read, Glob, Grep, WebFetch, WebSearch, Find, Inspect, Snapshot
```

**File-mutate** — Warm, slightly more present than file-read. Mutations
deserve a bit more attention because they change state.

```
Dot: #b8862e    Pill BG: #2a1d0a    Pill FG: #d4a44a
Tools: Edit, Write, Bash, Notebook, TodoWrite
```

**Browser** — Teal, distinct from both file families. Browser operations are
a different domain (web, not filesystem) and deserve their own visual lane.

```
Dot: #2aaa9e    Pill BG: #0b2625    Pill FG: #5cc4ba
Tools: Navigate, Click, Type, Press, Select, Hover, Scroll, Close
```

**Subagent** — Green-tinted, signals delegation. The green connotes
"something is happening elsewhere."

```
Dot: #2ea87a    Pill BG: #0a2e22    Pill FG: #5cc4a0    (Spawn)
Dot: #2ea87a    Pill BG: #0a2e22    Pill FG: #468e78    (Return — dimmer FG)
```

**Skill** — Pink-tinted. Skills are user-defined extensions; the distinct
hue helps the user notice when a skill is invoked vs. a built-in tool.

```
Dot: #b06a9e    Pill BG: #2a0f24    Pill FG: #c98ab8
```

**Neutral** — Gray fallback for unknown or uncategorized tools.

```
Dot: #5a6270    Pill BG: #141a22    Pill FG: #7d8590
```

### 5.3 Comparison with current palettes

| Family      | Current Dot | New Dot  | Current FG | New FG   | Change           |
|-------------|-------------|----------|------------|----------|------------------|
| file-read   | `#38bdf8`   | `#2d8abf`| `#7dd3fc`  | `#5ba3cc`| -30% saturation  |
| file-mutate | `#f59e0b`   | `#b8862e`| `#fbbf24`  | `#d4a44a`| -30% saturation  |
| browser     | (was safe)  | `#2aaa9e`| (was safe) | `#5cc4ba`| new family       |
| subagent    | `#34d399`   | `#2ea87a`| `#6ee7b7`  | `#5cc4a0`| -25% saturation  |
| skill       | `#f472b6`   | `#b06a9e`| `#f9a8d4`  | `#c98ab8`| -25% saturation  |
| neutral     | `#6b7280`   | `#5a6270`| `#9ca3af`  | `#7d8590`| -15% brightness  |

The direction is consistent: lower saturation, lower brightness, same hue.
The pills remain distinguishable from each other but no longer compete with
DETAILS text.

### 5.4 Pill rendering format

```
 ● Label
 ↑ ↑     ↑
 │ │     └─ trailing padding (plain spaces to fill column width)
 │ └─────── label text on tinted background: bgHex(pillBG).hex(pillFG)
 └───────── dot in dot color: hex(dot)
```

The space before the dot, the dot itself, and the space between dot and label
provide consistent left-alignment. The trailing padding ensures pills don't
bleed into DETAILS.

---

## 6. Focused Row

### 6.1 Purpose

The focus indicator tells the user which row their cursor is on. It needs to
be visible but shouldn't destroy the row's content hierarchy.

### 6.2 Treatment

```
Element            Treatment
─────────────────────────────────────────────
Background         bgHex('#1b2a3f') — blue-tinted dark (keep current)
Gutter             accent ▎ — blue left border (keep current)
TIME, ACTOR        theme.text — brighten metadata on focus
DETAILS            theme.text — already bright, stays bright
ACTION pill        PRESERVE pill styling — do not override
RESULT             PRESERVE semantic color — do not override
```

### 6.3 What changes from current

Currently, `FeedRow.tsx` applies `rowTextOverrideColor` to the tool cell:

```ts
const tool = cell(formatTool(...), rowTextOverrideColor);
```

This strips the pill's family tint and renders it as flat `theme.text`. The
pill — the most recognizable visual landmark on the row — disappears when
focused.

Similarly, the current event override logic:

```ts
if (entry.opTag === 'tool.ok') return theme.status.success;
```

…turns focused success rows green, which contradicts the "quiet success"
principle.

**Fix:** Remove the override for ACTION pills. Remove the success-green
override for events (EVENT is gone anyway). Let the focus background alone
indicate "this row is selected." The content inside stays faithful to its
semantic coloring.

---

## 7. Row Striping

### 7.1 Purpose

Alternating row backgrounds help the eye track horizontally across wide
tables. Without striping, it's easy to misread which RESULT belongs to
which DETAILS on a wide terminal.

### 7.2 Current problem

The stripe background is `#070e16` against a terminal background that's
typically `#0d1117`. That's a luminance delta of ~3%. On most monitors,
this is invisible.

### 7.3 New value

```
feed.stripeBackground: #0d1521
```

This creates a ~8% luminance delta — perceptible as a subtle alternation
but not strong enough to create a "zebra" pattern that competes with
content. The slightly blue-shifted tint keeps it harmonious with the
overall cool-dark palette.

### 7.4 Alternative considered

Instead of background striping, we considered a left-border approach (dim
colored `▎` on alternating rows). This works well in some UIs but conflicts
with the existing gutter system (focus border, search match, user border).
Background striping is simpler and doesn't overload the gutter channel.

---

## 8. Headers and Borders

### 8.1 Headers

```
TIME  ACTOR  ACTION  DETAILS                                    RESULT
```

**Current:** `feed.headerLabel` at `#484f58` — too dim, barely visible.

**New:** `feed.headerLabel` at `#6e7681` (same as `theme.textMuted`) — matches
the dim metadata text level. Headers should be visible enough to orient the
user but never brighter than content.

**Reasoning:** Headers are structural labels. They answer "what column is
this?" — a question the user asks once and then stops asking. They should be
readable on first glance but invisible during sustained scanning.

### 8.2 Frame borders

**Current:** `theme.border` at `#1e2a38` — functional but prominent.

**New:** Apply `chalk.dim()` to `theme.border` — softer vertical and
horizontal rules.

**Reasoning:** The frame should contain the feed, not compete with it. A dim
border creates the "viewport" feeling without adding visual weight. The feed
content itself provides enough structure through column alignment; heavy
borders are redundant.

### 8.3 Header divider

The horizontal line between the header and the first content row:

**Current:** Full `theme.border` horizontal rule.

**New:** `chalk.dim(theme.border)` — same color as the frame, keeping the
grid visually light.

---

## 9. Visual Weight Ladder

The complete hierarchy from loudest to quietest:

```
Level  Token                          Hex (dark)  Usage
─────────────────────────────────────────────────────────────────
  1    theme.status.error             #f85149     Failures in RESULT
  2    theme.status.warning           #d29922     Zero-results in RESULT
  3    chalk.dim(theme.status.info)   ~#3d7ab8    Agent prose in DETAILS
  4    theme.text                     #c9d1d9     Filenames, commands, active DETAILS
  5    ACTION pill foreground         ~#5ba3cc    Tool family classifier
  6    theme.textMuted                #6e7681     TIME, ACTOR, paths, routine RESULT, headers
  7    chalk.dim(theme.textMuted)     ~#3d4148    Lifecycle rows, borders, elapsed times
```

Seven levels. The feed lives at levels 4–6. Levels 1–3 are reserved for
exceptions and narrative. Level 7 is for infrastructure that should
nearly disappear.

**How to read this ladder:** If you're adding a new visual element to the
feed, find which level it belongs to based on how urgently the user needs
to see it. Don't invent new colors — map to an existing level. If it
doesn't fit any level, reconsider whether it needs to be visible at all.

---

## 10. Theme Token Changes

Only two feed-specific token values change:

```
feed.headerLabel:       #484f58 → #6e7681
feed.stripeBackground:  #070e16 → #0d1521
```

No new tokens are added. The ACTION pill palettes remain as implementation
constants in `cellFormatters.ts` — they're rendering details, not semantic
theme tokens.

Light and high-contrast themes should follow the same principles:
- Light: stripe should be a subtle warm gray (`#f0f2f5` area)
- High-contrast: stripe should have ~10% luminance delta

---

## 11. Row Class × Column Matrix

The complete truth table. Each cell is a token or treatment.

```
                    TIME            ACTOR           ACTION              DETAILS             RESULT
─────────────────────────────────────────────────────────────────────────────────────────────────────────
Tool success        textMuted       textMuted       pill(family)        text                textMuted
Tool failure        textMuted       textMuted       pill(family)        text                status.error
Agent message       textMuted       textMuted       (blank)             dim(status.info)    —
Subagent spawn      textMuted       textMuted       pill(subagent)      text                —
Subagent return     textMuted       textMuted       pill(sub,dimmer)    textMuted           textMuted
Lifecycle           dim(textMuted)  dim(textMuted)  —                   dim(textMuted)      —
User prompt         textMuted       textMuted       (blank)             text                —
Error/block         textMuted       textMuted       pill(family)        text                status.error
Zero-result         textMuted       textMuted       pill(family)        text                status.warning
```

Rules encoded in this matrix:

1. TIME and ACTOR never change color based on row class
2. ACTION pill color is always family-based, never outcome-based
3. DETAILS is `theme.text` for everything except narrative and lifecycle
4. RESULT is the only column that uses status colors
5. Agent messages are the only row class that tints DETAILS

---

## 12. Implementation Priority

Ordered by visual impact:

1. **Remove the DETAILS `cell()` override** — let segment roles control
   color. This single change makes filenames scannable and agent prose
   distinguishable.

2. **Update feed.headerLabel and feed.stripeBackground** — two token value
   changes that improve header visibility and row tracking.

3. **Preserve pill colors on focused rows** — remove the
   `rowTextOverrideColor` override on the ACTION cell.

4. **Desaturate ACTION pill palettes** — update the palette constants in
   `cellFormatters.ts` to the new values.

5. **Remove RESULT background badges** — switch to text-only coloring with
   semantic tokens. Muted for success, red for failure, amber for zero.

6. **Add browser pill family** — separate browser/MCP tools from the
   file-read family.

7. **Implement blank ACTION for agent messages** — remove the synthetic
   `Agent` pill from `defaultEventPillLabel()`.

---

## 13. Before and After

### Current

```
TIME  EVENT        ACTOR       TOOL                 DETAILS                              RESULT
─────────────────────────────────────────────────────────────────────────────────────────────────────
17:41 Tool OK      SUB AGENT   ● Edit               /tests/faq.spec.ts                   [replaced 2→2 lines]
17:41 Tool OK      ·           ● Edit               /tests/faq.spec.ts                   [replaced 4→5 lines]
17:41 Tool Fail    ·           ● Bash               npx playwright test ...              [Exit code 1]
17:43 Agent Msg    AGENT       ● Agent              All 3 files have been fixed.
17:43 Sub Stop     SUB AGENT   ● General Purpose    id:a3011b5c771deb81e
```

Everything at similar brightness. EVENT and TOOL both claim attention.
Green badges on every success row. Agent gets a fake tool pill.

### Proposed

```
TIME  ACTOR  ACTION              DETAILS                                           RESULT
────────────────────────────────────────────────────────────────────────────────────────────────
17:41 SUB    ● Edit              /tests/faq.spec.ts                                replaced 2→2 lines
17:41 ·      ● Edit              /tests/faq.spec.ts                                replaced 4→5 lines
17:41 ·      ● Bash              npx playwright test tests/faq.spec.ts             Exit code 1
17:43 AGENT                      All 3 files have been fixed.
17:43 ·      Return              Fixed FAQ selectors and updated assertions
```

DETAILS dominates. RESULT is plain text (dim gray for success, red for
Exit code 1). Agent message has no pill — the dimmed blue text alone
says "this is narrative." Return replaces Sub Stop. EVENT column is gone,
freeing ~14 characters for DETAILS.

---

## 14. Open Questions (Resolved)

**Q: Should zero-result outcomes stay amber?**
A: Yes. Zero is not success and not failure — it's a caution signal. The user
should notice `0 files` because it often means the search was wrong. Amber at
`theme.status.warning` is appropriate.

**Q: Should RESULT use badges for milestones?**
A: Acceptable for rare events (run completion, session summary) where the badge
serves as a visual "chapter break." Not for per-tool outcomes.

**Q: Should agent prose be full blue or dimmed?**
A: Dimmed. Full `theme.status.info` at `#58a6ff` has the same luminance as the
focus accent. `chalk.dim()` brings it to ~`#3d7ab8` — still blue, still
distinguishable from gray tool rows, but not competing with the focus bar or
error indicators.
