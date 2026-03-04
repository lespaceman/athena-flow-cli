# Setup Wizard Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the flat, unframed setup wizard with a polished full-frame box-drawing layout featuring step indicator dots, inverse-highlighted selectors, and contextual keyboard hints.

**Architecture:** Pure presentational refactor — no behavioral changes. Three new components (WizardFrame, StepDots, WizardHints) wrap the existing step content. StepSelector gets inverse highlight + description support. The state machine, data flow, and config persistence are untouched.

**Tech Stack:** React 19 + Ink 6.7, existing glyph registry (`ui/glyphs/`), existing theme system (`ui/theme/`)

---

### Task 1: Create StepDots component

**Files:**

- Create: `src/setup/components/StepDots.tsx`
- Test: `src/setup/__tests__/StepDots.test.tsx`

**Step 1: Write the failing test**

```tsx
// src/setup/__tests__/StepDots.test.tsx
import React from 'react';
import {render} from 'ink-testing-library';
import {describe, it, expect} from 'vitest';
import StepDots from '../components/StepDots';
import {ThemeProvider, darkTheme} from '../../ui/theme/index';

function renderWithTheme(ui: React.ReactElement) {
	return render(<ThemeProvider value={darkTheme}>{ui}</ThemeProvider>);
}

describe('StepDots', () => {
	it('shows active dot for current step and pending for rest', () => {
		const {lastFrame} = renderWithTheme(
			<StepDots
				steps={['Theme', 'Harness', 'Workflow', 'MCP Options']}
				currentIndex={0}
				completedSteps={new Set()}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('◉');
		expect(frame).toContain('○');
		expect(frame).toContain('Theme');
	});

	it('shows check marks for completed steps', () => {
		const {lastFrame} = renderWithTheme(
			<StepDots
				steps={['Theme', 'Harness', 'Workflow', 'MCP Options']}
				currentIndex={2}
				completedSteps={new Set([0, 1])}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('✓');
		expect(frame).toContain('◉');
		expect(frame).toContain('Workflow');
	});

	it('shows all checks when complete', () => {
		const {lastFrame} = renderWithTheme(
			<StepDots
				steps={['Theme', 'Harness', 'Workflow', 'MCP Options']}
				currentIndex={4}
				completedSteps={new Set([0, 1, 2, 3])}
			/>,
		);
		const frame = lastFrame()!;
		// All four should be check marks
		const checks = (frame.match(/✓/g) || []).length;
		expect(checks).toBe(4);
		expect(frame).toContain('Complete');
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/setup/__tests__/StepDots.test.tsx`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```tsx
// src/setup/components/StepDots.tsx
import {Box, Text} from 'ink';
import {useTheme} from '../../ui/theme/index';
import {getGlyphs} from '../../ui/glyphs/index';

type Props = {
	steps: string[];
	currentIndex: number;
	completedSteps: Set<number>;
};

export default function StepDots({steps, currentIndex, completedSteps}: Props) {
	const theme = useTheme();
	const g = getGlyphs();

	const label =
		currentIndex >= steps.length ? 'Complete' : (steps[currentIndex] ?? '');

	return (
		<Box>
			{steps.map((_, i) => {
				const isCompleted = completedSteps.has(i);
				const isCurrent = i === currentIndex;

				let dot: string;
				let color: string;
				if (isCompleted) {
					dot = g['todo.done'];
					color = theme.status.success;
				} else if (isCurrent) {
					dot = g['status.active'];
					color = theme.accent;
				} else {
					dot = g['status.pending'];
					color = theme.textMuted;
				}

				return (
					<Text key={i} color={color}>
						{dot}
						{i < steps.length - 1 ? ' ' : ''}
					</Text>
				);
			})}
			<Text color={theme.accent} bold>
				{'  '}
				{label}
			</Text>
		</Box>
	);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/setup/__tests__/StepDots.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/setup/components/StepDots.tsx src/setup/__tests__/StepDots.test.tsx
git commit -m "feat(setup): add StepDots component for wizard progress indicator"
```

---

### Task 2: Create WizardHints component

**Files:**

