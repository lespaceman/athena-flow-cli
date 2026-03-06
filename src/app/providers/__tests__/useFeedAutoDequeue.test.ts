/** @vitest-environment jsdom */
import {describe, it, expect, vi} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import {useFeed} from '../useFeed';
import type {SessionStore} from '../../../infra/sessions/store';
import type {
	Runtime,
	RuntimeEvent,
	RuntimeDecision,
	RuntimeEventHandler,
	RuntimeDecisionHandler,
} from '../../../core/runtime/types';

function createMockRuntime(): Runtime & {
	emitEvent: (event: RuntimeEvent) => void;
	emitDecision: (eventId: string, decision: RuntimeDecision) => void;
} {
	const eventListeners: RuntimeEventHandler[] = [];
	const decisionListeners: RuntimeDecisionHandler[] = [];

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
		start: vi.fn(),
		stop: vi.fn(),
		getStatus: () => 'running' as const,
		emitEvent: event => eventListeners.forEach(cb => cb(event)),
		emitDecision: (eventId, decision) =>
			decisionListeners.forEach(cb => cb(eventId, decision)),
	};
}

function makePermissionEvent(requestId: string): RuntimeEvent {
	return {
		id: requestId,
		timestamp: Date.now(),
		kind: 'permission.request',
		data: {
			tool_name: 'Bash',
			tool_input: {command: 'ls'},
		},
		hookName: 'PermissionRequest',
		sessionId: 'test-session',
		toolName: 'Bash',
		context: {cwd: '/test', transcriptPath: '/test/transcript.jsonl'},
		interaction: {expectsDecision: true},
		payload: {
			hook_event_name: 'PermissionRequest',
			session_id: 'test-session',
			transcript_path: '/test/transcript.jsonl',
			cwd: '/test',
			tool_name: 'Bash',
			tool_input: {command: 'ls'},
		},
	};
}

function makeTodoWriteEvent(
	requestId: string,
	todos: Array<{
		content: string;
		status: 'pending' | 'in_progress' | 'completed';
	}>,
): RuntimeEvent {
	return {
		id: requestId,
		timestamp: Date.now(),
		kind: 'tool.pre',
		data: {
			tool_name: 'TodoWrite',
			tool_input: {todos},
		},
		hookName: 'PreToolUse',
		sessionId: 'test-session',
		toolName: 'TodoWrite',
		context: {cwd: '/test', transcriptPath: '/test/transcript.jsonl'},
		interaction: {expectsDecision: false},
		payload: {
			hook_event_name: 'PreToolUse',
			session_id: 'test-session',
			transcript_path: '/test/transcript.jsonl',
			cwd: '/test',
			tool_name: 'TodoWrite',
			tool_input: {todos},
		},
	};
}

function makeBashEvent(requestId: string): RuntimeEvent {
	return {
		id: requestId,
		timestamp: Date.now(),
		kind: 'tool.pre',
		data: {
			tool_name: 'Bash',
			tool_input: {command: 'echo hi'},
		},
		hookName: 'PreToolUse',
		sessionId: 'test-session',
		toolName: 'Bash',
		context: {cwd: '/test', transcriptPath: '/test/transcript.jsonl'},
		interaction: {expectsDecision: false},
		payload: {
			hook_event_name: 'PreToolUse',
			session_id: 'test-session',
			transcript_path: '/test/transcript.jsonl',
			cwd: '/test',
			tool_name: 'Bash',
			tool_input: {command: 'echo hi'},
		},
	};
}

describe('useFeed permission auto-dequeue', () => {
	it('dequeues permission when decision event arrives via onDecision', () => {
		const runtime = createMockRuntime();
		const {result} = renderHook(() => useFeed(runtime));

		// Emit a permission request event
		act(() => {
			runtime.emitEvent(makePermissionEvent('req-1'));
		});

		// Should have 1 permission in queue
		expect(result.current.permissionQueueCount).toBe(1);

		// Emit a decision for this request
		act(() => {
			runtime.emitDecision('req-1', {
				type: 'passthrough',
				source: 'timeout',
			});
		});

		// Queue should be empty now
		expect(result.current.permissionQueueCount).toBe(0);
	});
});

describe('useFeed task extraction', () => {
	it('keeps the latest TodoWrite task list across unrelated events and updates completion state', () => {
		const runtime = createMockRuntime();
		const {result} = renderHook(() => useFeed(runtime));

		act(() => {
			runtime.emitEvent(
				makeTodoWriteEvent('todo-1', [
					{content: 'Create smoke suite', status: 'in_progress'},
					{content: 'Capture logs', status: 'pending'},
				]),
			);
		});

		expect(result.current.tasks).toEqual([
			{content: 'Create smoke suite', status: 'in_progress'},
			{content: 'Capture logs', status: 'pending'},
		]);

		act(() => {
			runtime.emitEvent(makeBashEvent('bash-1'));
		});

		expect(result.current.tasks).toEqual([
			{content: 'Create smoke suite', status: 'in_progress'},
			{content: 'Capture logs', status: 'pending'},
		]);

		act(() => {
			runtime.emitEvent(
				makeTodoWriteEvent('todo-2', [
					{content: 'Create smoke suite', status: 'completed'},
					{content: 'Capture logs', status: 'completed'},
				]),
			);
		});

		expect(result.current.tasks).toEqual([
			{content: 'Create smoke suite', status: 'completed'},
			{content: 'Capture logs', status: 'completed'},
		]);
	});
});

describe('useFeed session store lifecycle', () => {
	it('ignores late recordTokens calls after unmount', () => {
		const runtime = createMockRuntime();
		const sessionStore = {
			recordEvent: vi.fn(),
			recordFeedEvents: vi.fn(),
			restore: vi.fn(),
			toBootstrap: vi.fn(),
			getAthenaSession: vi.fn(),
			updateLabel: vi.fn(),
			recordTokens: vi.fn(),
			getRestoredTokens: vi.fn(() => null),
			close: vi.fn(),
			isDegraded: false,
			degradedReason: undefined,
			markDegraded: vi.fn(),
		} satisfies SessionStore;
		const {result, unmount} = renderHook(() =>
			useFeed(runtime, [], undefined, sessionStore),
		);

		const recordTokens = result.current.recordTokens;
		unmount();

		expect(() =>
			recordTokens('adapter-1', {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				total: 3,
				contextSize: 4,
			}),
		).not.toThrow();
		expect(sessionStore.recordTokens).not.toHaveBeenCalled();
		expect(sessionStore.markDegraded).not.toHaveBeenCalled();
	});
});
