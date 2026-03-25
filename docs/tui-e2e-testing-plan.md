# TUI E2E Testing Plan — tmux-based Approach

## Overview

Add full end-to-end testing for the Athena CLI terminal UI using tmux as the automation layer. The app is a React/Ink TUI — tmux lets us launch it in a virtual terminal, send real keystrokes, capture the rendered screen buffer, and assert against what a user would actually see.

This complements the existing 207 unit/component tests (vitest + ink-testing-library) by testing the assembled application end-to-end.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Vitest Test Runner                             │
│                                                 │
│  ┌───────────────┐    ┌──────────────────────┐  │
│  │  Test File     │    │  TmuxHarness         │  │
│  │               │───▶│                      │  │
│  │  it('...')    │    │  launch(cmd, opts)    │  │
│  │  send(keys)   │    │  send(keys)          │  │
│  │  waitFor(txt) │    │  capture(): string   │  │
│  │  screen()     │    │  waitFor(text, ms)   │  │
│  │               │    │  destroy()           │  │
│  └───────────────┘    └──────┬───────────────┘  │
│                              │                  │
└──────────────────────────────┼──────────────────┘
                               │  execSync / spawn
                    ┌──────────▼──────────┐
                    │  tmux session       │
                    │  (detached, fixed   │
                    │   120x40 terminal)  │
                    │                     │
                    │  ┌───────────────┐  │
                    │  │ node dist/    │  │
                    │  │   cli.js      │  │
                    │  │  (Ink app)    │  │
                    │  └───────────────┘  │
                    └─────────────────────┘
```

---

## Phase 1: Test Harness (`src/e2e/harness.ts`)

A reusable `TmuxHarness` class that wraps all tmux interaction.

### API

```typescript
interface TmuxHarnessOptions {
	cols?: number; // default 120
	rows?: number; // default 40
	env?: Record<string, string>;
	cwd?: string;
}

class TmuxHarness {
	constructor(sessionName: string, opts?: TmuxHarnessOptions);

	/** Launch the app in a detached tmux session */
	launch(command: string): void;

	/** Send keys (named keys like Enter, C-c, Up, or literal text with -l) */
	send(keys: string): void;

	/** Send literal text (always uses -l flag) */
	type(text: string): void;

	/** Send a sequence of keys with delay between each */
	sendSequence(keys: string[], delayMs?: number): Promise<void>;

	/** Capture the current visible pane content (ANSI stripped) */
	screen(): string;

	/** Capture with ANSI escape codes preserved (for color assertions) */
	screenRaw(): string;

	/** Poll until text appears on screen, throw after timeout */
	waitFor(text: string, timeoutMs?: number): Promise<void>;

	/** Poll until text disappears from screen */
	waitForGone(text: string, timeoutMs?: number): Promise<void>;

	/** Poll until a regex matches the screen content */
	waitForMatch(pattern: RegExp, timeoutMs?: number): Promise<string>;

	/** Kill the tmux session */
	destroy(): void;

	/** Check if the tmux session is still alive */
	isAlive(): boolean;
}
```

### Implementation Details

| Concern              | Approach                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------- |
| **Session naming**   | `athena-e2e-{testId}-{pid}` — unique per test, safe for parallelism                       |
| **Dimensions**       | Fixed `120x40` by default — deterministic line wrapping                                   |
| **Polling interval** | 150ms for `waitFor`, configurable                                                         |
| **Default timeout**  | 10s for `waitFor` (Ink startup + harness spawn can be slow)                               |
| **Cleanup**          | `afterEach` hook calls `destroy()`, plus a process-exit safety net via `tmux kill-server` |
| **ANSI stripping**   | `capture-pane -p` strips by default; `-e` flag for raw                                    |
| **Error output**     | On `waitFor` timeout, dump last screen capture into the error message for debugging       |

### Guard Rails

- **Pre-flight check**: verify `tmux` is installed, error with install instructions if missing
- **Orphan cleanup**: register `process.on('exit')` to kill any sessions matching `athena-e2e-*`
- **CI detection**: if `CI=true`, increase default timeouts by 2x

---

## Phase 2: Test Fixtures & Helpers (`src/e2e/fixtures.ts`)

### Mock Harness Strategy

The app spawns a real AI harness subprocess (Claude/Codex). For E2E tests, we need a predictable substitute:

1. **Use the existing mock harness** — check `src/harnesses/mock/` for an existing mock harness adapter
2. **Env-based override** — launch with `ATHENA_HARNESS=mock` or similar config to avoid real API calls
3. **Fallback**: If no mock harness exists, tests can exercise harness-independent flows (setup wizard, session picker, command system, navigation, theming)

### Fixtures

```typescript
/** Launch athena with standard test config */
function launchAthena(
	harness: TmuxHarness,
	opts?: {
		theme?: 'dark' | 'light' | 'high-contrast';
		ascii?: boolean;
		flags?: string[];
	},
): Promise<void>;

