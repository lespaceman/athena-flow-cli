import {describe, it, expect, vi} from 'vitest';

const createClaudeHookRuntimeMock = vi.fn(() => ({
	start: vi.fn(() => Promise.resolve()),
	stop: vi.fn(),
	getStatus: () => 'stopped' as const,
	getLastError: () => null,
	onEvent: () => () => {},
	onDecision: () => () => {},
	sendDecision: vi.fn(),
}));

const createCodexRuntimeMock = vi.fn(() => ({
	start: vi.fn(() => Promise.resolve()),
	stop: vi.fn(),
	getStatus: () => 'stopped' as const,
	getLastError: () => null,
	onEvent: () => () => {},
	onDecision: () => () => {},
	sendDecision: vi.fn(),
}));

vi.mock('../../harnesses/claude/runtime', () => ({
	createClaudeHookRuntime: (opts: {projectDir: string; instanceId: number}) =>
		createClaudeHookRuntimeMock(opts),
}));

vi.mock('../../harnesses/codex/runtime', () => ({
	createCodexRuntime: (opts: {projectDir: string; instanceId: number}) =>
		createCodexRuntimeMock(opts),
}));

const {createRuntime, DEFAULT_HARNESS} = await import('./createRuntime');

describe('createRuntime', () => {
	it('uses claude runtime for claude-code harness', () => {
		createRuntime({
			harness: 'claude-code',
			projectDir: '/tmp/project',
			instanceId: 42,
		});

		expect(createClaudeHookRuntimeMock).toHaveBeenCalledWith({
			projectDir: '/tmp/project',
			instanceId: 42,
		});
	});

	it('uses codex runtime for openai-codex harness', () => {
		createRuntime({
			harness: 'openai-codex',
			projectDir: '/tmp/project',
			instanceId: 7,
		});

		expect(createCodexRuntimeMock).toHaveBeenCalledWith({
			projectDir: '/tmp/project',
			instanceId: 7,
		});
	});

	it('falls back to claude runtime for opencode harness until adapter lands', () => {
		createRuntime({
			harness: 'opencode',
			projectDir: '/tmp/project',
			instanceId: 8,
		});

		expect(createClaudeHookRuntimeMock).toHaveBeenCalledWith({
			projectDir: '/tmp/project',
			instanceId: 8,
		});
	});

	it('defines claude-code as default harness', () => {
		expect(DEFAULT_HARNESS).toBe('claude-code');
	});
});
