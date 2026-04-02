# Onboarding & Workflow Picker Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify onboarding to 2 steps (Theme + Harness) and move workflow selection into a mandatory gate component in the main feed area, backed by project-level config.

**Architecture:** The setup wizard loses its Workflow and MCP Options steps. A new `WorkflowPicker` component renders in place of the feed when no project-level `activeWorkflow` is set. A `/workflow` slash command re-opens it. All workflow selections write to `{cwd}/.athena/config.json`.

**Tech Stack:** Ink + React 19, TypeScript ESM, vitest

**Spec:** `docs/superpowers/specs/2026-04-02-onboarding-workflow-picker-redesign.md`

---

### Task 1: Add `writeProjectConfig` and `hasProjectWorkflow` to config module

**Files:**

- Modify: `src/infra/plugins/config.ts:145-172`
- Create: `src/infra/plugins/config.test.ts`

- [ ] **Step 1: Write failing tests for `writeProjectConfig` and `hasProjectWorkflow`**

```typescript
// src/infra/plugins/config.test.ts
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {writeProjectConfig, hasProjectWorkflow, readConfig} from './config';

describe('writeProjectConfig', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-config-test-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	});

	it('creates .athena/config.json with updates when file does not exist', () => {
		writeProjectConfig(tmpDir, {activeWorkflow: 'my-workflow'});
		const config = readConfig(tmpDir);
		expect(config.activeWorkflow).toBe('my-workflow');
	});

	it('merges with existing project config', () => {
		const configDir = path.join(tmpDir, '.athena');
		fs.mkdirSync(configDir, {recursive: true});
		fs.writeFileSync(
			path.join(configDir, 'config.json'),
			JSON.stringify({plugins: ['./my-plugin'], theme: 'light'}),
		);
		writeProjectConfig(tmpDir, {activeWorkflow: 'e2e-testing'});
		const raw = JSON.parse(
			fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'),
		);
		expect(raw.activeWorkflow).toBe('e2e-testing');
		expect(raw.plugins).toEqual(['./my-plugin']);
		expect(raw.theme).toBe('light');
	});

	it('merges workflowSelections instead of replacing', () => {
		const configDir = path.join(tmpDir, '.athena');
		fs.mkdirSync(configDir, {recursive: true});
		fs.writeFileSync(
			path.join(configDir, 'config.json'),
			JSON.stringify({
				workflowSelections: {old: {mcpServerOptions: {s1: ['a']}}},
			}),
		);
		writeProjectConfig(tmpDir, {
			workflowSelections: {new: {mcpServerOptions: {s2: ['b']}}},
		});
		const raw = JSON.parse(
			fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'),
		);
		expect(raw.workflowSelections).toEqual({
			old: {mcpServerOptions: {s1: ['a']}},
			new: {mcpServerOptions: {s2: ['b']}},
		});
	});
});

describe('hasProjectWorkflow', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-config-test-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	});

	it('returns false when no config file exists', () => {
		expect(hasProjectWorkflow(tmpDir)).toBe(false);
	});

	it('returns false when config exists but has no activeWorkflow', () => {
		const configDir = path.join(tmpDir, '.athena');
		fs.mkdirSync(configDir, {recursive: true});
		fs.writeFileSync(
			path.join(configDir, 'config.json'),
			JSON.stringify({plugins: []}),
		);
		expect(hasProjectWorkflow(tmpDir)).toBe(false);
	});

	it('returns true when config has activeWorkflow', () => {
		const configDir = path.join(tmpDir, '.athena');
		fs.mkdirSync(configDir, {recursive: true});
		fs.writeFileSync(
			path.join(configDir, 'config.json'),
			JSON.stringify({activeWorkflow: 'my-workflow'}),
		);
		expect(hasProjectWorkflow(tmpDir)).toBe(true);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/infra/plugins/config.test.ts`