- Create: `src/setup/components/WizardHints.tsx`
- Test: `src/setup/__tests__/WizardHints.test.tsx`

**Step 1: Write the failing test**

```tsx
// src/setup/__tests__/WizardHints.test.tsx
import React from 'react';
import {render} from 'ink-testing-library';
import {describe, it, expect} from 'vitest';
import WizardHints from '../components/WizardHints';
import {ThemeProvider, darkTheme} from '../../ui/theme/index';

function renderWithTheme(ui: React.ReactElement) {
	return render(<ThemeProvider value={darkTheme}>{ui}</ThemeProvider>);
}

describe('WizardHints', () => {
	it('shows move/select/skip for selecting state on step 0', () => {
		const {lastFrame} = renderWithTheme(
			<WizardHints stepState="selecting" stepIndex={0} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('move');
		expect(frame).toContain('select');
		expect(frame).toContain('skip');
		expect(frame).not.toContain('back');
	});

	it('shows back hint when stepIndex > 0', () => {
		const {lastFrame} = renderWithTheme(
			<WizardHints stepState="selecting" stepIndex={1} />,
		);
		expect(lastFrame()!).toContain('back');
	});

	it('shows retry/back for error state', () => {
		const {lastFrame} = renderWithTheme(
			<WizardHints stepState="error" stepIndex={1} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('retry');
		expect(frame).toContain('back');
	});

	it('shows nothing for verifying and success states', () => {
		const {lastFrame: vFrame} = renderWithTheme(
			<WizardHints stepState="verifying" stepIndex={0} />,
		);
		expect(vFrame()!.trim()).toBe('');

		const {lastFrame: sFrame} = renderWithTheme(
			<WizardHints stepState="success" stepIndex={0} />,
		);
		expect(sFrame()!.trim()).toBe('');
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/setup/__tests__/WizardHints.test.tsx`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```tsx
// src/setup/components/WizardHints.tsx
import {Box, Text} from 'ink';
import {useTheme} from '../../ui/theme/index';
import {getGlyphs} from '../../ui/glyphs/index';

type Props = {
	stepState: 'selecting' | 'verifying' | 'success' | 'error';
	stepIndex: number;
};

export default function WizardHints({stepState, stepIndex}: Props) {
	const theme = useTheme();
	const g = getGlyphs();

	if (stepState === 'verifying' || stepState === 'success') {
		return <Box />;
	}

	const hints: string[] = [];

	if (stepState === 'error') {
		hints.push('r retry');
		if (stepIndex > 0) hints.push(`${g['hint.escape']} back`);
	} else {
		hints.push(`${g['hint.arrowsUpDown']} move`);
		hints.push(`${g['hint.enter']} select`);
		if (stepIndex > 0) hints.push(`${g['hint.escape']} back`);
		hints.push('s skip');
	}

	return (
		<Box>
			<Text color={theme.textMuted}>{hints.join('  ')}</Text>
		</Box>
	);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/setup/__tests__/WizardHints.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/setup/components/WizardHints.tsx src/setup/__tests__/WizardHints.test.tsx
git commit -m "feat(setup): add WizardHints component for contextual keybindings"
```

---

### Task 3: Create WizardFrame component

**Files:**

- Create: `src/setup/components/WizardFrame.tsx`
- Test: `src/setup/__tests__/WizardFrame.test.tsx`

**Step 1: Write the failing test**

```tsx
// src/setup/__tests__/WizardFrame.test.tsx
import React from 'react';
import {render} from 'ink-testing-library';
import {describe, it, expect} from 'vitest';
import {Text} from 'ink';
import WizardFrame from '../components/WizardFrame';
import {ThemeProvider, darkTheme} from '../../ui/theme/index';

function renderWithTheme(ui: React.ReactElement) {
	return render(<ThemeProvider value={darkTheme}>{ui}</ThemeProvider>);
}

describe('WizardFrame', () => {
	it('renders box-drawing frame with title', () => {
		const {lastFrame} = renderWithTheme(
			<WizardFrame
				title="TEST TITLE"
				header={<Text>header content</Text>}
				footer={<Text>footer content</Text>}
			>
				<Text>body content</Text>
			</WizardFrame>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('┌');
		expect(frame).toContain('TEST TITLE');
		expect(frame).toContain('┘');
		expect(frame).toContain('header content');
		expect(frame).toContain('body content');
		expect(frame).toContain('footer content');
	});

	it('renders tee dividers between zones', () => {
		const {lastFrame} = renderWithTheme(
			<WizardFrame title="T" header={<Text>h</Text>} footer={<Text>f</Text>}>
				<Text>b</Text>
			</WizardFrame>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('├');
		expect(frame).toContain('┤');
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/setup/__tests__/WizardFrame.test.tsx`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

