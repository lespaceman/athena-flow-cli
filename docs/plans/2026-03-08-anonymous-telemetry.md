# Anonymous Telemetry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add privacy-respecting, opt-out anonymous telemetry using PostHog to capture usage, stability, and growth metrics.

**Architecture:** A thin `src/infra/telemetry/` module wrapping `posthog-node`. Events are fired at app lifecycle points (bootstrap, session start/end, errors). Anonymous device ID (UUIDv4) stored in global config. Opt-out via config flag, CLI command, or env var.

**Tech Stack:** posthog-node, Node.js crypto (for UUID), existing AthenaConfig system

---

### Task 1: Install posthog-node dependency

**Files:**

- Modify: `package.json`

**Step 1: Install the dependency**

Run: `npm install posthog-node`

**Step 2: Verify installation**

Run: `npm ls posthog-node`
Expected: posthog-node listed in dependencies

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add posthog-node dependency for anonymous telemetry"
```

---

### Task 2: Add telemetry fields to AthenaConfig

**Files:**

- Modify: `src/infra/plugins/config.ts:28-44`
- Test: `src/infra/telemetry/__tests__/identity.test.ts`

**Step 1: Write failing test for device ID generation**

Create `src/infra/telemetry/__tests__/identity.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {generateDeviceId, isValidDeviceId} from '../identity';

