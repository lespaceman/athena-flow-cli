/**
 * Maps RuntimeDecision (UI semantic) → HookResultPayload (Claude wire protocol).
 *
 * This is the ONLY place that constructs Claude-specific JSON stdout shapes.
 * The controller expresses intent; this module translates to protocol.
 */

import type {HookResultPayload} from '../protocol/result';
import type {RuntimeEvent, RuntimeDecision} from '../../../core/runtime/types';

export function mapDecisionToResult(
	_event: RuntimeEvent,
	decision: RuntimeDecision,
): HookResultPayload {
	if (decision.type === 'passthrough') {
		return {action: 'passthrough'};
	}

	if (decision.type === 'block') {
		return {
			action: 'block_with_stderr',
			stderr: decision.reason ?? 'Blocked',
		};
	}

	// decision.type === 'json'
	if (!decision.intent) {
		// No intent but type is json — pass through raw data if available
		return {
			action: 'json_output',
			stdout_json: decision.data as Record<string, unknown>,
		};
	}

	const {intent} = decision;

	switch (intent.kind) {
		case 'permission_allow':
			return {
				action: 'json_output',
				stdout_json: {
					hookSpecificOutput: {
						hookEventName: 'PermissionRequest',
						decision: {behavior: 'allow'},
					},
				},
			};

		case 'permission_deny':
			return {
				action: 'json_output',
				stdout_json: {
					hookSpecificOutput: {
						hookEventName: 'PermissionRequest',
						decision: {behavior: 'deny', reason: intent.reason},
					},
				},
			};

		case 'question_answer': {
			const formatted = Object.entries(intent.answers)
				.map(([q, a]) => `Q: ${q}\nA: ${a}`)
				.join('\n');
			return {
				action: 'json_output',
				stdout_json: {
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						permissionDecision: 'allow',
						updatedInput: {answers: intent.answers},
						additionalContext: `User answered via athena-cli:\n${formatted}`,
					},
				},
			};
		}

		case 'pre_tool_allow':
			return {
				action: 'json_output',
				stdout_json: {
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						permissionDecision: 'allow',
					},
				},
			};

		case 'pre_tool_deny':
			return {
				action: 'json_output',
				stdout_json: {
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						permissionDecision: 'deny',
						permissionDecisionReason: intent.reason,
					},
				},
			};

		case 'stop_block':
			return {
				action: 'json_output',
				stdout_json: {
					decision: 'block',
					reason: intent.reason,
				},
			};

		default:
			// Exhaustive check — if new intents are added, TypeScript will catch it
			return {action: 'passthrough'};
	}
}
