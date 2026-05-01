/** @vitest-environment jsdom */
import {describe, it, expect, vi} from 'vitest';
import {renderHook, act, waitFor} from '@testing-library/react';
import {useFeed} from '../useFeed';
import type {ChannelRegistry} from '../../../channels/registry';
import type {
	Runtime,
	RuntimeEvent,
	RuntimeEventHandler,
	RuntimeDecisionHandler,
	RuntimeStartupError,
} from '../../../core/runtime/types';

function createMockRuntime(): Runtime & {
	emitEvent: (event: RuntimeEvent) => void;
} {
	const eventListeners: RuntimeEventHandler[] = [];
	const decisionListeners: RuntimeDecisionHandler[] = [];
	let status: 'stopped' | 'running' = 'running';
	const lastError: RuntimeStartupError | null = null;
	return {
		onEvent: cb => {
			eventListeners.push(cb);
			return () => {
				eventListeners.splice(eventListeners.indexOf(cb), 1);
			};
		},
		onDecision: cb => {
			decisionListeners.push(cb);
			return () => {
				decisionListeners.splice(decisionListeners.indexOf(cb), 1);
			};
		},
		sendDecision: vi.fn(),
		start: vi.fn(() => Promise.resolve()),
		stop: vi.fn(() => {
			status = 'stopped';
		}),
		getStatus: () => status,
		getLastError: () => lastError,
		emitEvent: event => eventListeners.forEach(cb => cb(event)),
	};
}

function makeMessageCompleteEvent(
	id: string,
	message: string,
	itemId = `m-${id}`,
): RuntimeEvent {
	return {
		id,
		timestamp: Date.now(),
		kind: 'message.complete',
		data: {item_id: itemId, message},
		hookName: 'StreamItem',
		sessionId: 'test-session',
		context: {cwd: '/test', transcriptPath: '/test/transcript.jsonl'},
		interaction: {expectsDecision: false},
		payload: {},
	};
}

function makeSubagentStartEvent(id: string): RuntimeEvent {
	return {
		id,
		timestamp: Date.now(),
		kind: 'subagent.start',
		data: {agent_id: `sa-${id}`, agent_type: 'researcher'},
		agentId: `sa-${id}`,
		agentType: 'researcher',
		hookName: 'SubagentStart',
		sessionId: 'test-session',
		context: {cwd: '/test', transcriptPath: '/test/transcript.jsonl'},
		interaction: {expectsDecision: false},
		payload: {},
	};
}

function makeChannelRegistryStub(): {
	notify: ReturnType<typeof vi.fn>;
	setPushFeedEvent: ReturnType<typeof vi.fn>;
	startAll: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	requestPermission: ReturnType<typeof vi.fn>;
	requestQuestion: ReturnType<typeof vi.fn>;
	tryClaimLocal: ReturnType<typeof vi.fn>;
	tryClaimLocalQuestion: ReturnType<typeof vi.fn>;
	notifySessionLabel: ReturnType<typeof vi.fn>;
	setOnChatMessage: ReturnType<typeof vi.fn>;
} {
	return {
		notify: vi.fn(),
		setPushFeedEvent: vi.fn(),
		startAll: vi.fn(),
		dispose: vi.fn(),
		requestPermission: vi.fn(),
		requestQuestion: vi.fn(),
		tryClaimLocal: vi.fn(() => true),
		tryClaimLocalQuestion: vi.fn(() => true),
		notifySessionLabel: vi.fn(),
		setOnChatMessage: vi.fn(),
	};
}

describe('useFeed → channelRegistry.notify filter', () => {
	it('notifies on root-scope agent.message events', async () => {
		const runtime = createMockRuntime();
		const channelRegistry = makeChannelRegistryStub();
		renderHook(() =>
			useFeed(runtime, [], undefined, undefined, {
				channelRegistry: channelRegistry as unknown as ChannelRegistry,
			}),
		);

		act(() => {
			runtime.emitEvent(makeMessageCompleteEvent('msg-1', 'hello world'));
		});

		await waitFor(() => {
			expect(channelRegistry.notify).toHaveBeenCalledTimes(1);
		});
		expect(channelRegistry.notify.mock.calls[0]?.[0]).toBe('hello world');
	});

	it('does not notify for subagent-scope agent.message events', async () => {
		const runtime = createMockRuntime();
		const channelRegistry = makeChannelRegistryStub();
		const {result} = renderHook(() =>
			useFeed(runtime, [], undefined, undefined, {
				channelRegistry: channelRegistry as unknown as ChannelRegistry,
			}),
		);

		// Push a subagent onto the stack so the next message.complete is
		// scoped to subagent, not root.
		act(() => {
			runtime.emitEvent(makeSubagentStartEvent('sa-1'));
			runtime.emitEvent(makeMessageCompleteEvent('msg-2', 'quiet message'));
		});

		// Wait for the message to flow through the feed deterministically,
		// then assert notify was suppressed.
		await waitFor(() => {
			expect(result.current.feedEvents.length).toBeGreaterThan(0);
		});
		expect(channelRegistry.notify).not.toHaveBeenCalled();
	});

	it('skips notify when channelRegistry is null', async () => {
		const runtime = createMockRuntime();
		const {result} = renderHook(() =>
			useFeed(runtime, [], undefined, undefined, {channelRegistry: null}),
		);

		act(() => {
			runtime.emitEvent(makeMessageCompleteEvent('msg-3', 'no registry'));
		});

		// Just confirm no throw and feed processed normally.
		await waitFor(() => {
			expect(result.current.feedEvents.length).toBeGreaterThan(0);
		});
	});
});
