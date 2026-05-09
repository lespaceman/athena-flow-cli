// src/feed/mapper.ts
//
// Orchestrator over four internal seams:
//   - RunLifecycle: session/run identity, sequence allocation, counters
//   - DecisionCorrelation: request_id → originating event indexes
//   - ToolCorrelation: tool_use_id → pre event + streamed delta state
//   - AgentMessageStream: assistant message buffering, dedup, transcript replay
//
// Bookkeeping that didn't earn its own seam stays inline here:
//   - active subagent stack (LIFO), subagent descriptions, last task description
//   - last root tasks (todo list)
//   - actor registry

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
import {composeTitle, generateTitle} from './titleGen';
import {createTranscriptReader} from './transcript';
import {createRunLifecycle} from './internals/runLifecycle';
import {createDecisionCorrelation} from './internals/decisionCorrelation';
import {createToolCorrelation} from './internals/toolCorrelation';
import {createAgentMessageStream} from './internals/agentMessageStream';

export type FeedMapper = {
	mapEvent(event: RuntimeEvent): FeedEvent[];
	mapDecision(eventId: string, decision: RuntimeDecision): FeedEvent | null;
	getSession(): Session | null;
	getCurrentRun(): Run | null;
	getActors(): Actor[];
	getTasks(): TodoItem[];
	allocateSeq(): number;
};

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

