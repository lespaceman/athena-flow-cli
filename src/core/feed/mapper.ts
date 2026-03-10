// src/feed/mapper.ts

import type {RuntimeEvent, RuntimeDecision} from '../runtime/types';
import type {
	FeedEvent,
	FeedEventKind,
	FeedEventLevel,
	FeedEventCause,
} from './types';
import type {Session, Run, Actor} from './entities';
import type {MapperBootstrap} from './bootstrap';
import {ActorRegistry} from './entities';
import {generateTitle} from './titleGen';
import {createTranscriptReader} from './transcript';

export type FeedMapper = {
	mapEvent(event: RuntimeEvent): FeedEvent[];
	mapDecision(eventId: string, decision: RuntimeDecision): FeedEvent | null;
	getSession(): Session | null;
	getCurrentRun(): Run | null;
	getActors(): Actor[];
	allocateSeq(): number;
};

export function createFeedMapper(bootstrap?: MapperBootstrap): FeedMapper {
	const MAX_STREAMED_TOOL_OUTPUT_CHARS = 64_000;
	const STREAMED_TOOL_OUTPUT_TRUNCATED_NOTICE =
		'[streaming output truncated to recent content]\n';
	let currentSession: Session | null = null;
	let currentRun: Run | null = null;
	const actors = new ActorRegistry();
	let seq = 0;
	let runSeq = 0;

	// Correlation indexes — keyed on undocumented request_id (best-effort).
	// mapDecision() returns null when requestId is missing from the index.
	//
	// NOTE: These indexes are NOT rebuilt from stored session data on restore.
	// This is intentional: a new run (triggered by SessionStart or UserPromptSubmit)
	// clears all indexes via ensureRunArray(), and old adapter session request IDs
	// won't recur in the new adapter session. The brief window between restore and
	// first new event has empty indexes, which is benign — no decisions can arrive
	// for events from the old adapter session.
	const toolPreIndex = new Map<string, string>(); // tool_use_id → feed event_id
	const toolDeltaTextByUseId = new Map<string, string>(); // tool_use_id → cumulative streamed output
	const truncatedToolDeltaUseIds = new Set<string>();
	const eventIdByRequestId = new Map<string, string>(); // runtime id → feed event_id
	const eventKindByRequestId = new Map<string, string>(); // runtime id → feed kind

	// Bootstrap from stored session
	if (bootstrap) {
		// Restore seq counter from stored events
		for (const e of bootstrap.feedEvents) {
			if (e.seq > seq) seq = e.seq;
		}

		// Restore session identity from last adapter session
		const lastAdapterId = bootstrap.adapterSessionIds.at(-1);
		if (lastAdapterId) {
			currentSession = {
				session_id: lastAdapterId,
				started_at: bootstrap.createdAt,
				source: 'resume',
			};
		}

		// Restore runSeq from highest run number in stored events
		for (const e of bootstrap.feedEvents) {
			const m = e.run_id.match(/:R(\d+)$/);
			if (m) {
				const n = parseInt(m[1]!, 10);
				if (n > runSeq) runSeq = n;
			}
		}

		// Rebuild currentRun from last open run
		let lastRunStart: FeedEvent | undefined;
		let lastRunEnd: FeedEvent | undefined;
		for (const e of bootstrap.feedEvents) {
			if (e.kind === 'run.start') lastRunStart = e;
			if (e.kind === 'run.end') lastRunEnd = e;
		}
		if (lastRunStart && (!lastRunEnd || lastRunEnd.seq < lastRunStart.seq)) {
			const triggerData = lastRunStart.data as {
				trigger: {type: string; prompt_preview?: string};
			};
			currentRun = {
				run_id: lastRunStart.run_id,
				session_id: lastRunStart.session_id,
				started_at: lastRunStart.ts,
				trigger: triggerData.trigger as Run['trigger'],
				status: 'running',
				actors: {root_agent_id: 'agent:root', subagent_ids: []},
				counters: {
					tool_uses: 0,
					tool_failures: 0,
					permission_requests: 0,
					blocks: 0,
				},
			};
			// Rebuild counters from events in this run
			for (const e of bootstrap.feedEvents) {
				if (e.run_id !== currentRun.run_id) continue;
				if (e.kind === 'tool.pre') currentRun.counters.tool_uses++;
				if (e.kind === 'tool.failure') currentRun.counters.tool_failures++;
				if (e.kind === 'permission.request')
					currentRun.counters.permission_requests++;
			}
		}
	}

	function nextSeq(): number {
		return ++seq;
	}

	function appendToolDelta(
		toolUseId: string | undefined,
		chunk: string,
	): string {
		if (!toolUseId) {
			return chunk;
		}

		const cumulative = `${toolDeltaTextByUseId.get(toolUseId) ?? ''}${chunk}`;
		if (cumulative.length <= MAX_STREAMED_TOOL_OUTPUT_CHARS) {
			toolDeltaTextByUseId.set(toolUseId, cumulative);
			return truncatedToolDeltaUseIds.has(toolUseId)
				? `${STREAMED_TOOL_OUTPUT_TRUNCATED_NOTICE}${cumulative}`
				: cumulative;
		}

		const tail = cumulative.slice(-MAX_STREAMED_TOOL_OUTPUT_CHARS);
		toolDeltaTextByUseId.set(toolUseId, tail);
		truncatedToolDeltaUseIds.add(toolUseId);
		return `${STREAMED_TOOL_OUTPUT_TRUNCATED_NOTICE}${tail}`;
	}

	function getRunId(): string {
		const sessId = currentSession?.session_id ?? 'unknown';
		return `${sessId}:R${runSeq}`;
	}

	function makeEvent(
		kind: FeedEventKind,
		level: FeedEventLevel,
		actorId: string,
		data: unknown,
		runtimeEvent: RuntimeEvent,
		cause?: Partial<FeedEventCause>,
	): FeedEvent {
		const s = nextSeq();
		const eventId = `${getRunId()}:E${s}`;

		const baseCause: FeedEventCause = {
			hook_request_id: runtimeEvent.id,
			transcript_path: runtimeEvent.context.transcriptPath,
			...cause,
		};

		const fe = {
			event_id: eventId,
			seq: s,
			ts: runtimeEvent.timestamp,
			session_id: runtimeEvent.sessionId,
			run_id: getRunId(),
			kind,
			level,
			actor_id: actorId,
			cause: baseCause,
			title: '',
			raw: runtimeEvent.payload,
			data,
		} as FeedEvent;

		fe.title = generateTitle(fe);

		// Index for decision correlation
		eventIdByRequestId.set(runtimeEvent.id, eventId);
		eventKindByRequestId.set(runtimeEvent.id, kind);

		return fe;
	}

	function closeRun(
		runtimeEvent: RuntimeEvent,
		status: 'completed' | 'failed' | 'aborted',
	): FeedEvent | null {
		if (!currentRun) return null;
		currentRun.status = status;
		currentRun.ended_at = runtimeEvent.timestamp;
		const evt = makeEvent(
			'run.end',
			'info',
			'system',
			{status, counters: {...currentRun.counters}},
			runtimeEvent,
		);
		currentRun = null;
		return evt;
	}

	function ensureRunArray(
		runtimeEvent: RuntimeEvent,
		triggerType:
			| 'user_prompt_submit'
			| 'resume'
			| 'clear'
			| 'compact'
			| 'other' = 'other',
		promptPreview?: string,
	): FeedEvent[] {
		if (currentRun && triggerType === 'other') return [];

		const results: FeedEvent[] = [];

		if (currentRun) {
			const closeEvt = closeRun(runtimeEvent, 'completed');
			if (closeEvt) results.push(closeEvt);
		}

		runSeq++;
		toolPreIndex.clear();
		toolDeltaTextByUseId.clear();
		truncatedToolDeltaUseIds.clear();
		eventIdByRequestId.clear();
		eventKindByRequestId.clear();
		activeSubagentStack.length = 0;
		currentRun = {
			run_id: getRunId(),
			session_id: runtimeEvent.sessionId,
			started_at: runtimeEvent.timestamp,
			trigger: {type: triggerType, prompt_preview: promptPreview},
			status: 'running',
			actors: {root_agent_id: 'agent:root', subagent_ids: []},
			counters: {
				tool_uses: 0,
				tool_failures: 0,
				permission_requests: 0,
				blocks: 0,
			},
		};

		results.push(
			makeEvent(
				'run.start',
				'info',
				'system',
				{trigger: {type: triggerType, prompt_preview: promptPreview}},
				runtimeEvent,
			),
		);

		return results;
	}

	const activeSubagentStack: string[] = []; // LIFO stack of active subagent actor IDs
	let lastTaskDescription: string | undefined;
	const subagentDescriptions = new Map<string, string>(); // agent_id → description
	const pendingMessages = new Map<
		string,
		{
			message: string;
			actorId: string;
			scope: 'root' | 'subagent';
		}
	>();
	const transcriptReader = createTranscriptReader();

	/**
	 * Read new assistant messages from the transcript and emit agent.message events.
	 * Called on every hook event that carries a transcript_path.
	 */
	function emitTranscriptMessages(
		transcriptPath: string,
		runtimeEvent: RuntimeEvent,
		actorId: string,
		scope: 'root' | 'subagent',
	): FeedEvent[] {
		const msgs = transcriptReader.readNewAssistantMessages(transcriptPath);
		return msgs.map(msg =>
			makeEvent(
				'agent.message',
				'info',
				actorId,
				{
					message: msg.text,
					source: 'transcript',
					scope,
				} satisfies import('./types').AgentMessageData,
				runtimeEvent,
			),
		);
	}

	function resolveToolActor(): string {
		return activeSubagentStack.length > 0
			? activeSubagentStack[activeSubagentStack.length - 1]!
			: 'agent:root';
	}

	function resolveToolUseId(
		event: RuntimeEvent,
		record: Record<string, unknown>,
	): string | undefined {
		return event.toolUseId ?? (record['tool_use_id'] as string | undefined);
	}

	function toolUseCause(
		toolUseId: string | undefined,
		parentId: string | undefined,
	): Partial<FeedEventCause> {
		return {
			...(toolUseId ? {tool_use_id: toolUseId} : {}),
			...(parentId ? {parent_event_id: parentId} : {}),
		};
	}

	function mapEvent(event: RuntimeEvent): FeedEvent[] {
		const d = event.data as Record<string, unknown>;
		const readString = (...values: unknown[]): string | undefined => {
			for (const value of values) {
				if (typeof value === 'string') return value;
			}
			return undefined;
		};
		const readBoolean = (...values: unknown[]): boolean | undefined => {
			for (const value of values) {
				if (typeof value === 'boolean') return value;
			}
			return undefined;
		};
		const readObject = (...values: unknown[]): Record<string, unknown> => {
			for (const value of values) {
				if (typeof value === 'object' && value !== null) {
					return value as Record<string, unknown>;
				}
			}
			return {};
		};
		const readSuggestionArray = (
			...values: unknown[]
		): Array<{type: string; tool: string}> | undefined => {
			for (const value of values) {
				if (Array.isArray(value)) {
					return value as Array<{type: string; tool: string}>;
				}
			}
			return undefined;
		};
		const eventKind = event.kind;
		const results: FeedEvent[] = [];
		const resolveMessageScope = (): {
			actorId: string;
			scope: 'root' | 'subagent';
		} => {
			const actorId = resolveToolActor();
			return {
				actorId,
				scope: activeSubagentStack.length > 0 ? 'subagent' : 'root',
			};
		};
		const appendPendingMessageDelta = (
			itemId: string | undefined,
			delta: string,
		): void => {
			if (!delta) return;
			const key = itemId ?? '__legacy_root__';
			const existing = pendingMessages.get(key);
			if (existing) {
				existing.message += delta;
				return;
			}
			const scope = resolveMessageScope();
			pendingMessages.set(key, {
				message: delta,
				actorId: scope.actorId,
				scope: scope.scope,
			});
		};
		const emitCompletedMessage = (
			itemId: string | undefined,
			messageText: string | undefined,
		): void => {
			const key = itemId ?? '__legacy_root__';
			const pending = pendingMessages.get(key);
			const message = messageText ?? pending?.message ?? '';
			if (!message) return;
			const scope = pending ?? resolveMessageScope();
			results.push(
				makeEvent(
					'agent.message',
					'info',
					scope.actorId,
					{
						message,
						source: 'hook',
						scope: scope.scope,
					} satisfies import('./types').AgentMessageData,
					event,
				),
			);
			pendingMessages.delete(key);
		};
		const flushPendingMessages = (): void => {
			for (const [itemId, pending] of pendingMessages) {
				if (!pending.message) continue;
				results.push(
					makeEvent(
						'agent.message',
						'info',
						pending.actorId,
						{
							message: pending.message,
							source: 'hook',
							scope: pending.scope,
						} satisfies import('./types').AgentMessageData,
						event,
					),
				);
				pendingMessages.delete(itemId);
			}
		};

		// Fallback: emit agent.message from last_assistant_message when transcript yields nothing
		function emitFallbackMessage(
			parentKind: FeedEventKind,
			actorId: string,
			scope: 'root' | 'subagent',
		): void {
			if (results.some(r => r.kind === 'agent.message')) return;
			const msg = readString(d['last_assistant_message']);
			if (!msg) return;
			const parentEvt = results.find(r => r.kind === parentKind);
			results.push(
				makeEvent(
					'agent.message',
					'info',
					actorId,
					{
						message: msg,
						source: 'hook',
						scope,
					} satisfies import('./types').AgentMessageData,
					event,
					parentEvt ? {parent_event_id: parentEvt.event_id} : undefined,
				),
			);
		}

		// Extract new assistant messages from transcript BEFORE processing the
		// hook event so that agent.message gets a lower seq than tool.pre etc.
		// Skip stop events — they use last_assistant_message to avoid flush-timing dupes.
		const transcriptPath = event.context.transcriptPath;
		const isStopEvent =
			eventKind === 'stop.request' || eventKind === 'subagent.stop';
		if (transcriptPath && !isStopEvent) {
			const transcriptMsgs = emitTranscriptMessages(
				transcriptPath,
				event,
				resolveToolActor(),
				activeSubagentStack.length > 0 ? 'subagent' : 'root',
			);
			results.push(...transcriptMsgs);
		}

		switch (eventKind) {
			case 'session.start': {
				pendingMessages.clear();
				const source = readString(d['source']) ?? 'startup';
				currentSession = {
					session_id: event.sessionId,
					started_at: event.timestamp,
					source,
					model: readString(d['model']),
					agent_type: readString(d['agent_type']),
				};
				if (source === 'resume' || source === 'clear' || source === 'compact') {
					results.push(
						...ensureRunArray(event, source as 'resume' | 'clear' | 'compact'),
					);
				}
				results.push(
					makeEvent(
						'session.start',
						'info',
						'system',
						{
							source,
							model: readString(d['model']),
							agent_type: readString(d['agent_type']),
						} satisfies import('./types').SessionStartData,
						event,
					),
				);
				break;
			}

			case 'session.end': {
				pendingMessages.clear();
				if (currentRun) {
					const closeEvt = closeRun(event, 'completed');
					if (closeEvt) results.push(closeEvt);
				}
				results.push(
					makeEvent(
						'session.end',
						'info',
						'system',
						{
							reason: readString(d['reason']) ?? 'unknown',
						} satisfies import('./types').SessionEndData,
						event,
					),
				);
				if (currentSession) {
					currentSession.ended_at = event.timestamp;
				}
				break;
			}

			case 'user.prompt': {
				const prompt = readString(d['prompt']) ?? '';
				results.push(
					...ensureRunArray(event, 'user_prompt_submit', prompt.slice(0, 80)),
				);
				results.push(
					makeEvent(
						'user.prompt',
						'info',
						'user',
						{
							prompt,
							cwd: event.context.cwd,
							permission_mode:
								event.context.permissionMode ??
								readString(d['permission_mode']),
						} satisfies import('./types').UserPromptData,
						event,
					),
				);
				break;
			}

			case 'turn.start': {
				pendingMessages.clear();
				const prompt = readString(d['prompt']);
				results.push(
					...ensureRunArray(
						event,
						prompt ? 'user_prompt_submit' : 'other',
						prompt?.slice(0, 80),
					),
				);
				if (prompt) {
					results.push(
						makeEvent(
							'user.prompt',
							'info',
							'user',
							{
								prompt,
								cwd: event.context.cwd,
								permission_mode: event.context.permissionMode,
							} satisfies import('./types').UserPromptData,
							event,
						),
					);
				}
				break;
			}

			case 'message.delta': {
				appendPendingMessageDelta(
					readString(d['item_id']),
					readString(d['delta']) ?? '',
				);
				break;
			}

			case 'message.complete': {
				results.push(...ensureRunArray(event));
				emitCompletedMessage(
					readString(d['item_id']),
					readString(d['message']),
				);
				break;
			}

			case 'turn.complete': {
				if (!currentRun) {
					pendingMessages.clear();
					break;
				}
				const stopEvt = makeEvent(
					'stop.request',
					'info',
					'agent:root',
					{
						stop_hook_active: false,
					} satisfies import('./types').StopRequestData,
					event,
				);
				results.push(stopEvt);
				const messageCountBeforeFlush = results.length;
				flushPendingMessages();
				if (results.length > messageCountBeforeFlush) {
					for (let i = messageCountBeforeFlush; i < results.length; i++) {
						results[i]!.cause = {
							...(results[i]!.cause ?? {}),
							parent_event_id: stopEvt.event_id,
						};
					}
				}
				const closeEvt = closeRun(event, 'completed');
				if (closeEvt) {
					results.push(closeEvt);
				}
				break;
			}

			case 'plan.delta':
			case 'reasoning.delta':
			case 'usage.update': {
				break;
			}

			case 'tool.delta': {
				results.push(...ensureRunArray(event));
				const toolUseId = resolveToolUseId(event, d);
				const toolName =
					event.toolName ?? readString(d['tool_name']) ?? 'Unknown';
				const parentId = toolUseId ? toolPreIndex.get(toolUseId) : undefined;
				const chunk = readString(d['delta']) ?? '';
				const cumulative = appendToolDelta(toolUseId, chunk);
				results.push(
					makeEvent(
						'tool.delta',
						'info',
						resolveToolActor(),
						{
							tool_name: toolName,
							tool_input: readObject(d['tool_input']),
							tool_use_id: toolUseId,
							delta: cumulative,
						} satisfies import('./types').ToolDeltaData,
						event,
						toolUseCause(toolUseId, parentId),
					),
				);
				break;
			}

			case 'tool.pre': {
				results.push(...ensureRunArray(event));
				if (currentRun) currentRun.counters.tool_uses++;
				const toolUseId = resolveToolUseId(event, d);
				const toolName =
					event.toolName ?? readString(d['tool_name']) ?? 'Unknown';
				const fe = makeEvent(
					'tool.pre',
					'info',
					resolveToolActor(),
					{
						tool_name: toolName,
						tool_input: readObject(d['tool_input']),
						tool_use_id: toolUseId,
					} satisfies import('./types').ToolPreData,
					event,
					toolUseId ? {tool_use_id: toolUseId} : undefined,
				);
				if (toolUseId) {
					toolPreIndex.set(toolUseId, fe.event_id);
				}
				results.push(fe);

				// Track Task description for subagent enrichment
				if (toolName === 'Task') {
					const input = readObject(d['tool_input']);
					lastTaskDescription =
						typeof input['description'] === 'string'
							? input['description']
							: undefined;
				}
				break;
			}

			case 'tool.post': {
				results.push(...ensureRunArray(event));
				const toolUseId = resolveToolUseId(event, d);
				if (toolUseId) {
					toolDeltaTextByUseId.delete(toolUseId);
					truncatedToolDeltaUseIds.delete(toolUseId);
				}
				const parentId = toolUseId ? toolPreIndex.get(toolUseId) : undefined;
				const toolName =
					event.toolName ?? readString(d['tool_name']) ?? 'Unknown';
				results.push(
					makeEvent(
						'tool.post',
						'info',
						resolveToolActor(),
						{
							tool_name: toolName,
							tool_input: readObject(d['tool_input']),
							tool_use_id: toolUseId,
							tool_response: d.tool_response,
						} satisfies import('./types').ToolPostData,
						event,
						toolUseCause(toolUseId, parentId),
					),
				);
				break;
			}

			case 'tool.failure': {
				results.push(...ensureRunArray(event));
				if (currentRun) currentRun.counters.tool_failures++;
				const toolUseId = resolveToolUseId(event, d);
				if (toolUseId) {
					toolDeltaTextByUseId.delete(toolUseId);
					truncatedToolDeltaUseIds.delete(toolUseId);
				}
				const parentId = toolUseId ? toolPreIndex.get(toolUseId) : undefined;
				const toolName =
					event.toolName ?? readString(d['tool_name']) ?? 'Unknown';
				results.push(
					makeEvent(
						'tool.failure',
						'error',
						resolveToolActor(),
						{
							tool_name: toolName,
							tool_input: readObject(d['tool_input']),
							tool_use_id: toolUseId,
							error: readString(d['error']) ?? 'Unknown error',
							is_interrupt: readBoolean(d['is_interrupt']),
						} satisfies import('./types').ToolFailureData,
						event,
						toolUseCause(toolUseId, parentId),
					),
				);
				break;
			}

			case 'permission.request': {
				results.push(...ensureRunArray(event));
				if (currentRun) currentRun.counters.permission_requests++;
				const toolName =
					event.toolName ?? readString(d['tool_name']) ?? 'Unknown';
				results.push(
					makeEvent(
						'permission.request',
						'info',
						'system',
						{
							tool_name: toolName,
							tool_input: readObject(d['tool_input']),
							tool_use_id: resolveToolUseId(event, d),
							permission_suggestions: readSuggestionArray(
								d['permission_suggestions'],
							),
						} satisfies import('./types').PermissionRequestData,
						event,
					),
				);
				break;
			}

			case 'stop.request': {
				results.push(...ensureRunArray(event));
				const stopEvt = makeEvent(
					'stop.request',
					'info',
					'agent:root',
					{
						stop_hook_active: readBoolean(d['stop_hook_active']) ?? false,
						last_assistant_message: readString(d['last_assistant_message']),
					} satisfies import('./types').StopRequestData,
					event,
				);
				results.push(stopEvt);
				break;
			}

			case 'subagent.start': {
				results.push(...ensureRunArray(event));
				const agentId = event.agentId ?? readString(d['agent_id']);
				const agentType = event.agentType ?? readString(d['agent_type']);
				if (agentId) {
					actors.ensureSubagent(agentId, agentType ?? 'unknown');
					if (currentRun) currentRun.actors.subagent_ids.push(agentId);
					activeSubagentStack.push(`subagent:${agentId}`);
				}
				results.push(
					makeEvent(
						'subagent.start',
						'info',
						'agent:root',
						{
							agent_id: agentId ?? '',
							agent_type: agentType ?? '',
							description: lastTaskDescription,
						} satisfies import('./types').SubagentStartData,
						event,
					),
				);
				if (agentId && lastTaskDescription) {
					subagentDescriptions.set(agentId, lastTaskDescription);
				}
				lastTaskDescription = undefined;
				break;
			}

			case 'subagent.stop': {
				results.push(...ensureRunArray(event));
				const agentId = event.agentId ?? readString(d['agent_id']);
				if (agentId) {
					const actorId = `subagent:${agentId}`;
					const idx = activeSubagentStack.lastIndexOf(actorId);
					if (idx !== -1) activeSubagentStack.splice(idx, 1);
				}
				const subStopActorId = `subagent:${agentId ?? 'unknown'}`;
				const subStopEvt = makeEvent(
					'subagent.stop',
					'info',
					subStopActorId,
					{
						agent_id: agentId ?? '',
						agent_type: event.agentType ?? readString(d['agent_type']) ?? '',
						stop_hook_active: readBoolean(d['stop_hook_active']) ?? false,
						agent_transcript_path: readString(d['agent_transcript_path']),
						last_assistant_message: readString(d['last_assistant_message']),
						description: subagentDescriptions.get(agentId ?? ''),
					} satisfies import('./types').SubagentStopData,
					event,
				);
				results.push(subStopEvt);
				break;
			}

			case 'notification': {
				results.push(...ensureRunArray(event));
				results.push(
					makeEvent(
						'notification',
						'info',
						'system',
						{
							message: readString(d['message']) ?? '',
							title: readString(d['title']),
							notification_type: readString(d['notification_type']),
						} satisfies import('./types').NotificationData,
						event,
					),
				);
				break;
			}

			case 'compact.pre': {
				results.push(...ensureRunArray(event));
				const compactEvt = makeEvent(
					'compact.pre',
					'info',
					'system',
					{
						trigger:
							(readString(d['trigger']) as 'manual' | 'auto' | undefined) ??
							'auto',
						custom_instructions: readString(d['custom_instructions']),
					} satisfies import('./types').PreCompactData,
					event,
				);
				compactEvt.ui = {collapsed_default: true};
				results.push(compactEvt);
				break;
			}

			case 'setup': {
				results.push(...ensureRunArray(event));
				const setupEvt = makeEvent(
					'setup',
					'info',
					'system',
					{
						trigger:
							(readString(d['trigger']) as
								| 'init'
								| 'maintenance'
								| undefined) ?? 'init',
					} satisfies import('./types').SetupData,
					event,
				);
				setupEvt.ui = {collapsed_default: true};
				results.push(setupEvt);
				break;
			}

			case 'teammate.idle': {
				results.push(...ensureRunArray(event));
				const idleEvt = makeEvent(
					'teammate.idle',
					'info',
					'system',
					{
						teammate_name: readString(d['teammate_name']) ?? '',
						team_name: readString(d['team_name']) ?? '',
					} satisfies import('./types').TeammateIdleData,
					event,
				);
				idleEvt.ui = {collapsed_default: true};
				results.push(idleEvt);
				break;
			}

			case 'task.completed': {
				results.push(...ensureRunArray(event));
				results.push(
					makeEvent(
						'task.completed',
						'info',
						'system',
						{
							task_id: readString(d['task_id']) ?? '',
							task_subject: readString(d['task_subject']) ?? '',
							task_description: readString(d['task_description']),
							teammate_name: readString(d['teammate_name']),
							team_name: readString(d['team_name']),
						} satisfies import('./types').TaskCompletedData,
						event,
					),
				);
				break;
			}

			case 'config.change': {
				results.push(...ensureRunArray(event));
				results.push(
					makeEvent(
						'config.change',
						'info',
						'system',
						{
							source: readString(d['source']) ?? 'unknown',
							file_path: readString(d['file_path']),
						} satisfies import('./types').ConfigChangeData,
						event,
					),
				);
				break;
			}

			case 'unknown': {
				results.push(...ensureRunArray(event));
				const unknownEvt = makeEvent(
					'unknown.hook',
					'debug',
					'system',
					{
						hook_event_name:
							readString(
								d['source_event_name'],
								d['hook_event_name'],
								event.hookName,
							) ?? 'unknown',
						payload: d.payload ?? null,
					} satisfies import('./types').UnknownHookData,
					event,
				);
				unknownEvt.ui = {collapsed_default: true};
				results.push(unknownEvt);
				break;
			}
		}

		// Stop events: use last_assistant_message directly (always available in payload).
		// Drain the transcript to advance the byte offset and prevent the next event
		// from re-emitting the same text.
		if (eventKind === 'stop.request') {
			if (transcriptPath) {
				transcriptReader.readNewAssistantMessages(transcriptPath);
			}
			emitFallbackMessage('stop.request', 'agent:root', 'root');
		}
		if (eventKind === 'subagent.stop') {
			const agentId = readString(d['agent_id']) ?? 'unknown';
			if (transcriptPath) {
				transcriptReader.readNewAssistantMessages(transcriptPath);
			}
			emitFallbackMessage('subagent.stop', `subagent:${agentId}`, 'subagent');
		}

		return results;
	}

	function mapDecision(
		requestId: string,
		decision: RuntimeDecision,
	): FeedEvent | null {
		const parentEventId = eventIdByRequestId.get(requestId);
		if (!parentEventId) return null;

		const originalKind = eventKindByRequestId.get(requestId);

		// Consume the correlation entry — prevents duplicate decisions for the same request
		eventIdByRequestId.delete(requestId);
		eventKindByRequestId.delete(requestId);

		function makeDecisionEvent(kind: FeedEventKind, data: unknown): FeedEvent {
			const s = nextSeq();
			const fe = {
				event_id: `${getRunId()}:E${s}`,
				seq: s,
				ts: Date.now(),
				session_id: currentSession?.session_id ?? 'unknown',
				run_id: getRunId(),
				kind,
				level: 'info' as const,
				actor_id: decision.source === 'user' ? 'user' : 'system',
				cause: {
					parent_event_id: parentEventId,
					hook_request_id: requestId,
				},
				title: '',
				data,
			} as FeedEvent;
			fe.title = generateTitle(fe);
			return fe;
		}

		if (originalKind === 'permission.request') {
			let data: import('./types').PermissionDecisionData;

			if (decision.source === 'timeout') {
				data = {decision_type: 'no_opinion', reason: 'timeout'};
			} else if (decision.type === 'passthrough') {
				data = {decision_type: 'no_opinion', reason: decision.source};
			} else if (decision.intent?.kind === 'permission_allow') {
				data = {decision_type: 'allow'};
			} else if (decision.intent?.kind === 'permission_deny') {
				data = {
					decision_type: 'deny',
					message: decision.intent.reason,
				};
			} else {
				data = {decision_type: 'no_opinion', reason: 'unknown'};
			}

			return makeDecisionEvent('permission.decision', data);
		}

		if (originalKind === 'stop.request') {
			let data: import('./types').StopDecisionData;
			const d = decision.data as Record<string, unknown> | undefined;
			const decisionReason =
				typeof d?.reason === 'string' ? d.reason : undefined;

			if (decision.source === 'timeout') {
				data = {decision_type: 'no_opinion', reason: 'timeout'};
			} else if (decision.type === 'passthrough') {
				data = {decision_type: 'no_opinion', reason: decision.source};
			} else if (d?.decision === 'block') {
				// Command hook schema: { decision: "block", reason: "..." }
				data = {
					decision_type: 'block',
					reason: decisionReason ?? decision.reason ?? 'Blocked',
				};
			} else if (d?.ok === false) {
				// Prompt/agent hook schema: { ok: false, reason: "..." }
				data = {
					decision_type: 'block',
					reason: decisionReason ?? 'Blocked by hook',
				};
			} else {
				// No blocking signal — treat as allow
				data = {decision_type: 'allow'};
			}

			return makeDecisionEvent('stop.decision', data);
		}

		return null;
	}

	return {
		mapEvent,
		mapDecision,
		getSession: () => currentSession,
		getCurrentRun: () => currentRun,
		getActors: () => actors.all(),
		allocateSeq: nextSeq,
	};
}