Expected: FAIL — `writeProjectConfig` and `hasProjectWorkflow` are not exported

- [ ] **Step 3: Implement `writeProjectConfig` and `hasProjectWorkflow`**

Add to `src/infra/plugins/config.ts` after the existing `writeGlobalConfig` function (after line 172):

```typescript
/**
 * Write project config to `{projectDir}/.athena/config.json`.
 * Merges with existing config if present. Creates directories as needed.
 */
export function writeProjectConfig(
	projectDir: string,
	updates: Partial<AthenaConfig>,
): void {
	const configDir = path.join(projectDir, '.athena');
	const configPath = path.join(configDir, 'config.json');

	let existing: Record<string, unknown> = {};
	if (fs.existsSync(configPath)) {
		existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
			string,
			unknown
		>;
	}

	const merged: Record<string, unknown> = {...existing, ...updates};
	if (updates.workflowSelections) {
		const existingSelections =
			(existing['workflowSelections'] as WorkflowSelections | undefined) ?? {};
		merged['workflowSelections'] = {
			...existingSelections,
			...updates.workflowSelections,
		};
	}
	fs.mkdirSync(configDir, {recursive: true});
	fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

/**
 * Check whether a project-level config has an active workflow selected.
 */
export function hasProjectWorkflow(projectDir: string): boolean {
	const configPath = path.join(projectDir, '.athena', 'config.json');
	if (!fs.existsSync(configPath)) {
		return false;
	}
	const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
		activeWorkflow?: string;
	};
	return typeof raw.activeWorkflow === 'string' && raw.activeWorkflow !== '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/infra/plugins/config.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/infra/plugins/config.ts src/infra/plugins/config.test.ts
git commit -m "feat(config): add writeProjectConfig and hasProjectWorkflow"
```

---

### Task 2: Simplify SetupWizard to 2 steps (Theme + Harness)

**Files:**

- Modify: `src/setup/SetupWizard.tsx`
- Modify: `src/setup/useSetupState.ts:3`

- [ ] **Step 1: Update `TOTAL_STEPS` from 4 to 2**

In `src/setup/useSetupState.ts`, change line 3:

```typescript
// Before:
const TOTAL_STEPS = 4;

// After:
const TOTAL_STEPS = 2;
```

- [ ] **Step 2: Simplify `SetupWizard.tsx`**

Remove the `WorkflowStep` and `McpOptionsStep` imports, handlers, state, and render blocks. Remove the `McpServerWithOptions` import and `collectMcpServersWithOptions` import.

In `src/setup/SetupWizard.tsx`:

**Remove imports** (lines 6-7, 17-20):

```typescript
// Remove these lines:
import WorkflowStep from './steps/WorkflowStep';
import McpOptionsStep from './steps/McpOptionsStep';
import {
	collectMcpServersWithOptions,
	type McpServerWithOptions,
} from '../infra/plugins/mcpOptions';
```

**Simplify `SetupResult` type** (lines 23-28):

```typescript
// Before:
export type SetupResult = {
	theme: string;
	harness?: AthenaHarness;
	workflow?: string;
	mcpServerOptions?: McpServerChoices;
};

// After:
export type SetupResult = {
	theme: string;
	harness?: AthenaHarness;
};
```

**Remove `McpServerChoices` from the config import** (lines 12-16):

```typescript
// Before:
import {
	writeGlobalConfig,
	type AthenaHarness,
	type McpServerChoices,
} from '../infra/plugins/config';

// After:
import {writeGlobalConfig, type AthenaHarness} from '../infra/plugins/config';
```

**Simplify `STEP_SUMMARIES`** (lines 35-46):

