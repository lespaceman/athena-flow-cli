/** @vitest-environment jsdom */
import React from 'react';
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {render, waitFor} from '@testing-library/react';

const useFeedMock = vi.fn();
const createSessionStoreMock = vi.fn();
const sessionsDirMock = vi.fn(() => '/tmp/athena-sessions');

vi.mock('./useFeed', () => ({
	useFeed: (...args: unknown[]) => useFeedMock(...args),
}));

vi.mock('../../infra/sessions/store', () => ({
	createSessionStore: (...args: unknown[]) => createSessionStoreMock(...args),
}));

vi.mock('../../infra/sessions/registry', () => ({
	sessionsDir: () => sessionsDirMock(),
}));

const {HookProvider} = await import('./RuntimeProvider');

function makeRuntime() {
	return {
		start: vi.fn(() => Promise.resolve()),
		stop: vi.fn(),
		getStatus: vi.fn(() => 'stopped' as const),
		getLastError: vi.fn(() => null),
		onEvent: vi.fn(() => () => {}),
		onDecision: vi.fn(() => () => {}),
		sendDecision: vi.fn(),
	};
}

describe('HookProvider runtime factory wiring', () => {
	beforeEach(() => {
		useFeedMock.mockReset();
		createSessionStoreMock.mockReset();
		sessionsDirMock.mockClear();
		createSessionStoreMock.mockReturnValue({
			close: vi.fn(),
			toBootstrap: vi.fn(),
			getRestoredTokens: vi.fn(),
		});
		useFeedMock.mockReturnValue({
			items: [],
			feedEvents: [],
			tasks: [],
			session: null,
			currentRun: null,
			actors: [],
			isServerRunning: false,
			currentPermissionRequest: null,
			permissionQueueCount: 0,
			resolvePermission: vi.fn(),
			currentQuestionRequest: null,
			questionQueueCount: 0,
			resolveQuestion: vi.fn(),
			resetSession: vi.fn(),
			clearEvents: vi.fn(),
			rules: [],
			addRule: vi.fn(),
			removeRule: vi.fn(),
			clearRules: vi.fn(),
			printTaskSnapshot: vi.fn(),
			emitNotification: vi.fn(),
			isDegraded: false,
			runtimeError: null,
			postByToolUseId: new Map(),
			allocateSeq: vi.fn(() => 1),
			recordTokens: vi.fn(),
			restoredTokens: null,
		});
	});

	it('constructs runtime via runtimeFactory using selected harness inputs', async () => {
		const runtime = makeRuntime();
		const runtimeFactory = vi.fn(() => runtime);
		const {unmount} = render(
			<HookProvider
				projectDir="/repo"
				instanceId={42}
				harness="openai-codex"
				runtimeFactory={runtimeFactory}
				allowedTools={['Read']}
				athenaSessionId="athena-1"
			>
				<></>
			</HookProvider>,
		);

		expect(runtimeFactory).toHaveBeenCalledWith({
			harness: 'openai-codex',
			projectDir: '/repo',
			instanceId: 42,
		});
		await waitFor(() =>
			expect(useFeedMock).toHaveBeenCalledWith(
				runtime,
				[],
				['Read'],
				expect.any(Object),
				{autoStart: false},
			),
		);

		unmount();
		const store = createSessionStoreMock.mock.results[0]?.value as {
			close: ReturnType<typeof vi.fn>;
		};
		expect(store.close).toHaveBeenCalledTimes(1);
	});

	it('prefers provided runtime over runtimeFactory', async () => {
		const providedRuntime = makeRuntime();
		const runtimeFactory = vi.fn(() => makeRuntime());

		render(
			<HookProvider
				projectDir="/repo"
				instanceId={7}
				harness="claude-code"
				runtime={providedRuntime}
				runtimeFactory={runtimeFactory}
				athenaSessionId="athena-2"
			>
				<></>
			</HookProvider>,
		);

		expect(runtimeFactory).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(useFeedMock).toHaveBeenCalledWith(
				providedRuntime,
				[],
				undefined,
				expect.any(Object),
				{autoStart: false},
			),
		);
	});

	it('waits for runtime startup before mounting useFeed', async () => {
		let resolveStart: (() => void) | null = null;
		const runtime = {
			...makeRuntime(),
			start: vi.fn(
				() =>
					new Promise<void>(resolve => {
						resolveStart = resolve;
					}),
			),
		};

		const {queryByText} = render(
			<HookProvider
				projectDir="/repo"
				instanceId={9}
				harness="claude-code"
				runtime={runtime}
				athenaSessionId="athena-3"
			>
				<></>
			</HookProvider>,
		);

		expect(queryByText('Starting Athena hook server...')).not.toBeNull();
		expect(useFeedMock).not.toHaveBeenCalled();

		resolveStart?.();

		await waitFor(() => expect(useFeedMock).toHaveBeenCalledTimes(1));
	});

	it('re-gates mounting when the runtime instance changes', async () => {
		let resolveFirstStart: (() => void) | null = null;
		const firstRuntime = {
			...makeRuntime(),
			start: vi.fn(
				() =>
					new Promise<void>(resolve => {
						resolveFirstStart = resolve;
					}),
			),
		};

		const {queryByText, rerender} = render(
			<HookProvider
				projectDir="/repo"
				instanceId={9}
				harness="claude-code"
				runtime={firstRuntime}
				athenaSessionId="athena-4"
			>
				<></>
			</HookProvider>,
		);

		resolveFirstStart?.();
		await waitFor(() => expect(useFeedMock).toHaveBeenCalledTimes(1));

		let resolveSecondStart: (() => void) | null = null;
		const secondRuntime = {
			...makeRuntime(),
			start: vi.fn(
				() =>
					new Promise<void>(resolve => {
						resolveSecondStart = resolve;
					}),
			),
		};

		rerender(
			<HookProvider
				projectDir="/repo"
				instanceId={10}
				harness="openai-codex"
				runtime={secondRuntime}
				athenaSessionId="athena-4"
			>
				<></>
			</HookProvider>,
		);

		expect(queryByText('Starting Athena hook server...')).not.toBeNull();
		expect(useFeedMock).toHaveBeenCalledTimes(1);

		resolveSecondStart?.();
		await waitFor(() => expect(useFeedMock).toHaveBeenCalledTimes(2));
	});
});
