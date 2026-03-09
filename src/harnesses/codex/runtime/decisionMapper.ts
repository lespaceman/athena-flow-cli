import type {RuntimeEvent, RuntimeDecision} from '../../../core/runtime/types';
import type {CodexApprovalDecision} from '../protocol/items';

/**
 * Maps a RuntimeDecision to a Codex JSON-RPC approval response result object.
 * Returns the `result` field to send in the JSON-RPC response.
 */
export function mapDecisionToCodexResult(
	_event: RuntimeEvent,
	decision: RuntimeDecision,
): {decision: CodexApprovalDecision} | Record<string, unknown> {
	if (decision.type === 'passthrough') {
		return {decision: 'accept'};
	}

	if (decision.type === 'block') {
		return {decision: 'decline'};
	}

	// decision.type === 'json'
	if (!decision.intent) {
		return {decision: 'accept'};
	}

	switch (decision.intent.kind) {
		case 'permission_allow':
		case 'pre_tool_allow':
			return {decision: 'accept'};

		case 'permission_deny':
		case 'pre_tool_deny':
			return {decision: 'decline'};

		case 'question_answer':
			return {answers: decision.intent.answers};

		case 'stop_block':
			return {decision: 'cancel'};

		default:
			return {decision: 'accept'};
	}
}

/**
 * Extract the Codex server-request ID from a RuntimeEvent ID.
 * Codex events use "codex-req-{id}" format for server requests.
 */
export function extractCodexRequestId(eventId: string): number | null {
	const match = eventId.match(/^codex-req-(\d+)$/);
	return match ? parseInt(match[1]!, 10) : null;
}
