/**
 * Injectable mock runtime — emit events programmatically.
 * Useful for unit tests and component testing.
 */

import type {
	Runtime,
	RuntimeEvent,
	RuntimeDecision,
	RuntimeEventHandler,
	RuntimeDecisionHandler,
} from '../../../core/runtime/types';
import {fillDefaults} from './helpers';

type DecisionRecord = {eventId: string; decision: RuntimeDecision};

export type InjectableMockRuntime = Runtime & {
	emit: (partial: Partial<RuntimeEvent>) => void;
	getLastEventId: () => string;
	getDecisions: () => DecisionRecord[];
	getDecision: (eventId: string) => RuntimeDecision | undefined;
};

export function createInjectableMockRuntime(): InjectableMockRuntime {
	const handlers = new Set<RuntimeEventHandler>();
	const decisionHandlers = new Set<RuntimeDecisionHandler>();
	const decisions: DecisionRecord[] = [];
	let status: 'stopped' | 'running' = 'stopped';
	let lastEventId = '';

	function emitEvent(event: RuntimeEvent): void {
		lastEventId = event.id;
		for (const handler of handlers) {
			try {
				handler(event);
			} catch {
				// ignore
			}
		}
	}

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
			handlers.add(handler);
			return () => handlers.delete(handler);
		},

		onDecision(handler: RuntimeDecisionHandler) {
			decisionHandlers.add(handler);
			return () => decisionHandlers.delete(handler);
		},

		sendDecision(eventId: string, decision: RuntimeDecision) {
			decisions.push({eventId, decision});
			for (const handler of decisionHandlers) {
				try {
					handler(eventId, decision);
				} catch {
					// ignore
				}
			}
		},

		emit(partial: Partial<RuntimeEvent>) {
			emitEvent(fillDefaults(partial));
		},

		getLastEventId() {
			return lastEventId;
		},

		getDecisions() {
			return decisions;
		},

		getDecision(eventId: string) {
			return decisions.find(d => d.eventId === eventId)?.decision;
		},
	};
}
