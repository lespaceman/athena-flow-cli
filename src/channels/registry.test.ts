import {describe, expect, it, vi} from 'vitest';
import {ChannelRegistry} from './registry';
import {PermissionRelay} from './permissionRelay';
import {QuestionRelay} from './questionRelay';
import type {ChannelDefinition} from './types';
import type {
	Runtime,
	RuntimeDecision,
	RuntimeEvent,
} from '../core/runtime/types';

function makeRuntime(): Runtime & {
	emitDecision: (eventId: string, decision: RuntimeDecision) => void;
} {
	const decisionHandlers = new Set<(id: string, d: RuntimeDecision) => void>();
	return {
		start: vi.fn(),
		stop: vi.fn(),
		getStatus: vi.fn(() => 'running'),
		getLastError: vi.fn(() => null),
		onEvent: vi.fn(() => () => {}),
		onDecision: vi.fn((handler: (id: string, d: RuntimeDecision) => void) => {
			decisionHandlers.add(handler);
			return () => {
				decisionHandlers.delete(handler);
			};
		}),
		sendDecision: vi.fn(),
		emitDecision: (eventId: string, decision: RuntimeDecision) => {
			for (const h of decisionHandlers) h(eventId, decision);
		},
	} as unknown as Runtime & {
		emitDecision: (eventId: string, decision: RuntimeDecision) => void;
	};
}

function makeEvent(id: string, toolName = 'Bash'): RuntimeEvent {
	return {
		id,
		timestamp: 0,
		kind: 'permission.request',
		data: {tool_name: toolName, tool_input: {a: 1}},
		hookName: 'PreToolUse',
		sessionId: 's',
		toolName,
		context: {cwd: '/', transcriptPath: ''},
		interaction: {expectsDecision: true},
		payload: {},
	};
}

function makeQuestionEvent(id: string): RuntimeEvent {
	return {
		id,
		timestamp: 0,
		kind: 'tool.pre',
		data: {
			tool_name: 'AskUserQuestion',
			tool_input: {
				questions: [
					{
						question: 'Should I continue?',
						header: 'Confirm',
						options: [],
						multiSelect: false,
					},
				],
			},
		},
		hookName: 'PreToolUse',
		sessionId: 's',
		toolName: 'AskUserQuestion',
		context: {cwd: '/', transcriptPath: ''},
		interaction: {expectsDecision: true},
		payload: {},
	};
}