The WizardFrame renders the box manually using glyph characters. It uses `useStdout` for terminal width, capped at 60.

```tsx
// src/setup/components/WizardFrame.tsx
import type {ReactNode} from 'react';
import {Box, Text, useStdout} from 'ink';
import {useTheme} from '../../ui/theme/index';
import {getGlyphs} from '../../ui/glyphs/index';

type Props = {
	title: string;
	header: ReactNode;
	footer: ReactNode;
	children: ReactNode;
};

const MAX_WIDTH = 60;

export default function WizardFrame({title, header, footer, children}: Props) {
	const theme = useTheme();
	const g = getGlyphs();
	const {stdout} = useStdout();
	const columns = stdout?.columns ?? 80;
	const frameWidth = Math.min(columns - 4, MAX_WIDTH);
	const h = g['frame.horizontal'];

	// Top border: ┌─── TITLE ───...───┐
	const titlePadded = ` ${title} `;
	const topFillCount = Math.max(0, frameWidth - 2 - titlePadded.length - 3);
	const topLine = `${g['frame.topLeft']}${h.repeat(3)}${titlePadded}${h.repeat(topFillCount)}${g['frame.topRight']}`;

	// Tee divider: ├───...───┤
	const teeLine = `${g['frame.teeLeft']}${h.repeat(frameWidth - 2)}${g['frame.teeRight']}`;

	// Bottom border: └───...───┘
	const bottomLine = `${g['frame.bottomLeft']}${h.repeat(frameWidth - 2)}${g['frame.bottomRight']}`;

	const v = g['frame.vertical'];

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text color={theme.accent}>{topLine}</Text>

			{/* Header zone */}
			<Box flexDirection="column" paddingX={1} paddingY={1}>
				{header}
			</Box>

			<Text color={theme.accent}>{teeLine}</Text>

			{/* Content zone */}
			<Box flexDirection="column" paddingX={1} paddingY={1}>
				{children}
			</Box>

			<Text color={theme.accent}>{teeLine}</Text>

			{/* Footer zone */}
			<Box paddingX={1}>{footer}</Box>

			<Text color={theme.accent}>{bottomLine}</Text>
		</Box>
	);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/setup/__tests__/WizardFrame.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/setup/components/WizardFrame.tsx src/setup/__tests__/WizardFrame.test.tsx
git commit -m "feat(setup): add WizardFrame component for box-drawing layout"
```

---

### Task 4: Enhance StepSelector with inverse highlight and descriptions

**Files:**

- Modify: `src/setup/components/StepSelector.tsx`
- Test: `src/setup/__tests__/StepSelector.test.tsx` (create — no existing test file)

**Step 1: Write the failing test**

