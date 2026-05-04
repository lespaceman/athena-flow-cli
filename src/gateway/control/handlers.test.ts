/**
 * Handler-level tests for relay.* dispatcher entries. Boots no daemon —
 * `createDispatcher` is invoked directly with mocked deps so we can assert
 * authorization (a connection that authenticated by token but never
 * registered as a runtime cannot create or cancel relay requests).
 */

import {describe, expect, it, vi} from 'vitest';
import {createDispatcher} from './handlers';
import {RelayCoordinator} from '../relay/coordinator';
import {SessionRegistry} from '../sessionRegistry';
import type {ConnectionContext} from './server';
import type {
	ChannelAdapter,
	ControlEnvelope,
	ControlResponseEnvelope,
} from '../../shared/gateway-protocol';

function makeAdapter(): ChannelAdapter {
	return {
		id: 'fake',
		capabilities: {
			chat: true,
			threads: false,
			relayPermission: true,
			relayQuestion: true,
		},
		start: async () => {},
		stop: async () => {},
		send: async () => ({providerMessageId: 'm', deliveredAt: 0}),
		probe: async () => ({ok: true, checkedAt: 0}),
		on: () => {},
		off: () => {},
		requestPermissionVerdict: () => new Promise(() => {}),
		requestQuestionAnswer: () => new Promise(() => {}),
	};
}

function makeConnection(connectionId: string): ConnectionContext {
	return {
		connectionId,
		push: vi.fn(),
		disconnect: vi.fn(),
	};
}

function envelope<K extends string, P>(
	kind: K,
	payload: P,
): ControlEnvelope<K, P> {
	return {request_id: `req-${kind}`, ts: 0, kind, payload};
}

function expectError(
	res: ControlResponseEnvelope,
): Extract<ControlResponseEnvelope, {ok: false}> {
	if (res.ok)
		throw new Error(
			`expected error envelope, got ok payload ${JSON.stringify(res)}`,
		);
	return res;
}

describe('dispatcher: relay.* require a registered runtime connection', () => {
	it('relay.permission.request rejects unregistered authenticated callers', async () => {
		const registry = new SessionRegistry();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => [makeAdapter()],
		});
		const handle = createDispatcher({
			startedAt: 0,
			registry,
			relayCoordinator,
		});
		const res = await handle(
			envelope('relay.permission.request', {
				toolName: 'Bash',
				description: 'ls',
				inputPreview: '',
			}),
			makeConnection('conn-x'),
		);
		const err = expectError(res);
		expect(err.error.code).toBe('not_registered');
		expect(relayCoordinator.pendingCount()).toBe(0);
	});

	it('relay.question.request rejects unregistered authenticated callers', async () => {
		const registry = new SessionRegistry();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => [makeAdapter()],
		});
		const handle = createDispatcher({
			startedAt: 0,
			registry,
			relayCoordinator,
		});
		const res = await handle(
			envelope('relay.question.request', {
				title: 'pick',
				questions: [
					{
						key: 'q',
						header: 'h',
						question: 'q?',
						multi_select: false,
						options: [],
					},
				],
			}),
			makeConnection('conn-x'),
		);
		const err = expectError(res);
		expect(err.error.code).toBe('not_registered');
		expect(relayCoordinator.pendingCount()).toBe(0);
	});

	it('relay.permission.cancel rejects unregistered authenticated callers', async () => {
		const registry = new SessionRegistry();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => [makeAdapter()],
		});
		const cancelSpy = vi.spyOn(relayCoordinator, 'cancel');
		const handle = createDispatcher({
			startedAt: 0,
			registry,
			relayCoordinator,
		});
		const res = await handle(
			envelope('relay.permission.cancel', {
				channelRequestId: 'cr1',
				reason: 'resolved_locally',
			}),
			makeConnection('conn-x'),
		);
		const err = expectError(res);
		expect(err.error.code).toBe('not_registered');
		expect(cancelSpy).not.toHaveBeenCalled();
	});

	it('relay.question.cancel rejects unregistered authenticated callers', async () => {
		const registry = new SessionRegistry();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => [makeAdapter()],
		});
		const cancelSpy = vi.spyOn(relayCoordinator, 'cancel');
		const handle = createDispatcher({
			startedAt: 0,
			registry,
			relayCoordinator,
		});
		const res = await handle(
			envelope('relay.question.cancel', {
				channelRequestId: 'cr1',
				reason: 'resolved_locally',
			}),
			makeConnection('conn-x'),
		);
		const err = expectError(res);
		expect(err.error.code).toBe('not_registered');
		expect(cancelSpy).not.toHaveBeenCalled();
	});

	it('relay.permission.request succeeds once the connection is bound to a runtime', async () => {
		const registry = new SessionRegistry();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => [makeAdapter()],
		});
		registry.register({runtimeId: 'r1', defaultAgentId: 'main', pid: 1});
		registry.bindConnection('r1', 'conn-r1');
		const handle = createDispatcher({
			startedAt: 0,
			registry,
			relayCoordinator,
		});
		const reqPromise = handle(
			envelope('relay.permission.request', {
				channelRequestId: 'cr1',
				toolName: 'Bash',
				description: 'ls',
				inputPreview: '',
			}),
			makeConnection('conn-r1'),
		);
		// Adapter never resolves; cancel to free the pending entry so the
		// handler resolves and the test exits cleanly.
		await Promise.resolve();
		expect(relayCoordinator.pendingCount()).toBe(1);
		relayCoordinator.cancel('cr1', 'resolved_locally', 'r1');
		const res = await reqPromise;
		expect(res.ok).toBe(true);
	});
});