```typescript
// Before:
const STEP_SUMMARIES = [
	{label: 'Theme', summarize: (r: SetupResult) => r.theme},
	{label: 'Harness', summarize: (r: SetupResult) => r.harness ?? 'skipped'},
	{label: 'Workflow', summarize: (r: SetupResult) => r.workflow ?? 'skipped'},
	{
		label: 'MCP Options',
		summarize: (r: SetupResult) => {
			const n = Object.keys(r.mcpServerOptions ?? {}).length;
			return n > 0 ? `${n} server(s)` : 'auto';
		},
	},
];

// After:
const STEP_SUMMARIES = [
	{label: 'Theme', summarize: (r: SetupResult) => r.theme},
	{label: 'Harness', summarize: (r: SetupResult) => r.harness ?? 'skipped'},
];
```

**Remove workflow/MCP state and handlers** — delete these entirely:

- `mcpServersWithOptions` state (lines 66-68)
- `handleWorkflowComplete` callback (lines 101-108)
- `handleMcpOptionsComplete` callback (lines 110-116)
- The `stepIndex === 3` skip shortcut branch in `handleSkipShortcut` (lines 133-135)
- Remove `handleMcpOptionsComplete` from `handleSkipShortcut` deps (line 143)

**Remove workflow/MCP render blocks** (lines 252-268):

```tsx
// Delete these two blocks:
{stepIndex === 2 && !isComplete && (
	<Box marginTop={1}>
		<WorkflowStep ... />
	</Box>
)}
{stepIndex === 3 && !isComplete && (
	<Box marginTop={1}>
		<McpOptionsStep ... />
	</Box>
)}
```

**Simplify the completion effect** (lines 183-209):

```typescript
// Before:
useEffect(() => {
	if (isComplete && !completedRef.current) {
		try {
			completedRef.current = true;
			const workflowSelections = result.workflow
				? {
						[result.workflow]: {
							mcpServerOptions: result.mcpServerOptions,
						},
					}
				: undefined;
			writeGlobalConfig({
				setupComplete: true,
				theme: result.theme,
				harness: result.harness,
				activeWorkflow: result.workflow,
				workflowSelections,
			});
			onComplete(result);
		} catch (error) { ... }
	}
}, [isComplete, result, onComplete, writeRetryCount]);

// After:
useEffect(() => {
	if (isComplete && !completedRef.current) {
		try {
			completedRef.current = true;
			writeGlobalConfig({
				setupComplete: true,
				theme: result.theme,
				harness: result.harness,
				activeWorkflow: 'default',
			});
			onComplete(result);
		} catch (error) {
			completedRef.current = false;
			setWriteError(
				`Failed to write setup config: ${(error as Error).message}`,
			);
		}
	}
}, [isComplete, result, onComplete, writeRetryCount]);
```

- [ ] **Step 3: Verify the app builds**

Run: `npm run build`
Expected: Build succeeds. There may be unused-import warnings for `WorkflowStep`/`McpOptionsStep` files — that's fine, they're still on disk but no longer imported.

- [ ] **Step 4: Run existing tests**

Run: `npm test`
Expected: All tests pass (any setup wizard tests should still pass with the reduced step count)

- [ ] **Step 5: Commit**

```bash
git add src/setup/SetupWizard.tsx src/setup/useSetupState.ts
git commit -m "refactor(setup): reduce onboarding to Theme + Harness steps"
```

---

### Task 3: Create the `WorkflowPicker` component

**Files:**

- Create: `src/app/workflow/WorkflowPicker.tsx`
- Reference: `src/setup/steps/WorkflowStep.tsx` (for `loadWorkflowOptions` pattern)
- Reference: `src/setup/steps/McpOptionsStep.tsx` (for MCP options flow)
- Reference: `src/setup/components/StepSelector.tsx` (reused for selection UI)

- [ ] **Step 1: Create the WorkflowPicker component**