```tsx
// src/setup/__tests__/StepSelector.test.tsx
import React from 'react';
import {render} from 'ink-testing-library';
import {describe, it, expect, vi} from 'vitest';
import StepSelector from '../components/StepSelector';
import {ThemeProvider, darkTheme} from '../../ui/theme/index';

function renderWithTheme(ui: React.ReactElement) {
	return render(<ThemeProvider value={darkTheme}>{ui}</ThemeProvider>);
}

describe('StepSelector', () => {
	it('renders options with focused item using > prefix', () => {
		const {lastFrame} = renderWithTheme(
			<StepSelector
				options={[
					{label: 'Alpha', value: 'a'},
					{label: 'Beta', value: 'b'},
				]}
				onSelect={() => {}}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('>');
		expect(frame).toContain('Alpha');
		expect(frame).toContain('Beta');
	});

	it('renders description for focused item when provided', () => {
		const {lastFrame} = renderWithTheme(
			<StepSelector
				options={[
					{label: 'Alpha', value: 'a', description: 'First letter'},
					{label: 'Beta', value: 'b', description: 'Second letter'},
				]}
				onSelect={() => {}}
			/>,
		);
		const frame = lastFrame()!;
		// Description of focused item (Alpha) should show
		expect(frame).toContain('First letter');
		// Description of non-focused (Beta) should not show
		expect(frame).not.toContain('Second letter');
	});

	it('dims disabled options', () => {
		const {lastFrame} = renderWithTheme(
			<StepSelector
				options={[
					{label: 'Enabled', value: 'e'},
					{label: 'Disabled', value: 'd', disabled: true},
				]}
				onSelect={() => {}}
			/>,
		);
		expect(lastFrame()!).toContain('Disabled');
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/setup/__tests__/StepSelector.test.tsx`
Expected: FAIL — description test fails (description not rendered yet)

**Step 3: Update StepSelector implementation**

Modify `src/setup/components/StepSelector.tsx`:

1. Add `description?: string` to `SelectorOption` type
2. Replace plain `<Text>` with inverse-highlighted focused item
3. Render description below focused item

```tsx
// src/setup/components/StepSelector.tsx
import {useEffect, useRef, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {useTheme} from '../../ui/theme/index';

export type SelectorOption = {
	label: string;
	value: string;
	disabled?: boolean;
	description?: string;
};

type Props = {
	options: SelectorOption[];
	onSelect: (value: string) => void;
	isActive?: boolean;
	initialValue?: string;
	onHighlight?: (value: string) => void;
};

function getInitialCursor(
	options: SelectorOption[],
	initialValue: string | undefined,
): number {
	if (initialValue) {
		const initialIndex = options.findIndex(
			option => option.value === initialValue && !option.disabled,
		);
		if (initialIndex >= 0) {
			return initialIndex;
		}
	}
	const firstEnabled = options.findIndex(option => !option.disabled);
	return firstEnabled >= 0 ? firstEnabled : 0;
}

export default function StepSelector({
	options,
	onSelect,
	isActive = true,
	initialValue,
	onHighlight,
}: Props) {
	const theme = useTheme();
	const [cursor, setCursor] = useState(() =>
		getInitialCursor(options, initialValue),
	);
	const highlightedRef = useRef<string | undefined>(undefined);

	const moveCursor = (direction: -1 | 1) => {
		setCursor(prev => {
			if (options.length <= 1) {
				return prev;
			}
			let next = prev;
			for (let i = 0; i < options.length; i += 1) {
				const candidate = Math.max(
					0,
					Math.min(next + direction, options.length - 1),
				);
				if (candidate === next) {
					return prev;
				}
				next = candidate;
				if (!options[next]?.disabled) {
					return next;
				}
			}
			return prev;
		});
	};

	useInput(
		(_input, key) => {
			if (key.downArrow) {
				moveCursor(1);
			} else if (key.upArrow) {
				moveCursor(-1);
			} else if (key.return) {
				const opt = options[cursor];
				if (opt && !opt.disabled) {
					onSelect(opt.value);
				}
			}
		},
		{isActive},
	);

	useEffect(() => {
		if (!onHighlight) {
			return;
		}
		const option = options[cursor];
		if (!option || option.disabled) {
			return;
		}
		if (highlightedRef.current === option.value) {
			return;
		}
		highlightedRef.current = option.value;
		onHighlight(option.value);
	}, [cursor, options, onHighlight]);

	return (
		<Box flexDirection="column">
			{options.map((opt, i) => {
				const isCursor = i === cursor;
				return (
					<Box key={opt.value} flexDirection="column">
						<Text
							color={
								opt.disabled
									? theme.textMuted
									: isCursor
										? theme.accent
										: theme.text
							}
							bold={isCursor && !opt.disabled}
							inverse={isCursor && !opt.disabled}
							dimColor={opt.disabled}
						>
							{isCursor ? ' > ' : '   '}
							{opt.label}
							{isCursor ? ' ' : ''}
						</Text>
						{isCursor && opt.description && !opt.disabled ? (
							<Box paddingLeft={3}>
								<Text dimColor>{opt.description}</Text>
							</Box>
						) : null}
					</Box>
				);
			})}
		</Box>
	);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/setup/__tests__/StepSelector.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/setup/components/StepSelector.tsx src/setup/__tests__/StepSelector.test.tsx
git commit -m "feat(setup): enhance StepSelector with inverse highlight and descriptions"
```

