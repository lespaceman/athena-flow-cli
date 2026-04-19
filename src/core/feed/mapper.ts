// src/feed/mapper.ts

import type {RuntimeEvent, RuntimeDecision} from '../runtime/types';
import type {RuntimeEventDataMap} from '../runtime/events';
import type {PermissionSuggestion} from '../../shared/types/permissionSuggestion';
import type {
	FeedEvent,
	FeedEventKind,
	FeedEventLevel,
	FeedEventCause,
} from './types';
import type {Session, Run, Actor} from './entities';
import type {MapperBootstrap} from './bootstrap';
import {type TodoItem, type TodoWriteInput, isSubagentTool} from './todo';
import {ActorRegistry} from './entities';
import {generateTitle} from './titleGen';
import {createTranscriptReader} from './transcript';

export type FeedMapper = {
	mapEvent(event: RuntimeEvent): FeedEvent[];
	mapDecision(eventId: string, decision: RuntimeDecision): FeedEvent | null;
	getSession(): Session | null;
	getCurrentRun(): Run | null;
	getActors(): Actor[];
	getTasks(): TodoItem[];
	allocateSeq(): number;
};

export function createFeedMapper(bootstrap?: MapperBootstrap): FeedMapper {
	const MAX_STREAMED_TOOL_OUTPUT_CHARS = 64_000;
	const STREAMED_TOOL_OUTPUT_TRUNCATED_NOTICE =
		'[streaming output truncated to recent content]\n';
	let currentSession: Session | null = null;
	let currentRun: Run | null = null;
	let lastRootTasks: TodoItem[] = [];
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
	const resolvedRequestById = new Map<
		string,
		{event_id: string; kind: FeedEventKind}
	>();

	// Bootstrap from stored session
	if (bootstrap) {
		// Restore seq, runSeq, and tasks from stored events (single pass)
		for (const e of bootstrap.feedEvents) {
			if (e.seq > seq) seq = e.seq;
			const m = e.run_id.match(/:R(\d+)$/);
			if (m) {
				const n = parseInt(m[1]!, 10);
				if (n > runSeq) runSeq = n;
			}
			if (
				e.kind === 'tool.pre' &&
				e.actor_id === 'agent:root' &&
				e.data.tool_name === 'TodoWrite'
			) {
				lastRootTasks = extractTodoItems(e.data.tool_input);
			}
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

	function extractTodoItems(toolInput: unknown): TodoItem[] {
		const input = toolInput as TodoWriteInput | undefined;
		return Array.isArray(input?.todos) ? input.todos : [];
	}

	function mapPlanStepStatus(status: string | undefined): TodoItem['status'] {
		switch (status) {
			case 'inProgress':
				return 'in_progress';
			case 'completed':
				return 'completed';
			case undefined:
			default:
				return 'pending';
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

		// Index only request-bearing events for later decision/resolution correlation.
		if (
			runtimeEvent.interaction.expectsDecision ||
			kind === 'permission.request' ||
			kind === 'stop.request'
		) {
			eventIdByRequestId.set(runtimeEvent.id, eventId);
			eventKindByRequestId.set(runtimeEvent.id, kind);
			resolvedRequestById.set(runtimeEvent.id, {event_id: eventId, kind});
		}

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
		reasoningSummaryByKey.clear();
		eventIdByRequestId.clear();
		eventKindByRequestId.clear();
		resolvedRequestById.clear();
		resetAgentMessageDeduper();
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
	const lastAgentMessageByActorScope = new Map<string, string>();
	const reasoningSummaryByKey = new Map<string, string>();
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
		const results: FeedEvent[] = [];
		for (const msg of msgs) {
			const agentMsg = emitAgentMessage(
				runtimeEvent,
				actorId,
				scope,
				msg.text,
				'transcript',
				undefined,
				msg.model,
			);
			if (agentMsg) {
				results.push(agentMsg);
			}
		}
		return results;
	}

	function agentMessageKey(
		actorId: string,
		scope: 'root' | 'subagent',
	): string {
		return `${actorId}\0${scope}`;
	}

	function normalizeAgentMessage(message: string): string {
		return message.replace(/\r\n/g, '\n').trimEnd();
	}

	function resetAgentMessageDeduper(): void {
		lastAgentMessageByActorScope.clear();
	}

	function appendReasoningSummary(
		itemId: string | undefined,
		index: number | undefined,
		chunk: string,
	): string {
		const key = `${itemId ?? ''}:${index ?? 0}`;
		const next = `${reasoningSummaryByKey.get(key) ?? ''}${chunk}`;
		reasoningSummaryByKey.set(key, next);
		return next;
	}

	function emitAgentMessage(
		runtimeEvent: RuntimeEvent,
		actorId: string,
		scope: 'root' | 'subagent',
		message: string,
		source: 'hook' | 'transcript',
		cause?: Partial<FeedEventCause>,
		model?: string,
	): FeedEvent | null {
		const normalized = normalizeAgentMessage(message);
		if (!normalized) return null;

		const key = agentMessageKey(actorId, scope);
		const previous = lastAgentMessageByActorScope.get(key);
		if (previous === normalized) {
			return null;
		}

		const event = makeEvent(
			'agent.message',
			'info',
			actorId,
			{
				message: normalized,
				source,
				scope,
				...(model ? {model} : {}),
			} satisfies import('./types').AgentMessageData,
			runtimeEvent,
			cause,
		);
		lastAgentMessageByActorScope.set(key, normalized);
		return event;
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
		): PermissionSuggestion[] | undefined => {
			for (const value of values) {
				if (Array.isArray(value)) {
					return value as PermissionSuggestion[];
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
			const agentMsg = emitAgentMessage(
				event,
				scope.actorId,
				scope.scope,
				message,
				'hook',
			);
			if (agentMsg) {
				results.push(agentMsg);
			}
			pendingMessages.delete(key);
		};
		const flushPendingMessages = (): void => {
			for (const [itemId, pending] of pendingMessages) {
				if (!pending.message) continue;
				const agentMsg = emitAgentMessage(
					event,
					pending.actorId,
					pending.scope,
					pending.message,
					'hook',
				);
				if (agentMsg) {
					results.push(agentMsg);
				}
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
			const agentMsg = emitAgentMessage(
				event,
				actorId,
				scope,
				msg,
				'hook',
				parentEvt ? {parent_event_id: parentEvt.event_id} : undefined,
			);
			if (agentMsg) {
				results.push(agentMsg);
			}
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
							agent_type: readString(d['agent_type']),
							model: readString(d['model']),
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

			case 'plan.delta': {
				const planSteps = d['plan'];
				if (Array.isArray(planSteps) && planSteps.length > 0) {
					// Compare raw steps against lastRootTasks before allocating.
					const changed =
						planSteps.length !== lastRootTasks.length ||
						planSteps.some(
							(step: {step?: string; status?: string}, i: number) => {
								const content = typeof step.step === 'string' ? step.step : '';
								const status = mapPlanStepStatus(step.status);
								return (
									content !== lastRootTasks[i]?.content ||
									status !== lastRootTasks[i]?.status
								);
							},
						);
					if (changed) {
						lastRootTasks = planSteps.map(
							(step: {step?: string; status?: string}) => ({
								content: typeof step.step === 'string' ? step.step : '',
								status: mapPlanStepStatus(step.status),
							}),
						);
						// Notify UI — useMemo on feedEvents drives task panel updates.
						results.push(
							makeEvent(
								'todo.update',
								'info',
								'system',
								{
									todo_id: 'plan',
									patch: {status: 'doing'},
								} satisfies import('./types').TodoUpdateData,
								event,
							),
						);
					}
				}
				results.push(
					makeEvent(
						'plan.update',
						'info',
						'system',
						{
							explanation: readString(d['explanation']) ?? null,
							delta: readString(d['delta']),
							item_id: readString(d['item_id']),
							thread_id: readString(d['thread_id']),
							turn_id: readString(d['turn_id']),
							plan: Array.isArray(planSteps)
								? (planSteps as Array<{step?: string; status?: string}>)
								: undefined,
						} satisfies import('./types').PlanUpdateData,
						event,
					),
				);
				break;
			}
			case 'reasoning.delta':
				if (readString(d['phase']) === 'summary' && readString(d['delta'])) {
					const summaryIndex = (() => {
						const value = d['summary_index'] ?? d['content_index'];
						return typeof value === 'number' ? value : undefined;
					})();
					results.push(
						makeEvent(
							'reasoning.summary',
							'info',
							'agent:root',
							{
								message: appendReasoningSummary(
									readString(d['item_id']),
									summaryIndex,
									readString(d['delta']) ?? '',
								),
								item_id: readString(d['item_id']),
								content_index:
									typeof d['content_index'] === 'number'
										? (d['content_index'] as number)
										: undefined,
								summary_index:
									typeof d['summary_index'] === 'number'
										? (d['summary_index'] as number)
										: summaryIndex,
								thread_id: readString(d['thread_id']),
								turn_id: readString(d['turn_id']),
							} satisfies import('./types').ReasoningSummaryData,
							event,
						),
					);
				}
				break;
			case 'usage.update': {
				results.push(
					makeEvent(
						'usage.update',
						'info',
						'system',
						{
							thread_id: readString(d['thread_id']),
							turn_id: readString(d['turn_id']),
							usage:
								typeof d['usage'] === 'object' && d['usage'] !== null
									? (d[
											'usage'
										] as import('../../shared/types/headerMetrics').TokenUsage)
									: undefined,
							delta:
								typeof d['delta'] === 'object' && d['delta'] !== null
									? (d[
											'delta'
										] as import('../../shared/types/headerMetrics').TokenUsage)
									: undefined,
						} satisfies import('./types').UsageUpdateData,
						event,
					),
				);
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
				if (toolName === 'WebSearch') {
					results.push(
						makeEvent(
							'web.search',
							'info',
							'system',
							{
								message: (() => {
									const query = readString(
										readObject(d['tool_input'])['query'],
									);
									return query
										? `Searching web for "${query}".`
										: 'Searching the web.';
								})(),
								phase: 'started',
								query: readString(readObject(d['tool_input'])['query']),
								item_id: toolUseId,
							} satisfies import('./types').WebSearchData,
							event,
							toolUseId
								? {parent_event_id: fe.event_id, tool_use_id: toolUseId}
								: {parent_event_id: fe.event_id},
						),
					);
				}

				if (toolName === 'TodoWrite' && fe.actor_id === 'agent:root') {
					lastRootTasks = extractTodoItems(readObject(d['tool_input']));
				}

				if (isSubagentTool(toolName)) {
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
				const postEvent = makeEvent(
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
				);
				results.push(postEvent);
				if (toolName === 'WebSearch') {
					const response = readObject(d['tool_response']);
					const actionType = readString(response['type']);
					const query = readString(readObject(d['tool_input'])['query']);
					const url = readString(response['url']);
					const pattern = readString(response['pattern']);
					const queries = Array.isArray(response['queries'])
						? (response['queries'] as string[])
						: undefined;
					const message =
						actionType === 'openPage'
							? url
								? `Opened search result ${url}.`
								: 'Opened search result.'
							: actionType === 'findInPage'
								? pattern
									? `Found "${pattern}" in ${url ?? 'the page'}.`
									: `Searched within ${url ?? 'the page'}.`
								: actionType === 'search'
									? queries && queries.length > 1
										? `Ran ${queries.length} search queries.`
										: query
											? `Searched web for "${query}".`
											: 'Finished web search.'
									: query
										? `Finished web search for "${query}".`
										: 'Finished web search.';
					results.push(
						makeEvent(
							'web.search',
							'info',
							'system',
							{
								message,
								phase: 'completed',
								query,
								action_type: actionType,
								url,
								pattern,
								queries,
								item_id: toolUseId,
							} satisfies import('./types').WebSearchData,
							event,
							toolUseId
								? {parent_event_id: postEvent.event_id, tool_use_id: toolUseId}
								: {parent_event_id: postEvent.event_id},
						),
					);
				}
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
							network_context:
								typeof d['network_context'] === 'object' &&
								d['network_context'] !== null
									? {
											host: readString(
												(d['network_context'] as Record<string, unknown>)[
													'host'
												],
											),
											protocol: readString(
												(d['network_context'] as Record<string, unknown>)[
													'protocol'
												],
											),
										}
									: undefined,
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
							description:
								lastTaskDescription ?? readString(d['prompt']) ?? undefined,
							tool: readString(d['tool']),
							sender_thread_id: readString(d['sender_thread_id']),
							receiver_thread_id: readString(d['receiver_thread_id']),
							new_thread_id: readString(d['new_thread_id']),
							agent_status: readString(d['agent_status']),
						} satisfies import('./types').SubagentStartData,
						event,
					),
				);
				if (agentId && (lastTaskDescription || readString(d['prompt']))) {
					subagentDescriptions.set(
						agentId,
						lastTaskDescription ?? readString(d['prompt']) ?? '',
					);
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
						tool: readString(d['tool']),
						status: readString(d['status']),
						sender_thread_id: readString(d['sender_thread_id']),
						receiver_thread_id: readString(d['receiver_thread_id']),
						new_thread_id: readString(d['new_thread_id']),
						agent_status: readString(d['agent_status']),
					} satisfies import('./types').SubagentStopData,
					event,
				);
				results.push(subStopEvt);
				break;
			}

			case 'notification': {
				results.push(...ensureRunArray(event));
				const notificationType = readString(d['notification_type']);
				const message = readString(d['message']) ?? '';
				const title = readString(d['title']);

				type NotificationData = RuntimeEventDataMap['notification'] &
					Record<string, unknown>;
				type NotificationRouteCtx = {
					notificationType: string;
					message: string;
					title: string | undefined;
				};
				type NotificationRoute = (
					data: NotificationData,
					runtimeEvent: RuntimeEvent,
					ctx: NotificationRouteCtx,
				) => FeedEvent[];

				const reviewRoute: NotificationRoute = (data, runtimeEvent, ctx) => {
					const item = readObject(data['item']);
					return [
						makeEvent(
							'review.status',
							'info',
							'system',
							{
								message: ctx.message,
								phase: ctx.notificationType.endsWith('.completed')
									? 'completed'
									: 'started',
								review: readString(item['review']),
								item_id: readString(data['item_id']),
							} satisfies import('./types').ReviewStatusData,
							runtimeEvent,
						),
					];
				};

				const imageViewRoute: NotificationRoute = (data, runtimeEvent, ctx) => {
					const item = readObject(data['item']);
					return [
						makeEvent(
							'image.view',
							'info',
							'system',
							{
								message: ctx.message,
								path: readString(item['path']),
								item_id: readString(data['item_id']),
							} satisfies import('./types').ImageViewData,
							runtimeEvent,
						),
					];
				};

				const contextCompactionRoute: NotificationRoute = (
					data,
					runtimeEvent,
					ctx,
				) => [
					makeEvent(
						'context.compaction',
						'info',
						'system',
						{
							message: ctx.message,
							phase: ctx.notificationType.endsWith('.completed')
								? 'completed'
								: 'started',
							item_id: readString(data['item_id']),
						} satisfies import('./types').ContextCompactionData,
						runtimeEvent,
					),
				];

				const NOTIFICATION_ROUTES: Record<string, NotificationRoute> = {
					'codex.error': (data, runtimeEvent, ctx) => [
						makeEvent(
							'runtime.error',
							'error',
							'system',
							{
								message: ctx.message,
								title: ctx.title,
								thread_id: readString(data['thread_id']),
								turn_id: readString(data['turn_id']),
								error_code: readString(data['error_code']),
								will_retry: readBoolean(data['will_retry']),
							} satisfies import('./types').RuntimeErrorData,
							runtimeEvent,
						),
					],
					'thread.status_changed': (data, runtimeEvent, ctx) => [
						makeEvent(
							'thread.status',
							'info',
							'system',
							{
								message: ctx.message,
								thread_id: readString(data['thread_id']),
								status_type: readString(data['status_type']),
								active_flags: Array.isArray(data['active_flags'])
									? (data['active_flags'] as string[])
									: undefined,
							} satisfies import('./types').ThreadStatusData,
							runtimeEvent,
						),
					],
					'turn.diff_updated': (data, runtimeEvent, ctx) => [
						makeEvent(
							'turn.diff',
							'info',
							'system',
							{
								message: ctx.message,
								thread_id: readString(data['thread_id']),
								turn_id: readString(data['turn_id']),
								diff: readString(data['diff']) ?? '',
							} satisfies import('./types').TurnDiffData,
							runtimeEvent,
						),
					],
					'server_request.resolved': (data, runtimeEvent, ctx) => {
						const requestId =
							data['request_id'] !== undefined
								? String(data['request_id'])
								: undefined;
						const resolved = requestId
							? resolvedRequestById.get(requestId)
							: undefined;
						return [
							makeEvent(
								'server.request.resolved',
								'info',
								'system',
								{
									message: ctx.message,
									request_id: requestId,
									resolved_kind: resolved?.kind,
								} satisfies import('./types').ServerRequestResolvedData,
								runtimeEvent,
								resolved ? {parent_event_id: resolved.event_id} : undefined,
							),
						];
					},
					'item.enteredReviewMode.started': reviewRoute,
					'item.enteredReviewMode.completed': reviewRoute,
					'item.exitedReviewMode.started': reviewRoute,
					'item.exitedReviewMode.completed': reviewRoute,
					'item.imageView.started': imageViewRoute,
					'item.imageView.completed': imageViewRoute,
					'item.contextCompaction.started': contextCompactionRoute,
					'item.contextCompaction.completed': contextCompactionRoute,
					'mcp_tool_call.progress': (_data, runtimeEvent, ctx) => [
						makeEvent(
							'mcp.progress',
							'info',
							'system',
							{
								message: ctx.message,
								title: ctx.title,
							} satisfies import('./types').McpProgressData,
							runtimeEvent,
						),
					],
					'command_execution.terminal_interaction': (
						_data,
						runtimeEvent,
						ctx,
					) => [
						makeEvent(
							'terminal.input',
							'info',
							'system',
							{
								message: ctx.message,
								input_preview: ctx.message,
							} satisfies import('./types').TerminalInputData,
							runtimeEvent,
						),
					],
					'skills.changed': (_data, runtimeEvent, ctx) => [
						makeEvent(
							'skills.changed',
							'info',
							'system',
							{
								message: ctx.message,
							} satisfies import('./types').SkillsChangedData,
							runtimeEvent,
						),
					],
					'skills.loaded': (_data, runtimeEvent, ctx) => {
						const payload =
							typeof runtimeEvent.payload === 'object' &&
							runtimeEvent.payload !== null
								? (runtimeEvent.payload as Record<string, unknown>)
								: null;
						return [
							makeEvent(
								'skills.loaded',
								'info',
								'system',
								{
									message: ctx.message,
									count:
										typeof payload?.['count'] === 'number'
											? (payload['count'] as number)
											: undefined,
									error_count:
										typeof payload?.['error_count'] === 'number'
											? (payload['error_count'] as number)
											: undefined,
								} satisfies import('./types').SkillsLoadedData,
								runtimeEvent,
							),
						];
					},
				};

				const route = notificationType
					? NOTIFICATION_ROUTES[notificationType]
					: undefined;
				if (route && notificationType) {
					results.push(
						...route(d as NotificationData, event, {
							notificationType,
							message,
							title,
						}),
					);
					break;
				}

				results.push(
					makeEvent(
						'notification',
						'info',
						'system',
						{
							message,
							title,
							notification_type: notificationType,
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

			case 'compact.post': {
				results.push(...ensureRunArray(event));
				const evt = makeEvent(
					'compact.post',
					'info',
					'system',
					{
						trigger:
							(readString(d['trigger']) as 'manual' | 'auto' | undefined) ??
							'auto',
					} satisfies import('./types').PostCompactData,
					event,
				);
				evt.ui = {collapsed_default: true};
				results.push(evt);
				break;
			}

			case 'task.created': {
				results.push(...ensureRunArray(event));
				results.push(
					makeEvent(
						'task.created',
						'info',
						'system',
						{
							task_id: readString(d['task_id']) ?? '',
							task_subject: readString(d['task_subject']) ?? '',
							task_description: readString(d['task_description']),
							teammate_name: readString(d['teammate_name']),
							team_name: readString(d['team_name']),
						} satisfies import('./types').TaskCreatedData,
						event,
					),
				);
				break;
			}

			case 'cwd.changed': {
				results.push(...ensureRunArray(event));
				const evt = makeEvent(
					'cwd.changed',
					'info',
					'system',
					{
						cwd: readString(d['cwd']) ?? '',
					} satisfies import('./types').CwdChangedData,
					event,
				);
				evt.ui = {collapsed_default: true};
				results.push(evt);
				break;
			}

			case 'file.changed': {
				results.push(...ensureRunArray(event));
				const evt = makeEvent(
					'file.changed',
					'info',
					'system',
					{
						file_path: readString(d['file_path']) ?? '',
					} satisfies import('./types').FileChangedData,
					event,
				);
				evt.ui = {collapsed_default: true};
				results.push(evt);
				break;
			}

			case 'stop.failure': {
				results.push(...ensureRunArray(event));
				results.push(
					makeEvent(
						'stop.failure',
						'error',
						'system',
						{
							error_type: readString(d['error_type']) ?? 'unknown',
							error_message: readString(d['error_message']),
						} satisfies import('./types').StopFailureData,
						event,
					),
				);
				break;
			}

			case 'permission.denied': {
				results.push(...ensureRunArray(event));
				results.push(
					makeEvent(
						'permission.denied',
						'warn',
						'system',
						{
							tool_name:
								event.toolName ?? readString(d['tool_name']) ?? 'Unknown',
							tool_input: readObject(d['tool_input']),
							tool_use_id: readString(d['tool_use_id']),
							reason: readString(d['reason']),
						} satisfies import('./types').PermissionDeniedData,
						event,
					),
				);
				break;
			}

			case 'elicitation.request': {
				results.push(...ensureRunArray(event));
				results.push(
					makeEvent(
						'elicitation.request',
						'warn',
						'system',
						{
							mcp_server: readString(d['mcp_server']) ?? 'unknown',
							form: d['form'],
						} satisfies import('./types').ElicitationRequestData,
						event,
					),
				);
				break;
			}

			case 'elicitation.result': {
				results.push(...ensureRunArray(event));
				const action = readString(d['action']);
				const evt = makeEvent(
					'elicitation.result',
					'info',
					'system',
					{
						mcp_server: readString(d['mcp_server']) ?? 'unknown',
						...(action ? {action} : {}),
						content: readObject(d['content']),
					} satisfies import('./types').ElicitationResultData,
					event,
				);
				evt.ui = {collapsed_default: true};
				results.push(evt);
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
		getTasks: () => lastRootTasks,
		allocateSeq: nextSeq,
	};
}
