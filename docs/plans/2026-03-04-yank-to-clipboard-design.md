# Yank-to-Clipboard Design

**Date:** 2026-03-04
**Status:** Approved

## Problem

Athena's terminal UI uses Ink which puts stdin in raw mode, preventing normal mouse text selection. In the pager view, SGR mouse tracking is enabled for scroll wheel support, which further blocks native text selection. Users need a way to copy feed item content (tool responses, agent messages, etc.) to the system clipboard.

## Solution

Add a `y` (yank) keybinding that copies the currently focused item's content to the clipboard using the OSC 52 terminal escape sequence.

## Clipboard Mechanism

**OSC 52** escape sequence: `\x1B]52;c;{base64_content}\x07`

- Zero external dependencies
- Works over SSH, tmux, containers
- Supported by modern terminals (iTerm2, kitty, Alacritty, WezTerm, Windows Terminal, ghostty)
- No platform detection needed

## Content Format

Content is copied as **markdown source / raw text** (not ANSI-formatted):

| Event Kind                        | Yanked Content                         |
| --------------------------------- | -------------------------------------- |
| `agent.message`                   | Raw `data.message` (markdown)          |
| `user.prompt`                     | Raw `data.prompt`                      |
| `tool.pre` / `permission.request` | JSON of `tool_input`                   |
| `tool.post` (paired)              | JSON of `tool_input` + `tool_response` |
| `tool.failure`                    | JSON of `tool_input` + error string    |
| `notification`                    | Raw `data.message`                     |
| `subagent.stop`                   | `last_assistant_message` if present    |
| Other                             | JSON of `event.data`                   |

## Keybinding

- **Feed view**: `y` copies cursor item's full details
- **Pager view**: `y` copies all pager content (ANSI-stripped, newline-joined)

## User Feedback

Transient "Copied to clipboard" message shown for ~1.5s after yank.

## Files

1. **`src/shared/utils/clipboard.ts`** (new) — `copyToClipboard(text: string)` via OSC 52
2. **`src/ui/utils/yankContent.ts`** (new) — `extractYankContent(entry: TimelineEntry): string`
3. **`src/ui/hooks/useFeedKeyboard.ts`** — add `y` handler
4. **`src/ui/hooks/usePager.ts`** — add `y` handler
5. **Toast/status state** — transient "Copied" feedback in AppShell
