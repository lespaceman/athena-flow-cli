/**
 * Pure relay-callback factories — convert a runtime event into a
 * `SessionBridge.relayPermission` / `relayQuestion` round-trip and feed
 * the result back into `runtime.sendDecision`. Shared by the interactive
 * RuntimeProvider and the exec runner so both modes use the same wiring.
 *
 * No React/Ink imports.
 */

import type {SessionBridge} from './sessionBridge';
import type {RelayQuestion} from '../../shared/gateway-protocol';
import type {
	Runtime,
	RuntimeDecision,
	RuntimeEvent,
} from '../../core/runtime/types';
import {writeGatewayTrace} from '../../infra/gatewayTrace';

export function createRelayPermissionCallback(
	bridge: SessionBridge,
	runtime: Runtime,
): (event: RuntimeEvent) => void {
	return (event: RuntimeEvent) => {
		const toolName = resolveToolName(event);
		writeGatewayTrace(
			`relayAdapter relayPermission event=${event.id} tool=${toolName}`,
		);
		void bridge
			.relayPermission({
				toolName,
				description: event.display?.title ?? `${toolName} request`,
				inputPreview: previewToolInput(event),
				...(event.interaction.defaultTimeoutMs !== undefined
					? {ttlMs: event.interaction.defaultTimeoutMs}
					: {}),
			})
			.then(res => {
				const decision = permissionRelayDecision(res.result);
				if (!decision) return;
				runtime.sendDecision(event.id, decision);
			})
			.catch(err => {
				if (process.env['ATHENA_GATEWAY_TRACE'] === '1') {
					console.error(
						`[athena] gateway relayPermission failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			});
	};
}

export function createRelayQuestionCallback(
	bridge: SessionBridge,
	runtime: Runtime,
): (event: RuntimeEvent) => void {
	return (event: RuntimeEvent) => {
		const questions = extractRelayQuestions(event);
		const title = event.display?.title ?? 'Question';
		writeGatewayTrace(
			`relayAdapter relayQuestion event=${event.id} count=${questions.length}`,
		);
		void bridge
			.relayQuestion({
				title,
				questions,
				...(event.interaction.defaultTimeoutMs !== undefined
					? {ttlMs: event.interaction.defaultTimeoutMs}
					: {}),
			})
			.then(res => {
				const decision = questionRelayDecision(res.result);
				if (!decision) return;
				runtime.sendDecision(event.id, decision);
			})
			.catch(err => {
				if (process.env['ATHENA_GATEWAY_TRACE'] === '1') {
					console.error(
						`[athena] gateway relayQuestion failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			});
	};
}

function resolveToolName(event: RuntimeEvent): string {
	const data = event.data as Record<string, unknown>;
	return (
		event.toolName ??
		(typeof data['tool_name'] === 'string' ? data['tool_name'] : undefined) ??
		'Tool'
	);
}

function previewToolInput(event: RuntimeEvent): string {
	const data = event.data as Record<string, unknown>;
	const input = data['tool_input'] ?? event.payload;
	if (typeof input === 'string') return input.slice(0, 4_000);
	try {
		return JSON.stringify(input, null, 2).slice(0, 4_000);
	} catch {
		return String(input).slice(0, 4_000);
	}
}

function permissionRelayDecision(
	result: Awaited<ReturnType<SessionBridge['relayPermission']>>['result'],
): RuntimeDecision | null {
	if (result.kind !== 'verdict') return null;
	if (result.behavior === 'allow') {
		return {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		};
	}
	return {
		type: 'json',
		source: 'user',
		intent: {
			kind: 'permission_deny',
			reason: `Denied by ${result.channelId}`,
		},
	};
}

function questionRelayDecision(
	result: Awaited<ReturnType<SessionBridge['relayQuestion']>>['result'],
): RuntimeDecision | null {
	if (result.kind !== 'answer') return null;
	return {
		type: 'json',
		source: 'user',
		intent: {kind: 'question_answer', answers: result.answers},
	};
}

function extractRelayQuestions(event: RuntimeEvent): RelayQuestion[] {
	const data = event.data as Record<string, unknown>;
	const toolInput = data['tool_input'];
	if (typeof toolInput !== 'object' || toolInput === null) return [];
	const raw = (toolInput as Record<string, unknown>)['questions'];
	if (!Array.isArray(raw)) return [];

	const result: RelayQuestion[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
			continue;
		const q = entry as Record<string, unknown>;
		const question =
			typeof q['question'] === 'string' ? q['question'] : 'Question';
		const header = typeof q['header'] === 'string' ? q['header'] : 'Question';
		const multiSelect =
			typeof q['multiSelect'] === 'boolean' ? q['multiSelect'] : false;
		const options = Array.isArray(q['options'])
			? q['options'].flatMap(rawOption => {
					if (
						typeof rawOption !== 'object' ||
						rawOption === null ||
						Array.isArray(rawOption)
					) {
						return [];
					}
					const option = rawOption as Record<string, unknown>;
					return [
						{
							label: typeof option['label'] === 'string' ? option['label'] : '',
							description:
								typeof option['description'] === 'string'
									? option['description']
									: '',
						},
					];
				})
			: [];
		result.push({
			key: question,
			header,
			question,
			multi_select: multiSelect,
			options,
		});
	}
	return result;
}
