import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {
	ControlPushEnvelope,
	NormalizedInbound,
	OutboundMessage,
	SendResult,
	SessionDispatchTurnPushPayload,
} from '../shared/gateway-protocol';
import {DispatchPipeline} from './dispatchPipeline';
import {AlreadyRegisteredError} from './runtimeBindingStore';
import {openGatewayState, type GatewayStateDb} from './state/db';

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

type Setup = {
	db: GatewayStateDb;
	pipeline: DispatchPipeline;
	send: ReturnType<typeof vi.fn>;
	push: ReturnType<typeof vi.fn>;
	now: {value: number};
	observers: {
		onRuntimeRebind: ReturnType<typeof vi.fn>;
		onRuntimeExpired: ReturnType<typeof vi.fn>;
		onRuntimeConnectionLost: ReturnType<typeof vi.fn>;
	};
};

function setup(opts: {gracePeriodMs?: number} = {}): Setup {
	const db = openGatewayState(':memory:');
	const send = vi.fn<(c: string, m: OutboundMessage) => Promise<SendResult>>();
	const push = vi.fn<(env: ControlPushEnvelope) => void>();
	const now = {value: 1_000};
	const observers = {
		onRuntimeRebind: vi.fn(),
		onRuntimeExpired: vi.fn(),
		onRuntimeConnectionLost: vi.fn(),
	};
	let counter = 0;
	const pipeline = new DispatchPipeline({
		stateDb: db,
		send,
		gracePeriodMs: opts.gracePeriodMs ?? 0,
		now: () => now.value,
		idFactory: () => `disp-${++counter}`,
		outbox: {tickIntervalMs: 60_000}, // disable drain timer in unit tests
		observers,
	});
	return {db, pipeline, send, push, now, observers};
}

function registerR1(s: Setup, opts: {connectionId?: string} = {}) {
	s.pipeline.registerRuntime({
		runtimeId: 'r1',
		defaultAgentId: 'main',
		pid: 100,
		connectionId: opts.connectionId ?? 'c1',
		push: s.push,
	});
}

