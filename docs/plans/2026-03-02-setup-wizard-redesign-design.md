# Setup Wizard Redesign — Full-Frame Layout

**Date:** 2026-03-02
**Status:** Approved

## Problem

The current setup wizard renders as unframed floating text in the terminal. There are no visual boundaries between the header, step content, and keyboard hints. The progress bar uses crude `[====----]` characters. The selector is a bare `>` cursor with no visual weight. All keyboard hints are dumped in a single line regardless of context.

## Design: Full-Frame Wizard

A single box-drawing frame wraps the entire wizard with three distinct zones separated by horizontal tee dividers (`├───┤`).

### Visual Layout

```
┌─── ATHENA SETUP ─────────────────────────────────┐
│                                                    │
│  Configure your defaults in under a minute.        │
│  ◉ ○ ○ ○  Theme                                   │
│                                                    │
├────────────────────────────────────────────────────┤
│                                                    │
│  Choose your display theme                         │
│  The preview applies as you browse.                │
│                                                    │
│   > Dark                                           │
│     Light                                          │
│     High Contrast                                  │
│                                                    │
├────────────────────────────────────────────────────┤
│  ↑↓ move  ↵ select  s skip                        │
└────────────────────────────────────────────────────┘
```

### Three Zones

1. **Header** — Title embedded in top border line, subtitle text, step indicator dots + current step label.
2. **Content** — Step heading (bold, accent), description (muted), and selector or status indicator.
3. **Footer** — Context-sensitive keyboard hints, only showing relevant keys for current state.

### Step Indicator Dots

Replace `[====----]` with compact dot indicators:

- `◉` (accent) = current step
- `○` (textMuted) = pending
- `✓` (status.success) = completed

Glyphs used: `status.active`, `status.pending`, `todo.done`.

```
◉ ○ ○ ○  Theme           (step 1)
✓ ◉ ○ ○  Harness         (step 2)
✓ ✓ ✓ ◉  MCP Options     (step 4)
✓ ✓ ✓ ✓  Complete!       (done)
```

### Enhanced StepSelector

Add inverse-highlight on focused item (matching `OptionList` pattern) and optional description support:

```
 > e2e-test-builder           ← inverse bg, accent, bold
   Playwright-based browser test generation

   bug-triage (coming soon)   ← dimColor when disabled
   None - configure later
```

### Contextual Keyboard Hints

| State               | Hints                                   |
| ------------------- | --------------------------------------- |
| selecting (step 0)  | `↑↓ move  ↵ select  s skip`             |
| selecting (step 1+) | `↑↓ move  ↵ select  esc back  s skip`   |
| verifying           | _(no hints — spinner shown in content)_ |
| error               | `r retry  esc back`                     |
| success             | _(auto-advancing, no hints)_            |

### Frame Sizing

Frame width = `min(terminalColumns - 4, 60)`. Uses `useStdout().columns` for terminal awareness.

## Component Structure

```
SetupWizard.tsx              (orchestrator — logic unchanged)
├── WizardFrame.tsx           NEW  — box-drawing frame, 3 zones via children/props
│   renders: top border with title, tee dividers, bottom border
├── StepDots.tsx              NEW  — ◉ ○ ○ ○ + step label
├── WizardHints.tsx           NEW  — contextual keybinding bar
├── StepSelector.tsx          ENHANCED — inverse highlight + description
├── StepStatus.tsx            UNCHANGED
└── steps/                    MINOR — add descriptions to options
    ├── ThemeStep.tsx
    ├── HarnessStep.tsx
    ├── WorkflowStep.tsx
    └── McpOptionsStep.tsx
```

## What Stays the Same

- `useSetupState()` hook — same state machine
- `SetupResult` type
- Step callbacks (onComplete, onError, onSkip)
- Config writing via `writeGlobalConfig()`
- Auto-advance timer (500ms)
- Global `useInput` handler (Escape, S, R)
- All tests continue to pass (update snapshots for new visual output)
