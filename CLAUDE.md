# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

Athena (`@athenaflow/cli`) is a workflow runtime for Claude Code that adds structured workflows, real-time terminal observability, session persistence, and a plugin system. It intercepts Claude Code hooks via a UDS (Unix Domain Socket) protocol, normalizes events through a feed pipeline, and renders them in a React/Ink terminal UI.

## Commands

```bash
npm run build          # Build with tsup (ESM, two entry points)
npm run dev            # Build in watch mode
npm run start          # Build + run dist/cli.js
npm test               # vitest run (all tests)
npm run test:watch     # vitest in watch mode
npx vitest run src/path/to/file.test.ts   # Run a single test file
npm run typecheck      # tsc --noEmit
npm run lint           # prettier check + eslint
npm run lint:eslint    # eslint only
npm run format         # prettier --write
npm run lint:dead      # knip --strict (dead code detection)
```

## Architecture

### Layer Dependency Rules (enforced by ESLint)

```
shared  ← no imports from any other layer
core    ← no imports from app, harnesses
harnesses ← no imports from app, ui
ui      ← no imports from harnesses, infra; feed imports restricted to types only
app     ← can import from all layers
```

### Layers

- **`src/app/`** — CLI entry (`cli.tsx`), command executors, shell (`AppShell`), bootstrap, exec mode
- **`src/core/`** — Runtime abstraction (`RuntimeEvent`/`RuntimeDecision`), feed mapping pipeline, workflow state machine, controller
- **`src/harnesses/`** — Protocol adapters (Claude via UDS + hook-forwarder, Codex via HTTP, mock for testing). Each adapter maps protocol-specific payloads to normalized `RuntimeEvent`/`RuntimeDecision` types
- **`src/ui/`** — Ink/React components, ~30 custom hooks, theming, glyphs. Must stay harness-agnostic
- **`src/infra/`** — Session persistence (SQLite via better-sqlite3), plugin registry, marketplace resolution, telemetry
- **`src/shared/`** — Common types, utilities, constants. Must be boundary-neutral
- **`src/setup/`** — Setup wizard components and logic

### Key Patterns

**Hook Event Flow (Claude harness):** Claude Code hook fires → `hook-forwarder` (separate entry point, fast startup) reads `ATHENA_INSTANCE_ID` from env → connects to UDS at `.claude/run/ink-{instanceId}.sock` → sends `HookEventEnvelope` → waits for `HookResultEnvelope` → returns exit code (0=passthrough, 2=block). Fail-safe: always exits 0 on socket error.

**Feed Pipeline:** `RuntimeEvent` → `mapper.ts` normalizes to `FeedEvent[]` → stored in `IndexedTimeline` (in-memory) + `SessionStore` (SQLite) → consumed by React hooks (`useFeed`). This decouples runtime delivery from UI rendering.

**Workflow State Machine:** States: idle → starting → running → completing → done. Tracks iterations, completion markers, blocker detection. Persisted in SQLite `workflow_runs` table.

**Session Persistence:** SQLite with WAL mode, exclusive write lock, foreign keys. Schema version 5. Tables: `runtime_events`, `feed_events`, `adapter_sessions`, `workflow_runs`.

### Entry Points (tsup)

- `src/app/entry/cli.tsx` → `dist/cli.js` (main CLI: `athena` / `athena-flow`)
- `src/harnesses/claude/hook-forwarder.ts` → `dist/hook-forwarder.js` (hook interceptor: `athena-hook-forwarder`)

## Tech Stack

- TypeScript 5.7, Node.js 20+, ESM
- React 19 + Ink 6 (terminal UI)
- Vitest + ink-testing-library (testing)
- better-sqlite3 (session persistence)
- meow (CLI arg parsing)
- tsup (bundler, code splitting enabled)

## Code Conventions

- Strict TypeScript: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- Unused vars must be prefixed with `_`
- Conventional commits enforced by commitlint
- Pre-commit hook runs lint-staged (eslint + prettier on staged files)
- Legacy shim paths are banned — import from layer boundaries (`app/core/harnesses/infra/ui/shared`)
- UI components may only import from `feed/types.ts` and `feed/expandable.ts`, not stateful feed internals