describe('DispatchPipeline', () => {
	let s: Setup;
	beforeEach(() => {
		s = setup();
	});
	afterEach(async () => {
		await s.pipeline.stop();
		s.db.close();
	});

	describe('inbound without runtime', () => {
		it('parks inbound in the queue when no runtime is registered', () => {
			const result = s.pipeline.handleInbound(inbound);
			expect(result.kind).toBe('queued');
			expect(s.pipeline.pendingInboundCount()).toBe(1);
			expect(s.push).not.toHaveBeenCalled();
		});

		it('drops on queue_full when capacity is exceeded', async () => {
			await s.pipeline.stop();
			s.db.close();
			const db = openGatewayState(':memory:');
			const pipeline = new DispatchPipeline({
				stateDb: db,
				send: vi.fn(),
				inboundQueue: {maxEntries: 1},
				outbox: {tickIntervalMs: 60_000},
			});
			expect(
				pipeline.handleInbound({...inbound, idempotencyKey: 'k1'}).kind,
			).toBe('queued');
			expect(
				pipeline.handleInbound({...inbound, idempotencyKey: 'k2'}),
			).toEqual({
				kind: 'dropped',
				reason: 'queue_full',
			});
			await pipeline.stop();
			db.close();
		});
	});

	describe('inbound with runtime', () => {
		it('dispatches to the runtime push handle', () => {
			registerR1(s);
			const result = s.pipeline.handleInbound(inbound);
			expect(result).toMatchObject({
				kind: 'dispatched',
				dispatchId: 'disp-1',
				sessionKey: 'peer:telegram:a:12345',
			});
			expect(s.push).toHaveBeenCalledOnce();
			const env = s.push.mock.calls[0]?.[0] as ControlPushEnvelope;
			expect(env.kind).toBe('session.dispatch.turn');
			const payload = env.payload as SessionDispatchTurnPushPayload;
			expect(payload).toMatchObject({
				dispatchId: 'disp-1',
				sessionKey: 'peer:telegram:a:12345',
				agentId: 'main',
				inbound,
			});
			expect(s.pipeline.pendingDispatchCount()).toBe(1);
		});

		it('honours custom agent resolver', async () => {
			await s.pipeline.stop();
			s.db.close();
			const db = openGatewayState(':memory:');
			const push = vi.fn();
			const pipeline = new DispatchPipeline({
				stateDb: db,
				send: vi.fn(),
				resolveAgent: ({channelId}) =>
					channelId === 'telegram' ? 'tg-agent' : 'main',
				outbox: {tickIntervalMs: 60_000},
			});
			pipeline.registerRuntime({
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 1,
				connectionId: 'c1',
				push,
			});
			pipeline.handleInbound(inbound);
			const env = push.mock.calls[0]?.[0] as ControlPushEnvelope;
			expect((env.payload as SessionDispatchTurnPushPayload).agentId).toBe(
				'tg-agent',
			);
			await pipeline.stop();
			db.close();
		});

		it('drops to no_runtime when binding is stale (cannot push)', () => {
			registerR1(s);
			s.pipeline.notifyConnectionClosed('c1');
			// gracePeriodMs=0 → unregistered immediately
			const result = s.pipeline.handleInbound({
				...inbound,
				idempotencyKey: 'k2',
			});
			expect(result.kind).toBe('queued'); // parked in inbound queue, no runtime
		});
	});

	describe('register and drain', () => {
		it('drains parked inbound in FIFO order on register', () => {
			s.pipeline.handleInbound({...inbound, idempotencyKey: 'tg:1'});
			s.pipeline.handleInbound({...inbound, idempotencyKey: 'tg:2'});
			s.pipeline.handleInbound({...inbound, idempotencyKey: 'tg:3'});
			expect(s.pipeline.pendingInboundCount()).toBe(3);
			expect(s.push).not.toHaveBeenCalled();

			registerR1(s);

			expect(s.pipeline.pendingInboundCount()).toBe(0);
			expect(s.push).toHaveBeenCalledTimes(3);
			const keys = s.push.mock.calls.map(
				c =>
					(
						(c[0] as ControlPushEnvelope)
							.payload as SessionDispatchTurnPushPayload
					).inbound.idempotencyKey,
			);
			expect(keys).toEqual(['tg:1', 'tg:2', 'tg:3']);
		});

		it('rejects a second runtime with AlreadyRegisteredError', () => {
			registerR1(s);
			expect(() =>
				s.pipeline.registerRuntime({
					runtimeId: 'r2',
					defaultAgentId: 'main',
					pid: 200,
					connectionId: 'c2',
					push: vi.fn(),
				}),
			).toThrow(AlreadyRegisteredError);
		});

		it('allows the same runtime to re-register on reconnect', () => {
			registerR1(s);
			const push2 = vi.fn();
			s.pipeline.registerRuntime({
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 200,
				connectionId: 'c2',
				push: push2,
			});
			expect(s.pipeline.getCurrentRuntime()?.pid).toBe(200);
			s.pipeline.handleInbound(inbound);
			expect(push2).toHaveBeenCalledOnce();
			expect(s.push).not.toHaveBeenCalled();
		});
	});

	describe('turn complete round-trip', () => {
		it('round-trips inbound → dispatch.turn → turn.complete → send()', async () => {
			registerR1(s);
			s.send.mockResolvedValue({providerMessageId: '101', deliveredAt: 1});

			const dispatched = s.pipeline.handleInbound(inbound);
			expect(dispatched.kind).toBe('dispatched');
			const dispatchId =
				dispatched.kind === 'dispatched' ? dispatched.dispatchId : '';

			const reply = await s.pipeline.handleTurnComplete({
				runtimeId: 'r1',
				dispatchId,
				location: inbound.location,
				text: 'hi back',
				idempotencyKey: 'reply:1',
			});
			expect(reply).toEqual({delivered: true, providerMessageId: '101'});
			expect(s.send).toHaveBeenCalledWith('telegram', {
				location: inbound.location,
				text: 'hi back',
				idempotencyKey: 'reply:1',
			});
			expect(s.pipeline.pendingDispatchCount()).toBe(0);
		});

		it('returns delivered=false for unknown dispatchId', async () => {
			registerR1(s);
			const reply = await s.pipeline.handleTurnComplete({
				runtimeId: 'r1',
				dispatchId: 'missing',
				location: inbound.location,
				text: 'hi',
				idempotencyKey: 'k',
			});
			expect(reply).toEqual({delivered: false});
		});

		it('throws on runtimeId mismatch', async () => {
			registerR1(s);
			await expect(
				s.pipeline.handleTurnComplete({
					runtimeId: 'rZ',
					dispatchId: 'd',
					location: inbound.location,
					text: 'hi',
					idempotencyKey: 'k',
				}),
			).rejects.toThrow('runtime mismatch');
		});

		it('parks the outbound message when send fails', async () => {
			registerR1(s);
			s.send.mockRejectedValueOnce(new Error('network down'));

			const dispatched = s.pipeline.handleInbound(inbound);
			const dispatchId =
				dispatched.kind === 'dispatched' ? dispatched.dispatchId : '';

			const reply = await s.pipeline.handleTurnComplete({
				runtimeId: 'r1',
				dispatchId,
				location: inbound.location,
				text: 'hi back',
				idempotencyKey: 'reply:1',
			});
			expect(reply.delivered).toBe(true);
			expect(reply.providerMessageId).toMatch(/^outbox:/);
			expect(s.pipeline.pendingOutboxCount()).toBe(1);
		});
	});

	describe('connection lifecycle (grace=0)', () => {
		it('immediately unregisters and notifies on connection close', () => {
			registerR1(s);
			s.pipeline.notifyConnectionClosed('c1');
			expect(s.pipeline.getCurrentRuntime()).toBeNull();
			expect(s.observers.onRuntimeConnectionLost).toHaveBeenCalledWith({
				runtimeId: 'r1',
				graceful: false,
			});
		});

		it('ignores close events for unrelated connections', () => {
			registerR1(s);
			s.pipeline.notifyConnectionClosed('c-other');
			expect(s.pipeline.getCurrentRuntime()?.runtimeId).toBe('r1');
			expect(s.observers.onRuntimeConnectionLost).not.toHaveBeenCalled();
		});

		it('graceful unregisterRuntime notifies onRuntimeConnectionLost so pending relays can dispose', () => {
			registerR1(s);
			s.pipeline.unregisterRuntime('r1');
			expect(s.pipeline.getCurrentRuntime()).toBeNull();
			expect(s.observers.onRuntimeConnectionLost).toHaveBeenCalledWith({
				runtimeId: 'r1',
				graceful: true,
			});
		});
	});

	describe('connection lifecycle (grace>0)', () => {
		beforeEach(async () => {
			await s.pipeline.stop();
			s.db.close();
			vi.useFakeTimers();
			s = setup({gracePeriodMs: 30_000});
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it('marks binding stale and schedules expiry; expires after grace', () => {
			registerR1(s);
			s.now.value = 2_000;
			s.pipeline.notifyConnectionClosed('c1');
			expect(s.pipeline.getCurrentRuntime()?.runtimeId).toBe('r1');
			expect(s.pipeline.hasActiveBinding()).toBe(false);
			expect(s.observers.onRuntimeExpired).not.toHaveBeenCalled();

			s.now.value = 32_001;
			vi.advanceTimersByTime(30_001);
			expect(s.pipeline.getCurrentRuntime()).toBeNull();
			expect(s.observers.onRuntimeExpired).toHaveBeenCalledWith({
				runtimeId: 'r1',
				gapMs: 30_001,
			});
			expect(s.observers.onRuntimeConnectionLost).toHaveBeenCalledWith({
				runtimeId: 'r1',
				graceful: false,
			});
		});

		it('cancels expiry and fires onRuntimeRebind on reconnect during grace', () => {
			registerR1(s);
			s.now.value = 2_000;
			s.pipeline.notifyConnectionClosed('c1');

			s.now.value = 5_000;
			s.pipeline.registerRuntime({
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 100,
				connectionId: 'c2',
				push: s.push,
			});
			expect(s.pipeline.hasActiveBinding('r1')).toBe(true);
			expect(s.observers.onRuntimeRebind).toHaveBeenCalledWith({
				runtimeId: 'r1',
				gapMs: 3_000,
				epoch: 2,
			});

			vi.advanceTimersByTime(60_000);
			expect(s.observers.onRuntimeExpired).not.toHaveBeenCalled();
			expect(s.pipeline.getCurrentRuntime()?.runtimeId).toBe('r1');
		});
	});

	describe('reads', () => {
		it('reports getRuntimeIdByConnection', () => {
			registerR1(s);
			expect(s.pipeline.getRuntimeIdByConnection('c1')).toBe('r1');
			expect(s.pipeline.getRuntimeIdByConnection('c-other')).toBeNull();
		});

		it('returns null binding before any registration', () => {
			expect(s.pipeline.getBinding()).toBeNull();
			expect(s.pipeline.getCurrentRuntime()).toBeNull();
			expect(s.pipeline.hasActiveBinding()).toBe(false);
		});
	});

	describe('multi-runtime by attachmentId', () => {
		it('hosts two runtimes concurrently when each registers under a distinct attachmentId', () => {
			s.pipeline.registerRuntime({
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 100,
				connectionId: 'c1',
				push: s.push,
				attachmentId: 'a1',
			});
			s.pipeline.registerRuntime({
				runtimeId: 'r2',
				defaultAgentId: 'main',
				pid: 200,
				connectionId: 'c2',
				push: vi.fn(),
				attachmentId: 'a2',
			});
			expect(s.pipeline.getCurrentRuntimeByAttachment('a1')?.runtimeId).toBe(
				'r1',
			);
			expect(s.pipeline.getCurrentRuntimeByAttachment('a2')?.runtimeId).toBe(
				'r2',
			);
		});

		it('handleTurnComplete accepts replies from a runtime registered under any attachment slot', async () => {
			const push2 = vi.fn();
			s.pipeline.registerRuntime({
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 100,
				connectionId: 'c1',
				push: s.push,
				attachmentId: 'a1',
			});
			s.pipeline.registerRuntime({
				runtimeId: 'r2',
				defaultAgentId: 'main',
				pid: 200,
				connectionId: 'c2',
				push: push2,
				attachmentId: 'a2',
			});
			s.send.mockResolvedValue({providerMessageId: 'msg', deliveredAt: 1});

			const dispatched = s.pipeline.handleInbound(inbound, {
				attachmentId: 'a2',
			});
			const dispatchId =
				dispatched.kind === 'dispatched' ? dispatched.dispatchId : '';

			const reply = await s.pipeline.handleTurnComplete({
				runtimeId: 'r2',
				dispatchId,
				location: inbound.location,
				text: 'pong',
				idempotencyKey: 'reply:1',
			});

			expect(reply).toEqual({delivered: true, providerMessageId: 'msg'});
		});

		it('unregisterRuntime on one slot leaves the other slot fully functional', () => {
			const push2 = vi.fn();
			s.pipeline.registerRuntime({
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 100,
				connectionId: 'c1',
				push: s.push,
				attachmentId: 'a1',
			});
			s.pipeline.registerRuntime({
				runtimeId: 'r2',
				defaultAgentId: 'main',
				pid: 200,
				connectionId: 'c2',
				push: push2,
				attachmentId: 'a2',
			});

			s.pipeline.unregisterRuntime('r1');

			expect(s.pipeline.getCurrentRuntimeByAttachment('a1')).toBeNull();
			expect(s.pipeline.getCurrentRuntimeByAttachment('a2')?.runtimeId).toBe(
				'r2',
			);
			s.pipeline.handleInbound(inbound, {attachmentId: 'a2'});
			expect(push2).toHaveBeenCalledOnce();
			expect(s.push).not.toHaveBeenCalled();
		});

		it('legacy registration (no attachmentId) coexists with an attachment-keyed registration', () => {
			const push2 = vi.fn();
			// Legacy slot
			s.pipeline.registerRuntime({
				runtimeId: 'r-legacy',
				defaultAgentId: 'main',
				pid: 1,
				connectionId: 'c-legacy',
				push: s.push,
			});
			// Attachment slot
			s.pipeline.registerRuntime({
				runtimeId: 'r-a1',
				defaultAgentId: 'main',
				pid: 2,
				connectionId: 'c-a1',
				push: push2,
				attachmentId: 'a1',
			});

			expect(s.pipeline.getCurrentRuntime()?.runtimeId).toBe('r-legacy');
			expect(s.pipeline.getCurrentRuntimeByAttachment('a1')?.runtimeId).toBe(
				'r-a1',
			);

			s.pipeline.handleInbound(inbound); // no attachment → legacy slot
			expect(s.push).toHaveBeenCalledOnce();
			expect(push2).not.toHaveBeenCalled();

			s.pipeline.handleInbound(
				{...inbound, idempotencyKey: 'tg:2'},
				{attachmentId: 'a1'},
			);
			expect(push2).toHaveBeenCalledOnce();
			expect(s.push).toHaveBeenCalledOnce();
		});

		it('notifyConnectionClosed on one slot leaves the other slot fully functional', () => {
			const push2 = vi.fn();
			s.pipeline.registerRuntime({
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 100,
				connectionId: 'c1',
				push: s.push,
				attachmentId: 'a1',
			});
			s.pipeline.registerRuntime({
				runtimeId: 'r2',
				defaultAgentId: 'main',
				pid: 200,
				connectionId: 'c2',
				push: push2,
				attachmentId: 'a2',
			});

			s.pipeline.notifyConnectionClosed('c1');

			expect(s.pipeline.getCurrentRuntimeByAttachment('a1')).toBeNull();
			expect(s.pipeline.getCurrentRuntimeByAttachment('a2')?.runtimeId).toBe(
				'r2',
			);
			s.pipeline.handleInbound(inbound, {attachmentId: 'a2'});
			expect(push2).toHaveBeenCalledOnce();
		});

		it('handleTurnComplete throws when runtimeId matches no slot', async () => {
			s.pipeline.registerRuntime({
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 100,
				connectionId: 'c1',
				push: s.push,
				attachmentId: 'a1',
			});

			await expect(
				s.pipeline.handleTurnComplete({
					runtimeId: 'rZ',
					dispatchId: 'd',
					location: inbound.location,
					text: 'x',
					idempotencyKey: 'k',
				}),
			).rejects.toThrow('runtime mismatch');
		});

		it('handleInbound routes the dispatch to the push for the matching attachmentId', () => {
			const push2 = vi.fn();
			s.pipeline.registerRuntime({
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 100,
				connectionId: 'c1',
				push: s.push,
				attachmentId: 'a1',
			});
			s.pipeline.registerRuntime({
				runtimeId: 'r2',
				defaultAgentId: 'main',
				pid: 200,
				connectionId: 'c2',
				push: push2,
				attachmentId: 'a2',
			});

			s.pipeline.handleInbound(inbound, {attachmentId: 'a2'});

			expect(push2).toHaveBeenCalledOnce();
			expect(s.push).not.toHaveBeenCalled();

			s.pipeline.handleInbound(
				{...inbound, idempotencyKey: 'tg:2'},
				{attachmentId: 'a1'},
			);
			expect(s.push).toHaveBeenCalledOnce();
			expect(push2).toHaveBeenCalledOnce();
		});
	});

	describe('run event streaming', () => {
		it('routes session.run.event to the registered slot via send', async () => {
			registerR1(s);
			s.send.mockResolvedValue({providerMessageId: 'rx-1', deliveredAt: 5});

			const result = await s.pipeline.handleRunEvent({
				runtimeId: 'r1',
				location: {channelId: 'runner:r1', accountId: 'runner:r1'},
				runId: 'run-A',
				seq: 4,
				ts: 555,
				kind: 'progress',
				payload: {message: 'thinking'},
			});

			expect(result).toEqual({delivered: true});
			expect(s.send).toHaveBeenCalledTimes(1);
			const [channelId, msg] = s.send.mock.calls[0]!;
			expect(channelId).toBe('runner:r1');
			expect(msg.location).toEqual({
				channelId: 'runner:r1',
				accountId: 'runner:r1',
			});
			expect(msg.idempotencyKey).toBe('run_event:run-A:4');
			expect(JSON.parse(msg.text)).toEqual({
				kind: 'run_event',
				runId: 'run-A',
				seq: 4,
				ts: 555,
				eventKind: 'progress',
				payload: {message: 'thinking'},
			});
		});

		it('throws on runtimeId mismatch', async () => {
			registerR1(s);
			await expect(
				s.pipeline.handleRunEvent({
					runtimeId: 'rZ',
					location: {channelId: 'runner:r1', accountId: 'runner:r1'},
					runId: 'r',
					seq: 1,
					ts: 0,
					kind: 'progress',
				}),
			).rejects.toThrow('runtime mismatch');
		});
	});
});