---

### Task 5: Wire new components into SetupWizard

**Files:**

- Modify: `src/setup/SetupWizard.tsx`

**Step 1: Update SetupWizard to use WizardFrame, StepDots, WizardHints**

Replace the raw `<Box>` wrapper and progress bar with the new components. The key changes:

1. Remove the `progressBar()` function and `PROGRESS_BAR_WIDTH` constant
2. Import and render `WizardFrame` as the outer wrapper
3. Import and render `StepDots` in the header zone
4. Import and render `WizardHints` in the footer zone
5. Track completed steps via a `Set<number>` derived from `stepIndex`
6. Remove the old hardcoded hints `<Text>` at the bottom

```tsx
// src/setup/SetupWizard.tsx — updated render section
// (state machine, callbacks, effects all remain identical)

// Add imports:
import WizardFrame from './components/WizardFrame';
import StepDots from './components/StepDots';
import WizardHints from './components/WizardHints';

// Remove: PROGRESS_BAR_WIDTH, progressBar() function

// Compute completed steps from stepIndex:
const completedSteps = new Set(Array.from({length: stepIndex}, (_, i) => i));

// Replace the entire return JSX with:
return (
	<WizardFrame
		title="ATHENA SETUP"
		header={
			<>
				<Text color={theme.textMuted}>
					Configure your defaults in under a minute.
				</Text>
				<Box marginTop={1}>
					<StepDots
						steps={STEP_LABELS}
						currentIndex={isComplete ? STEP_LABELS.length : stepIndex}
						completedSteps={
							isComplete
								? new Set(STEP_LABELS.map((_, i) => i))
								: completedSteps
						}
					/>
				</Box>
			</>
		}
		footer={
			<WizardHints
				stepState={
					isComplete ? (writeError ? 'error' : 'verifying') : stepState
				}
				stepIndex={stepIndex}
			/>
		}
	>
		{/* Step content — identical to current, minus the old hints box */}
		{stepIndex === 0 && stepState !== 'success' && !isComplete && (
			<ThemeStep
				onComplete={handleThemeComplete}
				onPreview={handleThemePreview}
			/>
		)}
		{stepIndex === 0 && stepState === 'success' && (
			<StepStatus status="success" message={`Theme: ${result.theme}`} />
		)}
		{stepIndex === 1 && !isComplete && (
			<HarnessStep
				key={retryCount}
				onComplete={handleHarnessComplete}
				onError={() => markError()}
			/>
		)}
		{stepIndex === 2 && !isComplete && (
			<WorkflowStep
				key={retryCount}
				onComplete={handleWorkflowComplete}
				onError={() => markError()}
				onSkip={handleWorkflowSkip}
			/>
		)}
		{stepIndex === 3 && !isComplete && (
			<McpOptionsStep
				servers={mcpServersWithOptions}
				onComplete={handleMcpOptionsComplete}
			/>
		)}
		{stepState === 'error' && !isComplete && (
			<Text color={theme.status.error}>Press r to retry this step.</Text>
		)}
		{isComplete && !writeError && (
			<StepStatus status="verifying" message="Saving setup..." />
		)}
		{isComplete && writeError && (
			<>
				<StepStatus status="error" message={writeError} />
				<Text color={theme.textMuted}>Press r to retry saving.</Text>
			</>
		)}
	</WizardFrame>
);
```

**Step 2: Run existing tests to verify nothing breaks**

Run: `npx vitest run src/setup/__tests__/SetupWizard.test.tsx`
Expected: Some assertions will fail because the output format changed. Proceed to Task 6.

**Step 3: Commit**

