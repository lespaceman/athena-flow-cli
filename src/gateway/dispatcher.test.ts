import {describe, expect, it, vi} from 'vitest';
import type {
	NormalizedInbound,
	SessionDispatchTurnPushPayload,
} from '../shared/gateway-protocol';
import {Dispatcher} from './dispatcher';
import {SessionRegistry} from './sessionRegistry';

function makeRegistry() {
	let n = 0;
	return new SessionRegistry({
		idFactory: () => `disp-${++n}`,
		now: () => 1000 + n,
	});
}

const inbound: NormalizedInbound = {
	location: {
		channelId: 'telegram',
		accountId: 'a',
		peer: {id: '12345', kind: 'user'},
	},
	sender: {id: '99', displayName: 'alice'},
	text: 'hello bot',
	receivedAt: 100,
	idempotencyKey: 'tg:1',
	providerMessageId: '5',
};

describe('Dispatcher', () => {
	it('drops inbound when no runtime is registered', () => {
		const registry = makeRegistry();
		const pushDispatch = vi.fn<(p: SessionDispatchTurnPushPayload) => void>();
		const sendOutbound = vi.fn();
		const dispatcher = new Dispatcher({
			registry,
			pushDispatch,
			sendOutbound,
		});
		const result = dispatcher.handleInbound(inbound);
		expect(result).toEqual({kind: 'dropped', reason: 'no_runtime'});
		expect(pushDispatch).not.toHaveBeenCalled();
	});

	it('dispatches inbound and pushes to runtime with default agent', () => {
		const registry = makeRegistry();
		registry.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 100});
		const pushDispatch = vi.fn<(p: SessionDispatchTurnPushPayload) => void>();
		const sendOutbound = vi.fn();
		const dispatcher = new Dispatcher({
			registry,
			pushDispatch,
			sendOutbound,
		});
		const result = dispatcher.handleInbound(inbound);
		expect(result).toMatchObject({
			kind: 'dispatched',
			dispatchId: 'disp-1',
			sessionKey: 'peer:telegram:a:12345',
		});
		expect(pushDispatch).toHaveBeenCalledOnce();
		expect(pushDispatch.mock.calls[0]?.[0]).toMatchObject({
			dispatchId: 'disp-1',
			sessionKey: 'peer:telegram:a:12345',
			agentId: 'main',
			inbound,
		});
		expect(registry.pendingDispatchCount()).toBe(1);
	});

	it('honours custom agent resolver', () => {
		const registry = makeRegistry();
		registry.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 1});
		const pushDispatch = vi.fn();
		const dispatcher = new Dispatcher({
			registry,
			pushDispatch,
			sendOutbound: vi.fn(),
			resolveAgent: ({channelId}) =>
				channelId === 'telegram' ? 'tg-agent' : 'main',
		});
		dispatcher.handleInbound(inbound);
		expect(
			(pushDispatch.mock.calls[0]?.[0] as SessionDispatchTurnPushPayload)
				.agentId,
		).toBe('tg-agent');
	});

	it('round-trips inbound → dispatch.turn → turn.complete → send()', async () => {
		const registry = makeRegistry();
		registry.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 1});
		const sendOutbound = vi
			.fn()
			.mockResolvedValue({providerMessageId: '101', deliveredAt: 1});
		const pushDispatch = vi.fn();
		const dispatcher = new Dispatcher({
			registry,
			pushDispatch,
			sendOutbound,
		});

		const dispatched = dispatcher.handleInbound(inbound);
		expect(dispatched.kind).toBe('dispatched');
		const dispatchId =
			dispatched.kind === 'dispatched' ? dispatched.dispatchId : '';

		const reply = await dispatcher.handleTurnComplete({
			runtimeId: 'r1',
			dispatchId,
			location: inbound.location,
			text: 'hi back',
			idempotencyKey: 'reply:1',
		});
		expect(reply).toEqual({delivered: true, providerMessageId: '101'});
		expect(sendOutbound).toHaveBeenCalledWith('telegram', {
			location: inbound.location,
			text: 'hi back',
			idempotencyKey: 'reply:1',
		});
		expect(registry.pendingDispatchCount()).toBe(0);
	});

	it('returns delivered=false for unknown dispatchId', async () => {
		const registry = makeRegistry();
		registry.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 1});
		const dispatcher = new Dispatcher({
			registry,
			pushDispatch: vi.fn(),
			sendOutbound: vi.fn(),
		});
		const reply = await dispatcher.handleTurnComplete({
			runtimeId: 'r1',
			dispatchId: 'missing',
			location: inbound.location,
			text: 'hi',
			idempotencyKey: 'k',
		});
		expect(reply).toEqual({delivered: false});
	});

	it('throws on runtimeId mismatch', async () => {
		const registry = makeRegistry();
		registry.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 1});
		const dispatcher = new Dispatcher({
			registry,
			pushDispatch: vi.fn(),
			sendOutbound: vi.fn(),
		});
		await expect(
			dispatcher.handleTurnComplete({
				runtimeId: 'rZ',
				dispatchId: 'd',
				location: inbound.location,
				text: 'hi',
				idempotencyKey: 'k',
			}),
		).rejects.toThrow('runtime mismatch');
	});
});