```typescript
// src/app/workflow/WorkflowPicker.tsx
import {useState, useCallback, useEffect} from 'react';
import {Box, Text} from 'ink';
import StepSelector from '../../setup/components/StepSelector';
import StepStatus from '../../setup/components/StepStatus';
import McpOptionsStep from '../../setup/steps/McpOptionsStep';
import {
	installWorkflow,
	resolveWorkflow,
	installWorkflowPlugins,
} from '../../core/workflows/index';
import {
	isMarketplaceRef,
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	resolveWorkflowMarketplaceSource,
	resolveMarketplaceWorkflow,
	findMarketplaceRepoDir,
} from '../../infra/plugins/marketplace';
import {
	readGlobalConfig,
	writeProjectConfig,
	type McpServerChoices,
} from '../../infra/plugins/config';
import {
	collectMcpServersWithOptions,
	type McpServerWithOptions,
} from '../../infra/plugins/mcpOptions';
import {useTheme} from '../../ui/theme/index';
import fs from 'node:fs';

const DEFAULT_MARKETPLACE_OWNER = 'lespaceman';
const DEFAULT_MARKETPLACE_REPO = 'athena-workflow-marketplace';

const DEFAULT_WORKFLOW_OPTION: WorkflowOption = {
	label: 'default',
	value: 'default',
	description: 'Built-in default workflow',
};

type WorkflowOption = {
	label: string;
	value: string;
	description: string;
};

type PickerPhase =
	| {type: 'loading'}
	| {type: 'selecting'; options: WorkflowOption[]}
	| {type: 'installing'; workflowValue: string}
	| {type: 'mcp-options'; workflowName: string; servers: McpServerWithOptions[]; pluginDirs: string[]}
	| {type: 'done'}
	| {type: 'error'; message: string};

type Props = {
	projectDir: string;
	onComplete: (workflowName: string, mcpServerOptions?: McpServerChoices) => void;
};

function loadWorkflowOptions(): WorkflowOption[] {
	const sourceOverride = process.env.ATHENA_STARTER_WORKFLOW_SOURCE;

	if (!sourceOverride) {
		const configuredSource =
			readGlobalConfig().workflowMarketplaceSource ??
			`${DEFAULT_MARKETPLACE_OWNER}/${DEFAULT_MARKETPLACE_REPO}`;
		const marketplaceSource =
			resolveWorkflowMarketplaceSource(configuredSource);

		if (marketplaceSource.kind === 'remote') {
			return listMarketplaceWorkflows(
				marketplaceSource.owner,
				marketplaceSource.repo,
			).map(workflow => ({
				label: workflow.name,
				value: workflow.ref,
				description: workflow.description ?? 'Marketplace workflow',
			}));
		}

		return listMarketplaceWorkflowsFromRepo(marketplaceSource.repoDir).map(
			workflow => ({
				label: workflow.name,
				value: workflow.workflowPath,
				description: workflow.description ?? 'Local marketplace workflow',
			}),
		);
	}

	if (isMarketplaceRef(sourceOverride)) {
		const workflowPath = resolveMarketplaceWorkflow(sourceOverride);
		const raw = JSON.parse(fs.readFileSync(workflowPath, 'utf-8')) as {
			name?: string;
			description?: string;
		};
		return [{
			label: raw.name ?? sourceOverride,
			value: sourceOverride,
			description: raw.description ?? 'Marketplace workflow',
		}];
	}

	const repoDir = findMarketplaceRepoDir(sourceOverride);
	if (repoDir) {
		return listMarketplaceWorkflowsFromRepo(repoDir).map(workflow => ({
			label: workflow.name,
			value: workflow.workflowPath,
			description: workflow.description ?? 'Local marketplace workflow',
		}));
	}

	if (!fs.existsSync(sourceOverride)) {
		throw new Error(`Workflow source not found: ${sourceOverride}`);
	}

	const raw = JSON.parse(fs.readFileSync(sourceOverride, 'utf-8')) as {
		name?: string;
		description?: string;
	};
	return [{
		label: raw.name ?? 'Local workflow',
		value: sourceOverride,
		description: raw.description ?? 'Local workflow',
	}];
}

export default function WorkflowPicker({projectDir, onComplete}: Props) {
	const theme = useTheme();
	const [phase, setPhase] = useState<PickerPhase>({type: 'loading'});

	useEffect(() => {
		try {
			const marketplaceOptions = loadWorkflowOptions();
			// Default workflow always first, then marketplace
			const options = [DEFAULT_WORKFLOW_OPTION, ...marketplaceOptions];
			setPhase({type: 'selecting', options});
		} catch {
			// If marketplace fails, still show default
			setPhase({type: 'selecting', options: [DEFAULT_WORKFLOW_OPTION]});
		}
	}, []);

	const handleSelect = useCallback(
		(value: string) => {
			if (value === 'default') {
				writeProjectConfig(projectDir, {activeWorkflow: 'default'});
				setPhase({type: 'done'});
				onComplete('default');
				return;
			}

			setPhase({type: 'installing', workflowValue: value});
			setTimeout(() => {
				try {
					const name = installWorkflow(value);
					const resolved = resolveWorkflow(name);
					const pluginDirs = installWorkflowPlugins(resolved);
					const servers = collectMcpServersWithOptions(pluginDirs);

					if (servers.length > 0) {
						setPhase({type: 'mcp-options', workflowName: name, servers, pluginDirs});
					} else {
						writeProjectConfig(projectDir, {activeWorkflow: name});
						setPhase({type: 'done'});
						onComplete(name);
					}
				} catch (err) {
					setPhase({
						type: 'error',
						message: `Installation failed: ${(err as Error).message}`,
					});
				}
			}, 0);
		},
		[projectDir, onComplete],
	);

	const handleMcpComplete = useCallback(
		(choices: McpServerChoices) => {
			if (phase.type !== 'mcp-options') return;
			const {workflowName} = phase;
			writeProjectConfig(projectDir, {
				activeWorkflow: workflowName,
				workflowSelections: {
					[workflowName]: {mcpServerOptions: choices},
				},
			});
			setPhase({type: 'done'});
			onComplete(workflowName, choices);
		},
		[phase, projectDir, onComplete],
	);

	return (
		<Box
			flexDirection="column"
			alignItems="center"
			justifyContent="center"
			paddingX={2}
		>
			<Text bold color={theme.accent}>
				Select a workflow
			</Text>
			<Text color={theme.textMuted}>
				Choose a workflow for this project.
			</Text>

			{phase.type === 'loading' && (
				<StepStatus status="verifying" message="Loading workflows..." />
			)}

			{phase.type === 'selecting' && (
				<Box marginTop={1}>
					<StepSelector options={phase.options} onSelect={handleSelect} />
				</Box>
			)}

			{phase.type === 'installing' && (
				<StepStatus status="verifying" message="Installing workflow..." />
			)}

			{phase.type === 'mcp-options' && (
				<Box marginTop={1}>
					<McpOptionsStep
						servers={phase.servers}
						onComplete={handleMcpComplete}
					/>
				</Box>
			)}

			{phase.type === 'error' && (
				<Text color={theme.status.error}>{phase.message}</Text>
			)}
		</Box>
	);
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/app/workflow/WorkflowPicker.tsx
git commit -m "feat(workflow): add WorkflowPicker gate component for feed area"
```

