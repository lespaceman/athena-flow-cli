/** @vitest-environment jsdom */
import React from 'react';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {cleanup, render, waitFor} from '@testing-library/react';

const useFeedMock = vi.fn();
const createSessionStoreMock = vi.fn();
const sessionsDirMock = vi.fn(() => '/tmp/athena-sessions');
const sessionBridgeStartMock = vi.fn();
const sessionBridgeStopMock = vi.fn();
const sessionBridgeRelayPermissionMock = vi.fn();
const sessionBridgeInstances: Array<{
	runtimeId: string;
	defaultAgentId: string;
	attachmentId?: string;
}> = [];

vi.mock('./useFeed', () => ({
	useFeed: (...args: unknown[]) => useFeedMock(...args),
}));

vi.mock('../../infra/sessions/store', () => ({
	createSessionStore: (...args: unknown[]) => createSessionStoreMock(...args),
}));

vi.mock('../../infra/sessions/registry', () => ({
	sessionsDir: () => sessionsDirMock(),
}));

vi.mock('../channels/sessionBridge', () => ({
	SessionBridge: class {
		constructor(opts: {
			runtimeId: string;
			defaultAgentId: string;
			attachmentId?: string;
		}) {
			sessionBridgeInstances.push(opts);
		}
		start = sessionBridgeStartMock;
		stop = sessionBridgeStopMock;
		relayPermission = sessionBridgeRelayPermissionMock;
	},
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
		sessionBridgeStartMock.mockReset();
		sessionBridgeStopMock.mockReset();
		sessionBridgeRelayPermissionMock.mockReset();
		sessionBridgeInstances.length = 0;
		sessionBridgeStartMock.mockRejectedValue(new Error('gateway unavailable'));
		sessionBridgeRelayPermissionMock.mockResolvedValue({
			channelRequestId: 'relay-1',
			result: {
				kind: 'verdict',
				channelId: 'test-channel',
				behavior: 'allow',
			},
		});
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

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
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
				{},
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
				{},
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
		expect(
			useFeedMock.mock.calls.some(
				([runtimeArg]) => runtimeArg === secondRuntime,
			),
		).toBe(false);

		resolveSecondStart?.();
		await waitFor(() =>
			expect(
				useFeedMock.mock.calls.some(
					([runtimeArg]) => runtimeArg === secondRuntime,
				),
			).toBe(true),
		);
	});

	it('does not close sessionStore when only the runtime changes', async () => {
		const firstRuntime = makeRuntime();
		const secondRuntime = makeRuntime();

		const {rerender, unmount} = render(
			<HookProvider
				projectDir="/repo"
				instanceId={1}
				harness="claude-code"
				runtime={firstRuntime}
				athenaSessionId="athena-lifecycle"
			>
				<></>
			</HookProvider>,
		);

		await waitFor(() => expect(useFeedMock).toHaveBeenCalledTimes(1));

		const store = createSessionStoreMock.mock.results[0]?.value as {
			close: ReturnType<typeof vi.fn>;
		};
		expect(store.close).not.toHaveBeenCalled();

		// Swap runtime (simulates workflow change) — sessionStore deps unchanged
		rerender(
			<HookProvider
				projectDir="/repo"
				instanceId={1}
				harness="openai-codex"
				runtime={secondRuntime}
				athenaSessionId="athena-lifecycle"
			>
				<></>
			</HookProvider>,
		);

		await waitFor(() => expect(useFeedMock).toHaveBeenCalledTimes(2));

		// sessionStore must NOT have been closed — its deps didn't change
		expect(store.close).not.toHaveBeenCalled();
		// old runtime should have been stopped by cleanup
		expect(firstRuntime.stop).toHaveBeenCalled();

		// On full unmount, sessionStore IS closed
		unmount();
		expect(store.close).toHaveBeenCalledTimes(1);
	});

	it('starts a SessionBridge and relays permission verdicts into runtime decisions', async () => {
		sessionBridgeStartMock.mockResolvedValueOnce({
			registeredAt: 1,
			gatewayStartedAt: 1,
		});
		const runtime = makeRuntime();

		render(
			<HookProvider
				projectDir="/repo"
				instanceId={11}
				harness="claude-code"
				runtime={runtime}
				athenaSessionId="athena-remote"
			>
				<></>
			</HookProvider>,
		);

		await waitFor(() =>
			expect(sessionBridgeInstances).toContainEqual({
				runtimeId: 'athena-remote',
				defaultAgentId: 'main',
			}),
		);
		await waitFor(() =>
			expect(
				useFeedMock.mock.calls.some(
					call =>
						typeof (call[4] as {relayPermission?: unknown})?.relayPermission ===
						'function',
				),
			).toBe(true),
		);

		const relayOptions = useFeedMock.mock.calls.find(
			call =>
				typeof (call[4] as {relayPermission?: unknown})?.relayPermission ===
				'function',
		)?.[4] as {relayPermission: (event: unknown) => void};

		relayOptions.relayPermission({
			id: 'perm-1',
			timestamp: Date.now(),
			kind: 'permission.request',
			hookName: 'PermissionRequest',
			sessionId: 'session-1',
			toolName: 'Bash',
			data: {tool_name: 'Bash', tool_input: {command: 'pwd'}},
			context: {cwd: '/repo', transcriptPath: '/tmp/transcript.jsonl'},
			interaction: {expectsDecision: true, defaultTimeoutMs: 12_000},
			payload: {tool_input: {command: 'pwd'}},
			display: {title: 'Bash: pwd'},
		});

		await waitFor(() =>
			expect(sessionBridgeRelayPermissionMock).toHaveBeenCalledWith({
				toolName: 'Bash',
				description: 'Bash: pwd',
				inputPreview: '{\n  "command": "pwd"\n}',
				ttlMs: 12_000,
			}),
		);
		await waitFor(() =>
			expect(runtime.sendDecision).toHaveBeenCalledWith('perm-1', {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			}),
		);
	});

	it('retries SessionBridge startup after an initial connection failure', async () => {
		sessionBridgeStartMock
			.mockRejectedValueOnce(new Error('gateway unavailable'))
			.mockResolvedValueOnce({
				registeredAt: 1,
				gatewayStartedAt: 1,
			});
		const runtime = makeRuntime();

		render(
			<HookProvider
				projectDir="/repo"
				instanceId={12}
				harness="claude-code"
				runtime={runtime}
				athenaSessionId="athena-retry"
			>
				<></>
			</HookProvider>,
		);

		await waitFor(() =>
			expect(sessionBridgeStartMock).toHaveBeenCalledTimes(1),
		);

		await new Promise(resolve => setTimeout(resolve, 2_100));

		expect(sessionBridgeStartMock).toHaveBeenCalledTimes(2);
		await waitFor(() =>
			expect(
				useFeedMock.mock.calls.some(
					call =>
						typeof (call[4] as {relayPermission?: unknown})?.relayPermission ===
						'function',
				),
			).toBe(true),
		);
	});

	it('forwards attachmentId prop into the SessionBridge constructor', async () => {
		sessionBridgeStartMock.mockResolvedValueOnce({
			registeredAt: 1,
			gatewayStartedAt: 1,
		});
		const runtime = makeRuntime();

		render(
			<HookProvider
				projectDir="/repo"
				instanceId={13}
				harness="claude-code"
				runtime={runtime}
				athenaSessionId="athena-attached"
				attachmentId="r1"
			>
				<></>
			</HookProvider>,
		);

		await waitFor(() =>
			expect(sessionBridgeInstances).toContainEqual({
				runtimeId: 'athena-attached',
				defaultAgentId: 'main',
				attachmentId: 'r1',
			}),
		);
	});
});