```bash
git add src/setup/SetupWizard.tsx
git commit -m "feat(setup): wire WizardFrame, StepDots, WizardHints into SetupWizard"
```

---

### Task 6: Update SetupWizard tests for new output format

**Files:**

- Modify: `src/setup/__tests__/SetupWizard.test.tsx`

**Step 1: Update assertions to match new visual output**

The key changes in test assertions:

- `'Up/Down move'` → `'move'` (hints are now glyph-based: `↑↓ move`)
- `'Step 1 of 4'` → check for `◉` and step dots instead
- `'Select harness'` and `'Choose your display theme'` → unchanged (step headings didn't change)

```tsx
// Update the first test:
it('renders the first step (theme selection)', () => {
	const {lastFrame} = render(
		<ThemeProvider value={darkTheme}>
			<SetupWizard onComplete={() => {}} />
		</ThemeProvider>,
	);
	expect(lastFrame()!).toContain('Dark');
	expect(lastFrame()!).toContain('Light');
	expect(lastFrame()!).toContain('ATHENA SETUP');
	expect(lastFrame()!).toContain('move');
});

// Update the progress bar test:
it('shows step dots indicator', () => {
	const {lastFrame} = render(
		<ThemeProvider value={darkTheme}>
			<SetupWizard onComplete={() => {}} />
		</ThemeProvider>,
	);
	expect(lastFrame()!).toContain('◉');
	expect(lastFrame()!).toContain('Theme');
});
```

**Step 2: Run all setup tests**

Run: `npx vitest run src/setup/`
Expected: PASS — all tests green

**Step 3: Commit**

```bash
git add src/setup/__tests__/SetupWizard.test.tsx
git commit -m "test(setup): update SetupWizard tests for new frame layout"
```

---

### Task 7: Add descriptions to step options

**Files:**

- Modify: `src/setup/steps/ThemeStep.tsx`
- Modify: `src/setup/steps/HarnessStep.tsx`
- Modify: `src/setup/steps/WorkflowStep.tsx`

**Step 1: Add description strings to option arrays**

ThemeStep — add descriptions to theme options:

```tsx
options={[
	{label: 'Dark', value: 'dark', description: 'Warm gray on dark background'},
	{label: 'Light', value: 'light', description: 'Dark text on light background'},
	{label: 'High Contrast', value: 'high-contrast', description: 'Maximum readability'},
]}
```

WorkflowStep — add descriptions:

```tsx
options={[
	{label: 'e2e-test-builder', value: 'e2e-test-builder', description: 'Playwright-based browser test generation'},
	{label: 'bug-triage (coming soon)', value: 'bug-triage', disabled: true, description: 'Automated bug classification'},
	{label: 'None - configure later', value: 'none', description: 'Skip workflow installation for now'},
]}
```

HarnessStep — add description from capability metadata (the `capability.label` already exists, add a `description` field if the harness capabilities provide one, otherwise use a short static string per harness id):

```tsx
options={capabilities.map((capability, index) => ({
	label: `${index + 1}. ${capability.label}`,
	value: capability.id,
	disabled: !capability.enabled,
	description: capability.enabled ? `Connect to ${capability.label}` : 'Not available',
}))}
```

**Step 2: Run all setup tests**

Run: `npx vitest run src/setup/`
Expected: PASS

**Step 3: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

**Step 4: Commit**

```bash
git add src/setup/steps/ThemeStep.tsx src/setup/steps/HarnessStep.tsx src/setup/steps/WorkflowStep.tsx
git commit -m "feat(setup): add descriptions to step selector options"
```

---

### Task 8: Final verification

**Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — no regressions

**Step 2: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

**Step 3: Manual smoke test**

Run: `npm run build && node dist/cli.js setup`
Verify: Box-drawing frame appears, step dots show progress, inverse highlight on selector, contextual hints change per state.

**Step 4: Run dead code detection**

Run: `npm run lint:dead`
Expected: No new dead code introduced (old `progressBar` function is removed)

**Step 5: Final commit if any formatting fixes needed**

```bash
npm run format
git add -A
git commit -m "chore(setup): format and finalize wizard redesign"
```