---

### Task 4: Integrate WorkflowPicker gate into AppShell

**Files:**

- Modify: `src/app/shell/AppShell.tsx`
- Modify: `src/app/commands/types.ts:57-67`

- [ ] **Step 1: Add `showWorkflowPicker` to `UICommandContext`**

In `src/app/commands/types.ts`, add to the `UICommandContext` type (after `showSetup` on line 65):

```typescript
// Before:
export type UICommandContext = {
	args: Record<string, string>;
	messages: Message[];
	setMessages: (msgs: Message[]) => void;
	addMessage: (msg: Omit<Message, 'seq'>) => void;
	exit: () => void;
	clearScreen: () => void;
	showSessions: () => void;
	showSetup: () => void;
	sessionStats: SessionStatsSnapshot;
};

// After:
export type UICommandContext = {
	args: Record<string, string>;
	messages: Message[];
	setMessages: (msgs: Message[]) => void;
	addMessage: (msg: Omit<Message, 'seq'>) => void;
	exit: () => void;
	clearScreen: () => void;
	showSessions: () => void;
	showSetup: () => void;
	showWorkflowPicker: () => void;
	sessionStats: SessionStatsSnapshot;
};
```

- [ ] **Step 2: Add gate state and WorkflowPicker rendering to AppShell**