describe('ChannelRegistry', () => {
	it('registers on the relay even when no hosts are attached', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const registry = new ChannelRegistry({
			sessionId: 's',
			relay,
			runtime,
			channels: [],
		});
		const ev = makeEvent('e1');
		registry.requestPermission(ev);

		expect(relay.isPending('e1')).toBe(true);
		// no broadcast / no feed event when 0 hosts
		const claimed = relay.tryClaim('e1', 'local');
		expect(claimed).toBe(true);
		registry.dispose();
		relay.dispose();
	});

	it('does not push feed events when no hosts attached', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const pushFeedEvent = vi.fn();
		const registry = new ChannelRegistry({
			sessionId: 's',
			relay,
			runtime,
			channels: [],
			pushFeedEvent,
		});
		registry.requestPermission(makeEvent('e1'));
		relay.tryClaim('e1', 'local');

		expect(pushFeedEvent).not.toHaveBeenCalled();
		registry.dispose();
		relay.dispose();
	});

	it('verdict path: claims, sends decision, never sends twice', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const channels: ChannelDefinition[] = [];
		const registry = new ChannelRegistry({
			sessionId: 's',
			relay,
			runtime,
			channels,
		});
		registry.requestPermission(makeEvent('e1'));

		// Simulate the channel verdict path by directly invoking tryClaim
		// (host wiring is exercised in host.integration tests).
		expect(relay.isPending('e1')).toBe(true);
		expect(
			relay.tryClaim('e1', 'channel', {
				behavior: 'allow',
				resolvingChannelName: 'telegram',
			}),
		).toBe(true);
		expect(
			relay.tryClaim('e1', 'local', {
				behavior: 'deny',
				resolvingChannelName: null,
			}),
		).toBe(false);
		registry.dispose();
		relay.dispose();
	});

	it('runtime decision (rule) claims pending entries automatically', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const registry = new ChannelRegistry({
			sessionId: 's',
			relay,
			runtime,
			channels: [],
		});
		registry.requestPermission(makeEvent('rule-event'));
		runtime.emitDecision('rule-event', {
			type: 'json',
			source: 'rule',
			intent: {kind: 'permission_deny', reason: 'rule blocked'},
		});

		// Subsequent local claim must be a no-op.
		expect(
			relay.tryClaim('rule-event', 'local', {
				behavior: 'allow',
				resolvingChannelName: null,
			}),
		).toBe(false);
		registry.dispose();
		relay.dispose();
	});

	it('question answer path claims and sends question_answer decision', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const questionRelay = new QuestionRelay({runtime});
		const registry = new ChannelRegistry({
			sessionId: 's',
			relay,
			questionRelay,
			runtime,
			channels: [],
		});
		registry.requestQuestion(makeQuestionEvent('q1'));
		const entry = questionRelay.resolveByChannelId('aaaaa');
		expect(entry).toBeUndefined();
		const pending = [
			...(
				questionRelay as unknown as {byChannelId: Map<string, string>}
			).byChannelId.keys(),
		][0]!;

		(
			registry as unknown as {handleEvent: (name: string, ev: unknown) => void}
		).handleEvent('telegram', {
			session_id: 's',
			event: 'question.answer',
			params: {
				channel_request_id: pending,
				answers: {'Should I continue?': 'yes'},
			},
		});

		expect(runtime.sendDecision).toHaveBeenCalledWith('q1', {
			type: 'json',
			source: 'user',
			intent: {
				kind: 'question_answer',
				answers: {'Should I continue?': 'yes'},
			},
		});
		registry.dispose();
	});

	it('notify is a no-op when no hosts are attached', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const registry = new ChannelRegistry({
			sessionId: 's',
			relay,
			runtime,
			channels: [],
		});
		expect(() => registry.notify('hello')).not.toThrow();
		registry.dispose();
		relay.dispose();
	});

	it('notify drops empty/whitespace content', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const fakeHost = {
			name: 'fake',
			send: vi.fn(),
			start: vi.fn(),
			dispose: vi.fn(),
		};
		const registry = new ChannelRegistry({
			sessionId: 's',
			relay,
			runtime,
			channels: [],
		});
		(registry as unknown as {clients: unknown[]}).clients.push(fakeHost);

		registry.notify('   ');
		registry.notify('');
		expect(fakeHost.send).not.toHaveBeenCalled();

		registry.notify('hello');
		expect(fakeHost.send).toHaveBeenCalledWith({
			session_id: 's',
			method: 'notification',
			params: {content: 'hello', meta: {}},
		});
		registry.dispose();
		relay.dispose();
	});

	it('notify forwards content verbatim — wire-level caps belong to the channel', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const fakeHost = {
			name: 'fake',
			send: vi.fn(),
			start: vi.fn(),
			dispose: vi.fn(),
		};
		const registry = new ChannelRegistry({
			sessionId: 's',
			relay,
			runtime,
			channels: [],
		});
		(registry as unknown as {clients: unknown[]}).clients.push(fakeHost);

		const huge = 'x'.repeat(5000);
		registry.notify(huge);
		const call = fakeHost.send.mock.calls[0]![0] as {
			params: {content: string};
		};
		expect(call.params.content).toBe(huge);
		registry.dispose();
		relay.dispose();
	});

	it('local question claim prevents late channel answer', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const questionRelay = new QuestionRelay({runtime});
		const registry = new ChannelRegistry({
			sessionId: 's',
			relay,
			questionRelay,
			runtime,
			channels: [],
		});
		registry.requestQuestion(makeQuestionEvent('q1'));
		const pending = [
			...(
				questionRelay as unknown as {byChannelId: Map<string, string>}
			).byChannelId.keys(),
		][0]!;

		expect(
			registry.tryClaimLocalQuestion('q1', {'Should I continue?': 'local'}),
		).toBe(true);
		(
			registry as unknown as {handleEvent: (name: string, ev: unknown) => void}
		).handleEvent('telegram', {
			session_id: 's',
			event: 'question.answer',
			params: {
				channel_request_id: pending,
				answers: {'Should I continue?': 'remote'},
			},
		});

		expect(runtime.sendDecision).not.toHaveBeenCalled();
		registry.dispose();
	});

	it('chat.message routes to setOnChatMessage handler in addition to feed event', () => {
		const runtime = makeRuntime();
		const relay = new PermissionRelay({runtime});
		const pushFeedEvent = vi.fn();
		const onChat = vi.fn();
		const registry = new ChannelRegistry({
			sessionId: 's',
			relay,
			runtime,
			channels: [],
			pushFeedEvent,
		});
		registry.setOnChatMessage(onChat);

		(
			registry as unknown as {handleEvent: (name: string, ev: unknown) => void}
		).handleEvent('telegram', {
			session_id: 's',
			event: 'chat.message',
			params: {content: 'check the build', meta: {sender_id: 'u1'}},
		});

		expect(pushFeedEvent).toHaveBeenCalledWith({
			kind: 'channel.chat.inbound',
			data: {
				channel_name: 'telegram',
				sender_id: 'u1',
				content: 'check the build',
			},
		});
		expect(onChat).toHaveBeenCalledWith({
			channel_name: 'telegram',
			sender_id: 'u1',
			content: 'check the build',
		});

		registry.setOnChatMessage(undefined);
		(
			registry as unknown as {handleEvent: (name: string, ev: unknown) => void}
		).handleEvent('telegram', {
			session_id: 's',
			event: 'chat.message',
			params: {content: 'second', meta: {sender_id: 'u1'}},
		});
		expect(onChat).toHaveBeenCalledTimes(1);
		registry.dispose();
	});
});