describe('identity', () => {
	it('generates a valid UUIDv4', () => {
		const id = generateDeviceId();
		expect(isValidDeviceId(id)).toBe(true);
	});

	it('generates unique IDs', () => {
		const id1 = generateDeviceId();
		const id2 = generateDeviceId();
		expect(id1).not.toBe(id2);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/infra/telemetry/__tests__/identity.test.ts`
Expected: FAIL — module not found

**Step 3: Create identity module**

Create `src/infra/telemetry/identity.ts`:

```typescript
import {randomUUID} from 'node:crypto';

const UUID_V4_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function generateDeviceId(): string {
	return randomUUID();
}

export function isValidDeviceId(id: string): boolean {
	return UUID_V4_REGEX.test(id);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/infra/telemetry/__tests__/identity.test.ts`
Expected: PASS

**Step 5: Add `telemetry` and `deviceId` to AthenaConfig**

In `src/infra/plugins/config.ts`, add to the `AthenaConfig` type (after line 43):

```typescript
/** Whether anonymous telemetry is enabled (default: true, opt-out) */
telemetry?: boolean;
/** Anonymous device identifier (UUIDv4, not tied to user identity) */
deviceId?: string;
```

Also add to `readConfigFile`'s `raw` type (after line 82):

```typescript
telemetry?: boolean;
deviceId?: string;
```

And to the return object (after line 121):

```typescript
telemetry: raw.telemetry,
deviceId: raw.deviceId as string | undefined,
```

**Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 7: Commit**

```bash
git add src/infra/telemetry/identity.ts src/infra/telemetry/__tests__/identity.test.ts src/infra/plugins/config.ts
git commit -m "feat: add device ID generation and telemetry config fields"
```

---

### Task 3: Create telemetry client module

**Files:**

- Create: `src/infra/telemetry/client.ts`
- Test: `src/infra/telemetry/__tests__/client.test.ts`

**Step 1: Write failing test for telemetry client**

Create `src/infra/telemetry/__tests__/client.test.ts`:

```typescript
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {initTelemetry, shutdownTelemetry, isTelemetryEnabled} from '../client';

// Mock posthog-node at top level
vi.mock('posthog-node', () => {
	const PostHog = vi.fn().mockImplementation(() => ({
		capture: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
	}));
	return {PostHog};
});

describe('telemetry client', () => {
	beforeEach(() => {
		delete process.env['ATHENA_TELEMETRY_DISABLED'];
	});

	afterEach(() => {
		shutdownTelemetry();
	});

	it('is enabled by default', () => {
		initTelemetry({deviceId: 'test-id'});
		expect(isTelemetryEnabled()).toBe(true);
	});

	it('is disabled when config telemetry is false', () => {
		initTelemetry({deviceId: 'test-id', telemetryEnabled: false});
		expect(isTelemetryEnabled()).toBe(false);
	});

	it('is disabled when ATHENA_TELEMETRY_DISABLED env var is set', () => {
		process.env['ATHENA_TELEMETRY_DISABLED'] = '1';
		initTelemetry({deviceId: 'test-id'});
		expect(isTelemetryEnabled()).toBe(false);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/infra/telemetry/__tests__/client.test.ts`
Expected: FAIL — module not found

**Step 3: Implement telemetry client**

Create `src/infra/telemetry/client.ts`:

```typescript
import {PostHog} from 'posthog-node';

// PostHog write-only API key (safe to embed — cannot read data)
const POSTHOG_API_KEY = 'phc_PLACEHOLDER_REPLACE_WITH_REAL_KEY';
const POSTHOG_HOST = 'https://us.i.posthog.com';

let client: PostHog | null = null;
let deviceId: string | null = null;
let enabled = false;

export type TelemetryInitOptions = {
	deviceId: string;
	telemetryEnabled?: boolean;
};

export function initTelemetry(options: TelemetryInitOptions): void {
	const envDisabled = process.env['ATHENA_TELEMETRY_DISABLED'] === '1';
	enabled = (options.telemetryEnabled ?? true) && !envDisabled;

	if (!enabled) {
		return;
	}

	deviceId = options.deviceId;
	client = new PostHog(POSTHOG_API_KEY, {
		host: POSTHOG_HOST,
		disableGeoip: true,
		// Flush every 30s or 20 events, whichever comes first
		flushAt: 20,
		flushInterval: 30000,
	});
}

export function isTelemetryEnabled(): boolean {
	return enabled;
}

export function capture(
	event: string,
	properties?: Record<string, unknown>,
): void {
	if (!enabled || !client || !deviceId) {
		return;
	}

	client.capture({
		distinctId: deviceId,
		event,
		properties,
	});
}

export async function shutdownTelemetry(): Promise<void> {
	if (client) {
		await client.shutdown();
		client = null;
	}
	deviceId = null;
	enabled = false;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/infra/telemetry/__tests__/client.test.ts`
Expected: PASS

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/infra/telemetry/client.ts src/infra/telemetry/__tests__/client.test.ts
git commit -m "feat: add telemetry client with PostHog integration and opt-out support"
```

---

### Task 4: Create telemetry events module

**Files:**

- Create: `src/infra/telemetry/events.ts`
- Test: `src/infra/telemetry/__tests__/events.test.ts`

**Step 1: Write failing test for event tracking functions**

Create `src/infra/telemetry/__tests__/events.test.ts`:

```typescript
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import * as client from '../client';
import {trackAppLaunched, trackSessionEnded} from '../events';

vi.mock('../client', () => ({
	capture: vi.fn(),
	isTelemetryEnabled: vi.fn().mockReturnValue(true),
}));

describe('telemetry events', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('tracks app launched with correct properties', () => {
		trackAppLaunched({version: '1.0.0', harness: 'claude-code'});
		expect(client.capture).toHaveBeenCalledWith('app.launched', {
			version: '1.0.0',
			harness: 'claude-code',
			os: expect.any(String),
			nodeVersion: expect.any(String),
		});
	});

	it('tracks session ended with metrics', () => {
		trackSessionEnded({
			durationMs: 5000,
			toolCallCount: 10,
			subagentCount: 2,
			permissionsAllowed: 8,
			permissionsDenied: 1,
		});
		expect(client.capture).toHaveBeenCalledWith('session.ended', {
			durationMs: 5000,
			toolCallCount: 10,
			subagentCount: 2,
			permissionsAllowed: 8,
			permissionsDenied: 1,
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/infra/telemetry/__tests__/events.test.ts`
Expected: FAIL — module not found

**Step 3: Implement events module**

Create `src/infra/telemetry/events.ts`:

```typescript
import os from 'node:os';
import {capture} from './client';

function systemProps() {
	return {
		os: `${os.platform()}-${os.arch()}`,
		nodeVersion: process.version,
	};
}

export function trackAppInstalled(props: {
	version: string;
	harness: string;
}): void {
	capture('app.installed', {...props, ...systemProps()});
}

export function trackAppLaunched(props: {
	version: string;
	harness: string;
}): void {
	capture('app.launched', {...props, ...systemProps()});
}

export function trackSessionStarted(props: {
	harness: string;
	workflow?: string;
	model?: string;
}): void {
	capture('session.started', props);
}

export function trackSessionEnded(props: {
	durationMs: number;
	toolCallCount: number;
	subagentCount: number;
	permissionsAllowed: number;
	permissionsDenied: number;
}): void {
	capture('session.ended', props);
}

export function trackError(props: {
	errorName: string;
	stackTrace: string;
}): void {
	capture('app.error', props);
}

export function trackTelemetryOptedOut(): void {
	capture('telemetry.opted_out', {});
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/infra/telemetry/__tests__/events.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/infra/telemetry/events.ts src/infra/telemetry/__tests__/events.test.ts
git commit -m "feat: add telemetry event tracking functions"
```

---

### Task 5: Create barrel export

**Files:**

- Create: `src/infra/telemetry/index.ts`

**Step 1: Create index.ts**

Create `src/infra/telemetry/index.ts`:

```typescript
export {initTelemetry, shutdownTelemetry, isTelemetryEnabled} from './client';
export {generateDeviceId, isValidDeviceId} from './identity';
export {
	trackAppInstalled,
	trackAppLaunched,
	trackSessionStarted,
	trackSessionEnded,
	trackError,
	trackTelemetryOptedOut,
} from './events';
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/infra/telemetry/index.ts
git commit -m "feat: add telemetry barrel export"
```

---

### Task 6: Integrate telemetry into app bootstrap

**Files:**

- Modify: `src/app/entry/cli.tsx:208-388` (main function)
- Modify: `src/shared/utils/processRegistry.ts:98-110` (error handlers)

**Step 1: Initialize telemetry after config is loaded**

In `src/app/entry/cli.tsx`, add import at top:

```typescript
import {
	initTelemetry,
	shutdownTelemetry,
	generateDeviceId,
	trackAppLaunched,
	trackError,
} from '../../infra/telemetry/index';
import {writeGlobalConfig} from '../../infra/plugins/config';
```

In the `main()` function, after `bootstrapRuntimeConfig` succeeds (~line 309), add telemetry initialization:

```typescript
// Initialize telemetry
let resolvedDeviceId = globalConfig.deviceId;
if (!resolvedDeviceId) {
	resolvedDeviceId = generateDeviceId();
	writeGlobalConfig({deviceId: resolvedDeviceId});
}
initTelemetry({
	deviceId: resolvedDeviceId,
	telemetryEnabled: globalConfig.telemetry,
});
trackAppLaunched({version, harness: runtimeConfig.harness});
```

In the `main().catch()` error handler (~line 383), add error tracking:

```typescript
void main().catch(error => {
	trackError({
		errorName: error instanceof Error ? error.name : 'UnknownError',
		stackTrace: error instanceof Error ? (error.stack ?? '') : String(error),
	});
	shutdownTelemetry().finally(() => {
		console.error(
			`Error: ${error instanceof Error ? error.message : String(error)}`,
		);
		exitWith(1);
	});
});
```

**Step 2: Add telemetry shutdown to process cleanup**

In `src/shared/utils/processRegistry.ts`, the `uncaughtException` and `unhandledRejection` handlers (lines 99-110) already log and exit. We do NOT add telemetry here since `shared/` cannot import from `infra/`. Instead, the telemetry flush happens in `cli.tsx`'s error handler above and via a `beforeExit` handler:

In `src/app/entry/cli.tsx`, after the `initTelemetry` block, add:

```typescript
process.on('beforeExit', () => {
	void shutdownTelemetry();
});
```

**Step 3: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/entry/cli.tsx
git commit -m "feat: integrate telemetry into app bootstrap and error handling"
```

---

### Task 7: Add telemetry CLI command

**Files:**

- Create: `src/app/commands/builtins/telemetry.ts`
- Modify: `src/app/commands/builtins/index.ts`
- Modify: `src/app/entry/cli.tsx` (add `telemetry` to KNOWN_COMMANDS and handle it)

**Step 1: Create the telemetry command for interactive mode**

Create `src/app/commands/builtins/telemetry.ts`:

```typescript
import {type UICommand} from '../types';
import {
	isTelemetryEnabled,
	trackTelemetryOptedOut,
} from '../../../infra/telemetry/index';
import {writeGlobalConfig} from '../../../infra/plugins/config';

export const telemetryCommand: UICommand = {
	name: 'telemetry',
	description:
		'Manage anonymous telemetry (usage: /telemetry enable | /telemetry disable | /telemetry status)',
	category: 'ui',
	args: [
		{
			name: 'action',
			description: 'enable, disable, or status',
			required: false,
		},
	],
	execute(ctx) {
		const action = ctx.args['action'] ?? 'status';

		switch (action) {
			case 'enable':
				writeGlobalConfig({telemetry: true});
				ctx.addMessage({
					role: 'system',
					content:
						'Telemetry enabled. Anonymous usage data will be collected on next launch.',
				});
				break;

			case 'disable':
				trackTelemetryOptedOut();
				writeGlobalConfig({telemetry: false});
				ctx.addMessage({
					role: 'system',
					content:
						'Telemetry disabled. No anonymous usage data will be collected.',
				});
				break;

			case 'status':
				ctx.addMessage({
					role: 'system',
					content: `Telemetry is currently ${isTelemetryEnabled() ? 'enabled' : 'disabled'}.`,
				});
				break;

			default:
				ctx.addMessage({
					role: 'system',
					content:
						'Unknown action. Usage: /telemetry enable | /telemetry disable | /telemetry status',
				});
		}
	},
};
```

**Step 2: Register the command**

In `src/app/commands/builtins/index.ts`, add:

```typescript
import {telemetryCommand} from './telemetry';
```

And add `telemetryCommand` to the `builtins` array.

**Step 3: Add `telemetry` as a top-level CLI command**

In `src/app/entry/cli.tsx`:

1. Add `'telemetry'` to `KNOWN_COMMANDS` set (line 56)
2. Handle it early in `main()`, after the workflow command block (~line 265):

```typescript
if (command === 'telemetry') {
	const action = commandArgs[0] ?? 'status';
	if (action === 'disable') {
		writeGlobalConfig({telemetry: false});
		console.log(
			'Telemetry disabled. No anonymous usage data will be collected.',
		);
	} else if (action === 'enable') {
		writeGlobalConfig({telemetry: true});
		console.log(
			'Telemetry enabled. Anonymous usage data will be collected on next launch.',
		);
	} else {
		const currentConfig = readGlobalConfig();
		const isEnabled = currentConfig.telemetry !== false;
		console.log(
			`Telemetry is currently ${isEnabled ? 'enabled' : 'disabled'}.`,
		);
	}
	return;
}
```

3. Add to the help text in the meow call:

```
telemetry [action]       Manage anonymous telemetry (enable/disable/status)
```

**Step 4: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

**Step 5: Commit**

```bash
git add src/app/commands/builtins/telemetry.ts src/app/commands/builtins/index.ts src/app/entry/cli.tsx
git commit -m "feat: add telemetry CLI command for enable/disable/status"
```

---

### Task 8: Add first-run telemetry notice

**Files:**

- Modify: `src/app/entry/cli.tsx`

**Step 1: Add first-run notice after telemetry init**

In `src/app/entry/cli.tsx`, after the `initTelemetry` + `trackAppLaunched` block added in Task 6, add:

```typescript
// Show telemetry notice on first run (when deviceId was just generated)
if (!globalConfig.deviceId && globalConfig.telemetry !== false) {
	console.log(
		'\n  Athena collects anonymous usage data to improve the product.' +
			"\n  Run 'athena-flow telemetry disable' or set ATHENA_TELEMETRY_DISABLED=1 to opt out.\n",
	);
}
```

Note: This check uses `!globalConfig.deviceId` (the _original_ config before we wrote the new deviceId) to determine if this is the first run.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/app/entry/cli.tsx
git commit -m "feat: show telemetry notice on first run"
```

---

### Task 9: Track session start/end events

**Files:**

- Modify: `src/app/shell/AppShell.tsx` (or the relevant session lifecycle hook)

**Step 1: Identify session lifecycle**

The session lifecycle is managed in `AppShell.tsx`. Find where the harness process starts (session begins) and where it ends (session complete / user quits).

**Step 2: Add session tracking**

Import telemetry events in `AppShell.tsx`:

```typescript
import {
	trackSessionStarted,
	trackSessionEnded,
} from '../../infra/telemetry/index';
```

Fire `trackSessionStarted` when a new harness session begins (in the effect or callback that starts the Claude process).

Fire `trackSessionEnded` when the session ends, using metrics from `useHeaderMetrics`:

```typescript
trackSessionEnded({
	durationMs: Date.now() - sessionStartTime.getTime(),
	toolCallCount: metrics.totalToolCallCount,
	subagentCount: metrics.subagentCount,
	permissionsAllowed: metrics.permissions.allowed,
	permissionsDenied: metrics.permissions.denied,
});
```

The exact integration points will depend on the component's lifecycle hooks — trace the session start/end patterns in AppShell to find the right spots.

**Step 3: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/shell/AppShell.tsx
git commit -m "feat: track session start/end telemetry events"
```

---

### Task 10: Final verification

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

**Step 4: Run dead code detection**

Run: `npm run lint:dead`
Expected: No new dead code warnings from telemetry module

**Step 5: Manual smoke test**

Run: `npm run build && node dist/cli.js`
Expected: First-run telemetry notice appears, app functions normally

**Step 6: Commit any fixes, then final commit**

```bash
git add -A
git commit -m "feat: complete anonymous telemetry implementation"
```