In `src/app/shell/AppShell.tsx`, make these changes:

**Add import** (near line 78, with the SetupWizard import):

```typescript
import WorkflowPicker from '../workflow/WorkflowPicker';
import {hasProjectWorkflow} from '../../infra/plugins/config';
```

**Add `showWorkflowPicker` state inside `AppContent`** (near line 257 after existing state declarations):

```typescript
const [workflowPickerVisible, setWorkflowPickerVisible] = useState(
	!hasProjectWorkflow(projectDir),
);
```

**Add `onShowWorkflowPicker` prop to `AppContent`'s props type** (around line 250, next to `onShowSetup`):

```typescript
onShowWorkflowPicker: () => void;
```

Wait — `AppContent` is inside `AppShell`, so we need to add the state in the right place. The `workflowPickerVisible` state belongs inside `AppContent` since it's a main-phase concern. Let me clarify:

The state lives in `AppContent`. The `UICommandContext` plumbing passes the setter through.

**Add `showWorkflowPicker` to the command context** (where `UICommandContext` is built, around line 762-766):

Find the block where `showSetup: onShowSetup` is set in the command context, and add:

```typescript
showWorkflowPicker: () => setWorkflowPickerVisible(true),
```

**Add `handleWorkflowPickerComplete` callback** (near the other handler callbacks):

```typescript
const handleWorkflowPickerComplete = useCallback(
	(workflowName: string) => {
		setWorkflowPickerVisible(false);
		// Re-bootstrap runtime to pick up new workflow
		const refreshed = bootstrapRuntimeConfig({
			projectDir,
			showSetup: false,
			pluginFlags,
			isolationPreset,
			verbose,
		});
		setRuntimeState({
			harness: refreshed.harness,
			isolation: refreshed.isolationConfig,
			pluginMcpConfig: refreshed.pluginMcpConfig,
			modelName: refreshed.modelName,
			workflowRef: refreshed.workflowRef,
			workflow: refreshed.workflow,
			workflowPlan: refreshed.workflowPlan,
		});
	},
	[projectDir, pluginFlags, isolationPreset, verbose],
);
```

Note: `setRuntimeState`, `bootstrapRuntimeConfig`, and the runtime state variables are used in the `handleSetupComplete` callback already (lines 1975-2004 in the outer `AppShell` function). The `AppContent` component may not have direct access to `setRuntimeState`. You'll need to check whether `AppContent` has access to these or if you need to lift the callback. The pattern used for `handleSetupComplete` is in the outer `AppShell` — so the `WorkflowPicker` completion may need to be handled similarly.

**Two approaches depending on where runtime state lives:**

**If `AppContent` already has access to runtime refresh** (via props or hooks): add the callback directly.

**If runtime state is in the outer `AppShell`**: pass an `onWorkflowSelected` callback prop from `AppShell` → `AppContent`, similar to `onShowSetup`/`onShowSessions`. The outer `AppShell` handles the re-bootstrap.

Given the existing pattern where `handleSetupComplete` lives in the outer `AppShell` (lines 1975-2004), follow the same pattern:

1. Add `onWorkflowSelected: (workflowName: string) => void` to `AppContent`'s props
2. In outer `AppShell`, create `handleWorkflowSelected` that re-bootstraps runtime
3. In `AppContent`, call `onWorkflowSelected` from the `WorkflowPicker`'s `onComplete`

