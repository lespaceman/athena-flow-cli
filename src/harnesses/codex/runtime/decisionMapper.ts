import type {RuntimeEvent, RuntimeDecision} from '../../../core/runtime/types';
import type {CodexApprovalDecision} from '../protocol/items';
import type {CodexToolRequestUserInputResponse} from '../protocol';
import * as M from '../protocol/methods';

/**
 * Maps a RuntimeDecision to a Codex JSON-RPC approval response result object.
 * Returns the `result` field to send in the JSON-RPC response.
 */
export function mapDecisionToCodexResult(
	event: RuntimeEvent,
	decision: RuntimeDecision,
): {decision: CodexApprovalDecision} | CodexToolRequestUserInputResponse {
	if (event.hookName === M.TOOL_REQUEST_USER_INPUT) {
		if (decision.intent?.kind !== 'question_answer') {
			return {answers: {}};
		}

		return {
			answers: Object.fromEntries(
				Object.entries(decision.intent.answers).map(([id, answer]) => [
					id,
					{answers: [answer]},
				]),
			),
		};
	}

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
			return {answers: {}};

		case 'stop_block':
			return {decision: 'cancel'};

		default:
			return {decision: 'accept'};
	}
}
