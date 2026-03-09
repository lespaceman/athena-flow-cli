import {describe, it, expect, vi} from 'vitest';
import type {RuntimeConnector} from './connector';
import type {
	RuntimeDecision,
	RuntimeDecisionHandler,
	RuntimeEvent,
	RuntimeEventHandler,
} from './types';

function assertConnectorContract(connector: RuntimeConnector): void {
	expect(typeof connector.start).toBe('function');
	expect(typeof connector.stop).toBe('function');
	expect(typeof connector.getStatus).toBe('function');
	expect(typeof connector.getLastError).toBe('function');
	expect(typeof connector.onEvent).toBe('function');
	expect(typeof connector.onDecision).toBe('function');
	expect(typeof connector.sendDecision).toBe('function');
}

function createLocalConnectorMock(): RuntimeConnector & {
	emit: (event: RuntimeEvent) => void;
} {
	const eventHandlers = new Set<RuntimeEventHandler>();
	const decisionHandlers = new Set<RuntimeDecisionHandler>();
	let status: 'stopped' | 'running' = 'stopped';

	return {
		start() {
			status = 'running';
			return Promise.resolve();
		},
		stop() {
			status = 'stopped';
		},
		getStatus() {
			return status;
		},
		getLastError() {
			return null;
		},
		onEvent(handler: RuntimeEventHandler) {
			eventHandlers.add(handler);
			return () => eventHandlers.delete(handler);
		},
		onDecision(handler: RuntimeDecisionHandler) {
			decisionHandlers.add(handler);
			return () => decisionHandlers.delete(handler);
		},
		sendDecision(eventId: string, decision: RuntimeDecision) {
			for (const handler of decisionHandlers) handler(eventId, decision);
		},
		emit(event: RuntimeEvent) {
			for (const handler of eventHandlers) handler(event);
		},
	};
}

describe('RuntimeConnector contract', () => {
	it('is satisfied by connector implementations', () => {
		const connector = createLocalConnectorMock();
		assertConnectorContract(connector);
	});

	it('supports event and decision subscriptions with unsubscription', () => {
		const connector = createLocalConnectorMock();
		const eventHandler = vi.fn();
		const decisionHandler = vi.fn();
		const offEvent = connector.onEvent(eventHandler);
		const offDecision = connector.onDecision(decisionHandler);

		connector.start();
		connector.emit({
			id: 'evt-1',
			timestamp: Date.now(),
			hookName: 'Notification',
			sessionId: 'sess-1',
			context: {
				cwd: '/project',
				transcriptPath: '/tmp/transcript',
			},
			interaction: {
				expectsDecision: false,
			},
			payload: {},
		});
		const decision: RuntimeDecision = {
			type: 'passthrough',
			source: 'user',
		};
		connector.sendDecision('evt-1', decision);

		expect(eventHandler).toHaveBeenCalledTimes(1);
		expect(decisionHandler).toHaveBeenCalledTimes(1);

		offEvent();
		offDecision();

		connector.emit({
			id: 'evt-2',
			timestamp: Date.now(),
			hookName: 'Notification',
			sessionId: 'sess-1',
			context: {
				cwd: '/project',
				transcriptPath: '/tmp/transcript',
			},
			interaction: {
				expectsDecision: false,
			},
			payload: {},
		});
		connector.sendDecision('evt-2', decision);

		expect(eventHandler).toHaveBeenCalledTimes(1);
		expect(decisionHandler).toHaveBeenCalledTimes(1);

		connector.stop();
		expect(connector.getStatus()).toBe('stopped');
	});
});