**Render the gate** — wrap the feed area in a conditional. Find where `<FeedGrid>` is rendered (around line 1332) and wrap:

```tsx
{workflowPickerVisible ? (
	<WorkflowPicker
		projectDir={projectDir}
		onComplete={(name) => {
			setWorkflowPickerVisible(false);
			onWorkflowSelected(name);
		}}
	/>
) : (
	<FeedGrid
		{/* existing props */}
	/>
)}
```

- [ ] **Step 3: Block input when picker is visible**

Find where `ShellInput` is rendered and conditionally disable it. The simplest approach is to conditionally set the `isActive` or `disabled` state. Look for how `ShellInput` handles the `focusMode` — if `focusMode` controls input activation, you can force `focusMode` to a non-input value when the picker is showing.

Alternatively, add a guard in the input submit handler:

```typescript
// In the submit handler, early-return if picker is visible:
if (workflowPickerVisible) return;
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/app/shell/AppShell.tsx src/app/commands/types.ts
git commit -m "feat(shell): integrate WorkflowPicker gate into main feed area"
```

---

### Task 5: Register `/workflow` slash command

**Files:**

- Create: `src/app/commands/builtins/workflow.ts`
- Modify: `src/app/commands/builtins/index.ts`

- [ ] **Step 1: Create the workflow command**

```typescript
// src/app/commands/builtins/workflow.ts
import {type UICommand} from '../types';

export const workflowCommand: UICommand = {
	name: 'workflow',
	description: 'Change the active workflow for this project',
	category: 'ui',
	execute: ctx => {
		ctx.showWorkflowPicker();
	},
};
```

- [ ] **Step 2: Register it in builtins**

In `src/app/commands/builtins/index.ts`, add the import and registration:

```typescript
// Add import:
import {workflowCommand} from './workflow';

// Add to builtins array:
const builtins = [
	helpCommand,
	clearCommand,
	quitCommand,
	statsCommand,
	contextCommand,
	sessionsCommand,
	tasksCommand,
	setup,
	telemetryCommand,
	workflowCommand,
];
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/app/commands/builtins/workflow.ts src/app/commands/builtins/index.ts
git commit -m "feat(commands): add /workflow slash command"
```

---

### Task 6: Wire `showWorkflowPicker` through the command executor

**Files:**

- Modify: `src/app/shell/AppShell.tsx` (where `UICommandContext` is constructed)

This task ensures the `showWorkflowPicker` field added to `UICommandContext` in Task 4 is actually wired up in the command context construction inside `AppContent`.

- [ ] **Step 1: Find the UICommandContext construction**

In `src/app/shell/AppShell.tsx`, locate where the command context is built (around line 760-770, where `showSetup: onShowSetup` appears). Verify that `showWorkflowPicker` is included. If Task 4 was done correctly, this should already be set to `() => setWorkflowPickerVisible(true)`.

- [ ] **Step 2: Verify the full chain works**

Run: `npm run build && npm test`
Expected: Build and tests pass

- [ ] **Step 3: Manual smoke test**

1. Start athena in a fresh directory (no `.athena/config.json`):
   - Expect: Onboarding runs with 2 steps (Theme + Harness)
   - After completion: Workflow picker appears in the feed area
   - Select a workflow: Feed appears normally
2. Restart athena in the same directory:
   - Expect: No picker — feed loads directly (project config has `activeWorkflow`)
3. Type `/workflow`:
   - Expect: Picker reappears, can select a different workflow
4. Start athena in a different directory:
   - Expect: Picker appears again (no project config in this dir)

- [ ] **Step 4: Commit if any wiring fixes were needed**

```bash
git add src/app/shell/AppShell.tsx
git commit -m "fix(shell): wire showWorkflowPicker through command context"
```
