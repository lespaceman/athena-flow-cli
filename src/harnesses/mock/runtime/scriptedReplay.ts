/**
 * Scripted mock runtime — emits pre-defined events on a timer.
 * Useful for demos, visual testing, and replaying recorded sessions.
 */

import type {
	Runtime,
	RuntimeEvent,
	RuntimeDecision,
	RuntimeEventHandler,
	RuntimeDecisionHandler,
} from '../../../core/runtime/types';
import {fillDefaults} from './helpers';

type ScriptedEvent = {
	delayMs: number;
	event: Partial<RuntimeEvent>;
};

type DecisionRecord = {eventId: string; decision: RuntimeDecision};

export function createMockRuntime(script: ScriptedEvent[]): Runtime & {
	_getLastEventId: () => string;
	_getDecisions: () => DecisionRecord[];
} {
	const handlers = new Set<RuntimeEventHandler>();
	const decisionHandlers = new Set<RuntimeDecisionHandler>();
	const timers: ReturnType<typeof setTimeout>[] = [];
	const decisions: DecisionRecord[] = [];
	let status: 'stopped' | 'running' = 'stopped';
	let lastEventId = '';

	function emit(event: RuntimeEvent): void {
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
			let accumulated = 0;
			for (const entry of script) {
				accumulated += entry.delayMs;
				const timer = setTimeout(() => {
					if (status === 'running') {
						emit(fillDefaults(entry.event));
					}
				}, accumulated);
				timers.push(timer);
			}
			return Promise.resolve();
		},

		stop() {
			status = 'stopped';
			for (const t of timers) clearTimeout(t);
			timers.length = 0;
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

		_getLastEventId() {
			return lastEventId;
		},

		_getDecisions() {
			return decisions;
		},
	};
}