/** Launch athena in exec mode (non-interactive) */
function launchExec(harness: TmuxHarness, prompt: string): Promise<void>;

/** Navigate through setup wizard with defaults */
async function completeSetup(
	harness: TmuxHarness,
	choices?: {
		theme?: number; // 0-indexed step selection
		harness?: number;
		workflow?: number;
	},
): Promise<void>;
```

---

## Phase 3: Test Coverage Plan

### Priority 0 — Smoke (must pass for any CI gate)

| Test ID         | Flow                         | Assertions                                 |
| --------------- | ---------------------------- | ------------------------------------------ |
| `E2E-SMOKE-001` | App launches without crash   | Screen contains header elements within 10s |
| `E2E-SMOKE-002` | App exits cleanly on `/quit` | tmux session terminates, no error output   |
| `E2E-SMOKE-003` | `Ctrl+C` sends interrupt     | App handles gracefully (no crash)          |

### Priority 1 — Setup Wizard

| Test ID         | Flow                         | Keys                    | Assertions                    |
| --------------- | ---------------------------- | ----------------------- | ----------------------------- |
| `E2E-SETUP-001` | Theme selection              | `Down`, `Down`, `Enter` | Selected theme name appears   |
| `E2E-SETUP-002` | Harness selection            | `Down`, `Enter`         | Selected harness name appears |
| `E2E-SETUP-003` | Full wizard completion       | Navigate all steps      | Returns to main shell         |
| `E2E-SETUP-004` | Wizard re-entry via `/setup` | Type `/setup`, `Enter`  | Wizard screen renders         |

### Priority 1 — Command System

| Test ID       | Flow                   | Keys                         | Assertions                      |
| ------------- | ---------------------- | ---------------------------- | ------------------------------- |
| `E2E-CMD-001` | `/help` lists commands | Type `/help`, `Enter`        | Screen lists available commands |
| `E2E-CMD-002` | `/clear` clears feed   | Type `/clear`, `Enter`       | Feed content removed            |
| `E2E-CMD-003` | `/stats` shows metrics | Type `/stats`, `Enter`       | Duration, tool count visible    |
| `E2E-CMD-004` | Command autocomplete   | Type `/`, wait               | Suggestion dropdown appears     |
| `E2E-CMD-005` | Unknown command        | Type `/nonexistent`, `Enter` | Error or no-op, no crash        |

### Priority 1 — Navigation & Input

| Test ID       | Flow                 | Keys                     | Assertions                                 |
| ------------- | -------------------- | ------------------------ | ------------------------------------------ |
| `E2E-NAV-001` | Feed scroll up/down  | `Up`, `Down`             | Scroll indicator changes                   |
| `E2E-NAV-002` | Input history recall | Type text, `Enter`, `Up` | Previous input restored                    |
| `E2E-NAV-003` | Page up/down         | `PageUp`, `PageDown`     | Feed jumps by page                         |
| `E2E-NAV-004` | Home/End in input    | Type text, `Home`, `End` | Cursor moves (verify with insertion point) |

### Priority 1 — Session Management

| Test ID           | Flow                      | Keys                      | Assertions                |
| ----------------- | ------------------------- | ------------------------- | ------------------------- |
| `E2E-SESSION-001` | `/sessions` opens picker  | Type `/sessions`, `Enter` | Session list renders      |
| `E2E-SESSION-002` | Session picker navigation | `Down`, `Up` in picker    | Selection highlight moves |
| `E2E-SESSION-003` | Session picker dismiss    | `Escape`                  | Returns to main shell     |

### Priority 2 — Theming

| Test ID         | Flow                                | Assertions                  |
| --------------- | ----------------------------------- | --------------------------- |
| `E2E-THEME-001` | Launch with `--theme dark`          | Renders without error       |
| `E2E-THEME-002` | Launch with `--theme light`         | Renders without error       |
| `E2E-THEME-003` | Launch with `--theme high-contrast` | Renders without error       |
| `E2E-THEME-004` | Launch with `--ascii`               | No unicode glyphs in output |

### Priority 2 — Edge Cases & Resilience

| Test ID        | Flow              | Assertions                                                 |
| -------------- | ----------------- | ---------------------------------------------------------- |
| `E2E-EDGE-001` | Rapid key mashing | No crash after 50 rapid keystrokes                         |
| `E2E-EDGE-002` | Terminal resize   | `tmux resize-pane -t ... -x 80 -y 24` — re-renders cleanly |
| `E2E-EDGE-003` | Very long input   | 500+ char input — no crash, handles gracefully             |
| `E2E-EDGE-004` | Double `/quit`    | No error on second quit                                    |

### Priority 2 — Exec Mode (Non-interactive)

| Test ID        | Flow                                  | Assertions                          |
| -------------- | ------------------------------------- | ----------------------------------- |
| `E2E-EXEC-001` | `athena exec "test"`                  | Exits with code 0, output on stdout |
| `E2E-EXEC-002` | `athena exec --json "test"`           | Output is valid JSONL               |
| `E2E-EXEC-003` | `athena exec --timeout-ms 100 "slow"` | Exits with timeout error            |

---

## Phase 4: File Structure

```
src/
└── e2e/
    ├── harness.ts                 # TmuxHarness class
    ├── fixtures.ts                # Launch helpers, setup helpers
    ├── smoke.e2e.test.ts          # E2E-SMOKE-*
    ├── setup-wizard.e2e.test.ts   # E2E-SETUP-*
    ├── commands.e2e.test.ts       # E2E-CMD-*
    ├── navigation.e2e.test.ts     # E2E-NAV-*
    ├── sessions.e2e.test.ts       # E2E-SESSION-*
    ├── theming.e2e.test.ts        # E2E-THEME-*
    ├── edge-cases.e2e.test.ts     # E2E-EDGE-*
    └── exec-mode.e2e.test.ts      # E2E-EXEC-*
