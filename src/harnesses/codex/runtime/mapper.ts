import type {RuntimeEvent} from '../../../core/runtime/types';
import type {
	JsonRpcNotification,
	JsonRpcServerRequest,
} from '../protocol/jsonrpc';
import {translateNotification, translateServerRequest} from './eventTranslator';
import {getCodexInteractionHints} from './interactionRules';
import {generateId} from '../../../shared/utils/id';

export function mapNotificationToRuntimeEvent(
	msg: JsonRpcNotification,
	sessionId: string,
	cwd: string,
): RuntimeEvent {
	const translated = translateNotification(msg);
	return {
		id: `codex-ntf-${generateId()}`,
		timestamp: Date.now(),
		kind: translated.kind,
		data: translated.data,
		hookName: msg.method,
		sessionId,
		toolName: translated.toolName,
		toolUseId: translated.toolUseId,
		context: {cwd, transcriptPath: ''},
		interaction: getCodexInteractionHints(translated.expectsDecision),
		payload: msg.params,
	};
}

export function mapServerRequestToRuntimeEvent(
	msg: JsonRpcServerRequest,
	sessionId: string,
	cwd: string,
): RuntimeEvent {
	const translated = translateServerRequest(msg);
	return {
		id: `codex-req-${msg.id}`,
		timestamp: Date.now(),
		kind: translated.kind,
		data: translated.data,
		hookName: msg.method,
		sessionId,
		toolName: translated.toolName,
		toolUseId: translated.toolUseId,
		context: {cwd, transcriptPath: ''},
		interaction: getCodexInteractionHints(translated.expectsDecision),
		payload: msg.params,
	};
}