export function createFeedMapper(bootstrap?: MapperBootstrap): FeedMapper {
	const runLifecycle = createRunLifecycle();
	const decisionCorrelation = createDecisionCorrelation();
	const toolCorrelation = createToolCorrelation();
	const transcriptReader = createTranscriptReader();
	const actors = new ActorRegistry();

	let lastRootTasks: TodoItem[] = [];
	const activeSubagentStack: string[] = []; // LIFO of active subagent actor IDs
	let lastTaskDescription: string | undefined;
	const subagentDescriptions = new Map<string, string>();

	function makeEvent(
		kind: FeedEventKind,
		level: FeedEventLevel,
		actorId: string,
		data: unknown,
		runtimeEvent: RuntimeEvent,
		cause?: Partial<FeedEventCause>,
	): FeedEvent {
		const s = runLifecycle.allocateSeq();
		const runId = runLifecycle.getRunId();
		const eventId = `${runId}:E${s}`;

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
			run_id: runId,
			kind,
			level,
			actor_id: actorId,
			cause: baseCause,
			title: '',
			display: runtimeEvent.display,
			raw: runtimeEvent.payload,
			data,
		} as FeedEvent;

		fe.title = composeTitle(fe, runtimeEvent);

		if (
			runtimeEvent.interaction.expectsDecision ||
			kind === 'permission.request' ||
			kind === 'stop.request'
		) {
			decisionCorrelation.recordRequest(runtimeEvent.id, eventId, kind);
		}

		return fe;
	}

	const agentMessageStream = createAgentMessageStream(
		makeEvent,
		transcriptReader,
	);

	if (bootstrap) {
		runLifecycle.restoreFrom(bootstrap);
		for (const e of bootstrap.feedEvents) {
			if (
				e.kind === 'tool.pre' &&
				e.actor_id === 'agent:root' &&
				(e.data as {tool_name?: string}).tool_name === 'TodoWrite'
			) {
				lastRootTasks = extractTodoItems(
					(e.data as {tool_input?: unknown}).tool_input,
				);
			}
		}
	}

	function closeRunIntoEvent(
		runtimeEvent: RuntimeEvent,
		status: 'completed' | 'failed' | 'aborted',
	): FeedEvent | null {
		const closed = runLifecycle.closeRun(runtimeEvent.timestamp, status);
		if (!closed) return null;
		return makeEvent(
			'run.end',
			'info',
			'system',
			{status, counters: {...closed.counters}},
			runtimeEvent,
		);
	}

	function ensureRunArray(
		runtimeEvent: RuntimeEvent,
		triggerType: Run['trigger']['type'] = 'other',
		promptPreview?: string,
	): FeedEvent[] {
		if (runLifecycle.getCurrentRun() && triggerType === 'other') return [];

		const results: FeedEvent[] = [];

		const closeEvt = closeRunIntoEvent(runtimeEvent, 'completed');
		if (closeEvt) results.push(closeEvt);

		// Reset all per-run state across the seams.
		toolCorrelation.resetForNewRun();
		decisionCorrelation.resetForNewRun();
		agentMessageStream.resetForNewRun();
		activeSubagentStack.length = 0;

		runLifecycle.openNewRun(
			runtimeEvent.timestamp,
			runtimeEvent.sessionId,
			triggerType,
			promptPreview,
		);

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
		const currentScope = (): 'root' | 'subagent' =>
			activeSubagentStack.length > 0 ? 'subagent' : 'root';

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
			const ev = agentMessageStream.emit({
				runtimeEvent: event,
				actorId,
				scope,
				message: msg,
				source: 'hook',
				cause: parentEvt ? {parent_event_id: parentEvt.event_id} : undefined,
			});
			if (ev) results.push(ev);
		}

		// Extract new assistant messages from transcript BEFORE processing the
		// hook event so that agent.message gets a lower seq than tool.pre etc.
		// Skip stop events — they use last_assistant_message to avoid flush-timing dupes.
		const transcriptPath = event.context.transcriptPath;
		const isStopEvent =
			eventKind === 'stop.request' || eventKind === 'subagent.stop';
		if (transcriptPath && !isStopEvent) {
			results.push(
				...agentMessageStream.emitTranscriptMessages(
					transcriptPath,
					event,
					resolveToolActor(),
					currentScope(),
				),
			);
		}

		switch (eventKind) {
			case 'session.start': {
				agentMessageStream.clearPending();
				const source = readString(d['source']) ?? 'startup';
				runLifecycle.setSession({
					session_id: event.sessionId,
					started_at: event.timestamp,
					source,
					agent_type: readString(d['agent_type']),
				});
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
				agentMessageStream.clearPending();
				const closeEvt = closeRunIntoEvent(event, 'completed');
				if (closeEvt) results.push(closeEvt);
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
				runLifecycle.endSession(event.timestamp);
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
				agentMessageStream.clearPending();
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
				agentMessageStream.appendPendingDelta(
					readString(d['item_id']),
					readString(d['delta']) ?? '',
					resolveToolActor(),
					currentScope(),
				);
				break;
			}

			case 'message.complete': {
				results.push(...ensureRunArray(event));
				const ev = agentMessageStream.emitCompleted({
					itemId: readString(d['item_id']),
					messageText: readString(d['message']),
					fallbackActorId: resolveToolActor(),
					fallbackScope: currentScope(),
					runtimeEvent: event,
				});
				if (ev) results.push(ev);
				break;
			}

			case 'turn.complete': {
				if (!runLifecycle.getCurrentRun()) {
					agentMessageStream.clearPending();
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
				const flushed = agentMessageStream.flushPending(event);
				for (const f of flushed) {
					f.cause = {
						...(f.cause ?? {}),
						parent_event_id: stopEvt.event_id,
					};
					results.push(f);
				}
				const closeEvt = closeRunIntoEvent(event, 'completed');
				if (closeEvt) results.push(closeEvt);
				break;
			}

			case 'plan.delta': {
				const planSteps = d['plan'];
				if (Array.isArray(planSteps) && planSteps.length > 0) {
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
								message: agentMessageStream.appendReasoningSummary(
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
				const parentId = toolCorrelation.lookupParent(toolUseId);
				const chunk = readString(d['delta']) ?? '';
				const cumulative = toolCorrelation.appendDelta(toolUseId, chunk);
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
				runLifecycle.incrementCounter('tool_uses');
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
					toolCorrelation.recordPre(toolUseId, fe.event_id);
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
				if (toolUseId) toolCorrelation.forgetTool(toolUseId);
				const parentId = toolCorrelation.lookupParent(toolUseId);
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
				runLifecycle.incrementCounter('tool_failures');
				const toolUseId = resolveToolUseId(event, d);
				if (toolUseId) toolCorrelation.forgetTool(toolUseId);
				const parentId = toolCorrelation.lookupParent(toolUseId);
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
				runLifecycle.incrementCounter('permission_requests');
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
					const currentRun = runLifecycle.getCurrentRun();
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
							? decisionCorrelation.lookupResolved(requestId)
							: null;
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
			if (transcriptPath) agentMessageStream.drainTranscript(transcriptPath);
			emitFallbackMessage('stop.request', 'agent:root', 'root');
		}
		if (eventKind === 'subagent.stop') {
			const agentId = readString(d['agent_id']) ?? 'unknown';
			if (transcriptPath) agentMessageStream.drainTranscript(transcriptPath);
			emitFallbackMessage('subagent.stop', `subagent:${agentId}`, 'subagent');
		}

		return results;
	}

	function mapDecision(
		requestId: string,
		decision: RuntimeDecision,
	): FeedEvent | null {
		const consumed = decisionCorrelation.consumeForDecision(requestId);
		if (!consumed) return null;
		const {parentEventId, originalKind} = consumed;

		function makeDecisionEvent(kind: FeedEventKind, data: unknown): FeedEvent {
			const s = runLifecycle.allocateSeq();
			const runId = runLifecycle.getRunId();
			const session = runLifecycle.getSession();
			const fe = {
				event_id: `${runId}:E${s}`,
				seq: s,
				ts: Date.now(),
				session_id: session?.session_id ?? 'unknown',
				run_id: runId,
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
				data = {
					decision_type: 'block',
					reason: decisionReason ?? decision.reason ?? 'Blocked',
				};
			} else if (d?.ok === false) {
				data = {
					decision_type: 'block',
					reason: decisionReason ?? 'Blocked by hook',
				};
			} else {
				data = {decision_type: 'allow'};
			}

			return makeDecisionEvent('stop.decision', data);
		}

		return null;
	}

	return {
		mapEvent,
		mapDecision,
		getSession: () => runLifecycle.getSession(),
		getCurrentRun: () => runLifecycle.getCurrentRun(),
		getActors: () => actors.all(),
		getTasks: () => lastRootTasks,
		allocateSeq: () => runLifecycle.allocateSeq(),
	};
}
