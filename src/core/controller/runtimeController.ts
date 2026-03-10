/**
 * Hook controller — UI-decision logic for runtime events.
 *
 * Receives RuntimeEvents and returns ControllerResults with semantic
 * RuntimeDecisions. No transport/protocol imports.
 *
 * Evolves from eventHandlers.ts but operates on RuntimeEvent instead of
 * HandlerContext, and returns decisions instead of calling respond().
 */

import type {RuntimeEvent, RuntimeDecision} from '../runtime/types';
import {type HookRule, matchRule} from './rules';

export type ControllerCallbacks = {
	getRules: () => HookRule[];
	enqueuePermission: (event: RuntimeEvent) => void;
	enqueueQuestion: (eventId: string) => void;
	signal?: AbortSignal;
};

export type ControllerResult =
	| {handled: true; decision?: RuntimeDecision}
	| {handled: false};

export function handleEvent(
	event: RuntimeEvent,
	cb: ControllerCallbacks,
): ControllerResult {
	const eventKind = event.kind;
	const eventData = event.data as Record<string, unknown>;
	const toolName =
		event.toolName ??
		(typeof eventData['tool_name'] === 'string'
			? eventData['tool_name']
			: undefined);

	if (eventKind === 'permission.request' && toolName === 'user_input') {
		cb.enqueueQuestion(event.id);
		return {handled: true};
	}

	// ── PermissionRequest: check rules, enqueue if no match ──
	if (eventKind === 'permission.request' && toolName) {
		const rule = matchRule(cb.getRules(), toolName);

		if (rule?.action === 'deny') {
			return {
				handled: true,
				decision: {
					type: 'json',
					source: 'rule',
					intent: {
						kind: 'permission_deny',
						reason: `Blocked by rule: ${rule.addedBy}`,
					},
				},
			};
		}

		if (rule?.action === 'approve') {
			return {
				handled: true,
				decision: {
					type: 'json',
					source: 'rule',
					intent: {kind: 'permission_allow'},
				},
			};
		}

		cb.enqueuePermission(event);
		return {handled: true};
	}

	// ── AskUserQuestion hijack ──
	if (eventKind === 'tool.pre' && toolName === 'AskUserQuestion') {
		cb.enqueueQuestion(event.id);
		return {handled: true};
	}

	// ── PreToolUse: deny-listed tools get blocked, everything else auto-allowed ──
	// In headless mode (claude -p) with --setting-sources "", a passthrough
	// leaves Claude with no permission config, so tools silently fail.
	// We must explicitly allow all non-denied tools.
	if (eventKind === 'tool.pre' && toolName) {
		const rule = matchRule(cb.getRules(), toolName);

		if (rule?.action === 'deny') {
			return {
				handled: true,
				decision: {
					type: 'json',
					source: 'rule',
					intent: {
						kind: 'pre_tool_deny',
						reason: `Blocked by rule: ${rule.addedBy}`,
					},
				},
			};
		}

		return {
			handled: true,
			decision: {
				type: 'json',
				source: 'rule',
				intent: {kind: 'pre_tool_allow'},
			},
		};
	}

	// Default: not handled — adapter timeout will auto-passthrough
	return {handled: false};
}
