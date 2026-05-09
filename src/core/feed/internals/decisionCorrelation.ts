// src/core/feed/internals/decisionCorrelation.ts

import type {FeedEventKind} from '../types';

/**
 * Tracks request_id → originating FeedEvent so that a later RuntimeDecision
 * (permission grant, stop block, server_request.resolved notification) can be
 * correlated back to the event that requested it.
 *
 * Two index views:
 *   - primary indexes (consumed by mapDecision): cleared on consume + on new run
 *   - resolved view (read by server_request.resolved notifications): persists
 *     past consume; cleared only on new run
 *
 * Indexes are NOT rebuilt from stored session data on restore. A fresh run
 * (SessionStart or UserPromptSubmit) clears all indexes; old adapter session
 * request IDs won't recur in the new adapter session, so the brief window
 * between restore and first new event has empty indexes — benign.
 */
export type DecisionCorrelation = {
	recordRequest(requestId: string, eventId: string, kind: FeedEventKind): void;
	lookupResolved(
		requestId: string,
	): {event_id: string; kind: FeedEventKind} | null;
	consumeForDecision(requestId: string): {
		parentEventId: string;
		originalKind: string | undefined;
	} | null;
	resetForNewRun(): void;
};

export function createDecisionCorrelation(): DecisionCorrelation {
	const eventIdByRequestId = new Map<string, string>();
	const eventKindByRequestId = new Map<string, string>();
	const resolvedRequestById = new Map<
		string,
		{event_id: string; kind: FeedEventKind}
	>();

	return {
		recordRequest(requestId, eventId, kind) {
			eventIdByRequestId.set(requestId, eventId);
			eventKindByRequestId.set(requestId, kind);
			resolvedRequestById.set(requestId, {event_id: eventId, kind});
		},
		lookupResolved(requestId) {
			return resolvedRequestById.get(requestId) ?? null;
		},
		consumeForDecision(requestId) {
			const parentEventId = eventIdByRequestId.get(requestId);
			if (!parentEventId) return null;
			const originalKind = eventKindByRequestId.get(requestId);
			eventIdByRequestId.delete(requestId);
			eventKindByRequestId.delete(requestId);
			return {parentEventId, originalKind};
		},
		resetForNewRun() {
			eventIdByRequestId.clear();
			eventKindByRequestId.clear();
			resolvedRequestById.clear();
		},
	};
}