```

---

## Phase 5: Vitest Configuration

Add a separate vitest config for E2E tests to keep them isolated from unit tests:

```typescript
// vitest.e2e.config.ts
import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/e2e/**/*.e2e.test.ts'],
		testTimeout: 30_000, // E2E tests are slower
		hookTimeout: 15_000,
		pool: 'forks', // Process isolation — each test gets own tmux
		poolOptions: {
			forks: {singleFork: true}, // Sequential — avoid tmux session collisions
		},
		retry: 1, // One retry for flaky terminal timing
	},
});
```

Add a script to `package.json`:

```json
{
	"scripts": {
		"test:e2e": "vitest run --config vitest.e2e.config.ts",
		"test:e2e:watch": "vitest --config vitest.e2e.config.ts"
	}
}
```

---

## Phase 6: CI Integration

### Prerequisites

```yaml
# GitHub Actions
- name: Install tmux
  run: sudo apt-get install -y tmux

- name: Build CLI
  run: npm run build

- name: Run E2E tests
  run: npm run test:e2e
  env:
    CI: true
    ATHENA_HARNESS: mock # Avoid real API calls
```

### CI-specific considerations

- tmux runs headlessly — no display server needed
- Increase timeouts in CI (startup is slower)
- On failure, dump the last screen capture as a test artifact
- Consider recording tmux sessions with `script` for debugging

---

## Execution Order

| Step | Work                                            | Depends on |
| ---- | ----------------------------------------------- | ---------- |
| 1    | Build `TmuxHarness` class                       | —          |
| 2    | Build fixtures (launch helpers)                 | Step 1     |
| 3    | Write smoke tests (`E2E-SMOKE-*`)               | Steps 1-2  |
| 4    | Validate smoke tests pass locally               | Step 3     |
| 5    | Write P1 tests (setup, commands, nav, sessions) | Step 4     |
| 6    | Write P2 tests (theming, edge cases, exec mode) | Step 5     |
| 7    | Add vitest E2E config + npm script              | Step 3     |
| 8    | Add CI workflow                                 | Step 7     |

---

## Open Questions

1. **Mock harness availability** — Does `src/harnesses/mock/` provide a usable mock for full app launch? If not, tests will be limited to harness-independent UI flows, or we need to build one.
2. **Startup time** — How long does `node dist/cli.js` take to render the first frame? This determines base timeout values.
3. **Config isolation** — Tests need isolated config directories (`--project-dir` to a temp dir) to avoid polluting the developer's real config/sessions.
4. **Parallel execution** — Sequential is safer initially. Parallel can be explored later with unique tmux session names + isolated config dirs.
