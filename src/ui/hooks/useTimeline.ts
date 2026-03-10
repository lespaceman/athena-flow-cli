import {useMemo, useRef} from 'react';
import {type FeedItem} from '../../core/feed/items';
import {type FeedEvent} from '../../core/feed/types';
import {
	type TimelineEntry,
	type RunSummary,
	opCategory,
	eventOperation,
	eventLabel,
	eventSummary,
	mergedEventOperation,
	mergedEventLabel,
	mergedEventSummary,
	expansionForEvent,
	isEventError,
	isEventExpandable,
	toRunStatus,
	VERBOSE_ONLY_KINDS,
	computeDuplicateActors,
} from '../../core/feed/timeline';
import {compactText, actorLabel} from '../../shared/utils/format';
import {
	resolveToolColumn,
	resolveEventToolColumn,
} from '../../core/feed/toolDisplay';
import {startPerfMeasure, startPerfStage} from '../../shared/utils/perf';

const detailCache = new WeakMap<TimelineEntry, string>();
const searchTextCache = new WeakMap<TimelineEntry, string>();

function subagentActorLabel(agentType?: string, agentId?: string): string {
	void agentType;
	void agentId;
	return 'SUB AGENT';
}

function buildSubagentTypeMap(feedEvents: FeedEvent[]): Map<string, string> {
	const map = new Map<string, string>();
	updateSubagentTypeMap(map, feedEvents);
	return map;
}

function updateSubagentTypeMap(
	map: Map<string, string>,
	feedEvents: FeedEvent[],
): void {
	for (const event of feedEvents) {
		if (event.kind !== 'subagent.start' && event.kind !== 'subagent.stop') {
			continue;
		}
		const agentId = event.data.agent_id;
		const agentType = event.data.agent_type;
		if (!agentId || !agentType || map.has(agentId)) continue;
		map.set(agentId, agentType);
	}
}

function resolveActorLabel(
	event: FeedEvent,
	subagentTypes: Map<string, string>,
) {
	if (!event.actor_id.startsWith('subagent:')) {
		return actorLabel(event.actor_id);
	}
	const agentId = event.actor_id.slice('subagent:'.length);
	const eventAgentType =
		event.kind === 'subagent.start' || event.kind === 'subagent.stop'
			? event.data.agent_type
			: undefined;
	return subagentActorLabel(
		eventAgentType || subagentTypes.get(agentId),
		agentId,
	);
}

export type UseTimelineOptions = {
	feedItems: FeedItem[];
	feedEvents: FeedEvent[];
	currentRun: {
		run_id: string;
		trigger: {prompt_preview?: string};
		started_at: number;
	} | null;
	runFilter?: string;
	errorsOnly?: boolean;
	searchQuery: string;
	postByToolUseId?: Map<string, FeedEvent>;
	verbose?: boolean;
};

export type UseTimelineResult = {
	timelineEntries: TimelineEntry[];
	runSummaries: RunSummary[];
	filteredEntries: TimelineEntry[];
	searchMatches: number[];
	searchMatchSet: Set<number>;
};

type TimelineBuildCache = {
	feedItems: FeedItem[];
	feedEvents: FeedEvent[];
	entries: TimelineEntry[];
	activeRunId?: string;
	messageCounter: number;
	subagentTypes: Map<string, string>;
	pendingEntryIndexByToolUseId: Map<string, number>;
	verbose: boolean;
};

function buildMessageEntry(
	item: Extract<FeedItem, {type: 'message'}>['data'],
	activeRunId: string | undefined,
	messageCounter: number,
): TimelineEntry {
	const summary = compactText(item.content, 200);
	const details = item.content;
	return {
		id: `M${String(messageCounter).padStart(3, '0')}`,
		ts: item.timestamp.getTime(),
		runId: activeRunId,
		op: item.role === 'user' ? 'User Msg' : 'Agent Msg',
		opTag: item.role === 'user' ? 'msg.user' : 'msg.agent',
		actor: item.role === 'user' ? 'USER' : 'AGENT',
		actorId: item.role === 'user' ? 'user' : 'agent:root',
		toolColumn: '',
		summary,
		summarySegments: [{text: summary, role: 'plain' as const}],
		searchText: `${summary}\n${details}`,
		error: false,
		expandable: details.length > 120,
		details,
		duplicateActor: false,
	};
}

function shouldSkipEvent(event: FeedEvent, verbose?: boolean): boolean {
	if (!verbose && VERBOSE_ONLY_KINDS.has(event.kind)) {
		return true;
	}
	if (
		!verbose &&
		event.kind === 'stop.request' &&
		!event.data.stop_hook_active
	) {
		return true;
	}
	return false;
}

function mergedToolUseId(
	event: FeedEvent,
	postByToolUseId?: Map<string, FeedEvent>,
): string | undefined {
	if (
		(event.kind !== 'tool.post' && event.kind !== 'tool.failure') ||
		event.data.tool_name === 'Task' ||
		!postByToolUseId
	) {
		return undefined;
	}
	const toolUseId = event.data.tool_use_id;
	if (!toolUseId) return undefined;
	return postByToolUseId.get(toolUseId) === event ? toolUseId : undefined;
}

function pairedPostForEvent(
	event: FeedEvent,
	postByToolUseId?: Map<string, FeedEvent>,
): FeedEvent | undefined {
	if (
		(event.kind !== 'tool.pre' && event.kind !== 'permission.request') ||
		event.data.tool_name === 'Task' ||
		!event.data.tool_use_id
	) {
		return undefined;
	}
	return postByToolUseId?.get(event.data.tool_use_id);
}

function pendingToolUpdateUseId(event: FeedEvent): string | undefined {
	if (
		event.kind !== 'tool.delta' &&
		event.kind !== 'tool.post' &&
		event.kind !== 'tool.failure'
	) {
		return undefined;
	}
	if (event.data.tool_name === 'Task') {
		return undefined;
	}
	return event.data.tool_use_id;
}

function buildEventEntry(
	event: FeedEvent,
	subagentTypes: Map<string, string>,
	pairedPost?: FeedEvent,
): TimelineEntry {
	const opTag = pairedPost
		? mergedEventOperation(event, pairedPost)
		: eventOperation(event);
	const op = pairedPost
		? mergedEventLabel(event, pairedPost)
		: eventLabel(event);
	const summaryResult = pairedPost
		? mergedEventSummary(event, pairedPost)
		: eventSummary(event);
	const {text: summary, segments: summarySegments} = summaryResult;
	const toolColumn =
		event.kind === 'tool.pre' ||
		event.kind === 'tool.post' ||
		event.kind === 'tool.failure'
			? resolveToolColumn(event.data.tool_name)
			: resolveEventToolColumn(event);

	return {
		id: event.event_id,
		ts: event.ts,
		runId: event.run_id,
		op,
		opTag,
		actor: resolveActorLabel(event, subagentTypes),
		actorId: event.actor_id,
		toolColumn,
		summary,
		summarySegments,
		summaryOutcome: summaryResult.outcome,
		summaryOutcomeZero: summaryResult.outcomeZero,
		searchText: summary,
		error: isEventError(event) || pairedPost?.kind === 'tool.failure',
		expandable: isEventExpandable(event),
		details: '',
		feedEvent: event,
		pairedPostEvent: pairedPost,
		duplicateActor: false,
	};
}

function maybeBuildEventEntry(
	event: FeedEvent,
	subagentTypes: Map<string, string>,
	postByToolUseId: Map<string, FeedEvent> | undefined,
	verbose?: boolean,
): TimelineEntry | null {
	if (shouldSkipEvent(event, verbose)) return null;
	if (event.kind === 'tool.delta') return null;
	if (mergedToolUseId(event, postByToolUseId)) {
		return null;
	}
	return buildEventEntry(
		event,
		subagentTypes,
		pairedPostForEvent(event, postByToolUseId),
	);
}

function rememberPendingEntry(
	pendingEntryIndexByToolUseId: Map<string, number>,
	entry: TimelineEntry,
	index: number,
): void {
	const event = entry.feedEvent;
	if (!event) return;
	if (
		(event.kind !== 'tool.pre' && event.kind !== 'permission.request') ||
		event.data.tool_name === 'Task' ||
		!event.data.tool_use_id ||
		entry.pairedPostEvent
	) {
		return;
	}
	pendingEntryIndexByToolUseId.set(event.data.tool_use_id, index);
}

function recomputeDuplicateActorAt(
	entries: TimelineEntry[],
	index: number,
): void {
	const entry = entries[index]!;
	if (index === 0) {
		entry.duplicateActor = false;
		return;
	}
	const prev = entries[index - 1]!;
	const sameActor = entry.actorId === prev.actorId;
	const isBreak = opCategory(entry.opTag) !== opCategory(prev.opTag);
	entry.duplicateActor = sameActor && !isBreak;
}

function recomputeDuplicateActorsAround(
	entries: TimelineEntry[],
	index: number,
): void {
	recomputeDuplicateActorAt(entries, index);
	if (index + 1 < entries.length) {
		recomputeDuplicateActorAt(entries, index + 1);
	}
}

function sameFeedItemPrefix(previous: FeedItem[], next: FeedItem[]): boolean {
	if (next.length < previous.length) return false;
	for (let i = 0; i < previous.length; i++) {
		const prev = previous[i]!;
		const curr = next[i]!;
		if (prev.type !== curr.type || prev.data !== curr.data) {
			return false;
		}
	}
	return true;
}

function sameFeedEventPrefix(
	previous: FeedEvent[],
	next: FeedEvent[],
): boolean {
	if (next.length < previous.length) return false;
	for (let i = 0; i < previous.length; i++) {
		if (previous[i] !== next[i]) {
			return false;
		}
	}
	return true;
}

function canAppendIncrementally(
	previous: TimelineBuildCache | null,
	feedItems: FeedItem[],
	feedEvents: FeedEvent[],
	verbose?: boolean,
): previous is TimelineBuildCache {
	if (!previous) return false;
	if (previous.verbose !== !!verbose) return false;
	return (
		sameFeedItemPrefix(previous.feedItems, feedItems) &&
		sameFeedEventPrefix(previous.feedEvents, feedEvents)
	);
}

function buildTimelineCache(
	feedItems: FeedItem[],
	feedEvents: FeedEvent[],
	postByToolUseId: Map<string, FeedEvent> | undefined,
	verbose?: boolean,
): TimelineBuildCache {
	const entries: TimelineEntry[] = [];
	let activeRunId: string | undefined;
	let messageCounter = 1;
	const subagentTypes = buildSubagentTypeMap(feedEvents);
	const pendingEntryIndexByToolUseId = new Map<string, number>();

	for (const item of feedItems) {
		if (item.type === 'message') {
			entries.push(buildMessageEntry(item.data, activeRunId, messageCounter++));
			continue;
		}
		const event = item.data;
		if (event.kind === 'run.start') {
			activeRunId = event.run_id;
		}
		const entry = maybeBuildEventEntry(
			event,
			subagentTypes,
			postByToolUseId,
			verbose,
		);
		if (entry) {
			const index = entries.push(entry) - 1;
			rememberPendingEntry(pendingEntryIndexByToolUseId, entry, index);
		}
		if (event.kind === 'run.end') {
			activeRunId = undefined;
		}
	}

	computeDuplicateActors(entries);
	return {
		feedItems,
		feedEvents,
		entries,
		activeRunId,
		messageCounter,
		subagentTypes,
		pendingEntryIndexByToolUseId,
		verbose: !!verbose,
	};
}

function appendTimelineCache(
	previous: TimelineBuildCache,
	feedItems: FeedItem[],
	feedEvents: FeedEvent[],
	postByToolUseId: Map<string, FeedEvent> | undefined,
): TimelineBuildCache {
	const entries = previous.entries.slice();
	const subagentTypes = new Map(previous.subagentTypes);
	updateSubagentTypeMap(
		subagentTypes,
		feedEvents.slice(previous.feedEvents.length),
	);
	const pendingEntryIndexByToolUseId = new Map(
		previous.pendingEntryIndexByToolUseId,
	);
	let activeRunId = previous.activeRunId;
	let messageCounter = previous.messageCounter;

	for (const item of feedItems.slice(previous.feedItems.length)) {
		if (item.type === 'message') {
			const index =
				entries.push(
					buildMessageEntry(item.data, activeRunId, messageCounter++),
				) - 1;
			recomputeDuplicateActorsAround(entries, index);
			continue;
		}

		const event = item.data;
		if (event.kind === 'run.start') {
			activeRunId = event.run_id;
		}

		const resolvedToolUseId = pendingToolUpdateUseId(event);
		if (resolvedToolUseId) {
			const pendingIndex = pendingEntryIndexByToolUseId.get(resolvedToolUseId);
			if (pendingIndex !== undefined) {
				const pendingEntry = entries[pendingIndex]!;
				if (pendingEntry.feedEvent) {
					entries[pendingIndex] = buildEventEntry(
						pendingEntry.feedEvent,
						subagentTypes,
						event,
					);
					if (event.kind === 'tool.post' || event.kind === 'tool.failure') {
						pendingEntryIndexByToolUseId.delete(resolvedToolUseId);
					}
					recomputeDuplicateActorsAround(entries, pendingIndex);
				}
			}
			continue;
		}

		const entry = maybeBuildEventEntry(
			event,
			subagentTypes,
			postByToolUseId,
			previous.verbose,
		);
		if (entry) {
			const index = entries.push(entry) - 1;
			recomputeDuplicateActorsAround(entries, index);
			rememberPendingEntry(pendingEntryIndexByToolUseId, entry, index);
		}
		if (event.kind === 'run.end') {
			activeRunId = undefined;
		}
	}

	return {
		feedItems,
		feedEvents,
		entries,
		activeRunId,
		messageCounter,
		subagentTypes,
		pendingEntryIndexByToolUseId,
		verbose: previous.verbose,
	};
}

export function getTimelineEntryDetails(entry: TimelineEntry): string {
	if (entry.details) return entry.details;
	if (!entry.feedEvent) return entry.summary;
	const cached = detailCache.get(entry);
	if (cached !== undefined) return cached;
	const details = isEventExpandable(entry.feedEvent)
		? expansionForEvent(entry.feedEvent)
		: '';
	detailCache.set(entry, details);
	return details;
}

export function getTimelineEntrySearchText(entry: TimelineEntry): string {
	const cached = searchTextCache.get(entry);
	if (cached !== undefined) return cached;
	if (!entry.feedEvent) {
		searchTextCache.set(entry, entry.searchText);
		return entry.searchText;
	}
	const details = getTimelineEntryDetails(entry);
	const searchText = details ? `${entry.summary}\n${details}` : entry.summary;
	searchTextCache.set(entry, searchText);
	return searchText;
}

export function useTimeline({
	feedItems,
	feedEvents,
	currentRun,
	runFilter = 'all',
	errorsOnly = false,
	searchQuery,
	postByToolUseId,
	verbose,
}: UseTimelineOptions): UseTimelineResult {
	const buildCacheRef = useRef<TimelineBuildCache | null>(null);

	const timelineEntries = useMemo((): TimelineEntry[] => {
		const doneSlow = startPerfMeasure('timeline.entries.compute', {
			feed_items: feedItems.length,
			feed_events: feedEvents.length,
		});
		const previous = buildCacheRef.current;
		const incremental = canAppendIncrementally(
			previous,
			feedItems,
			feedEvents,
			verbose,
		);
		const doneStage = startPerfStage('timeline.build', {
			build_mode: incremental ? 'append' : 'full',
			feed_items: feedItems.length,
			feed_events: feedEvents.length,
		});
		try {
			const next = incremental
				? appendTimelineCache(previous, feedItems, feedEvents, postByToolUseId)
				: buildTimelineCache(feedItems, feedEvents, postByToolUseId, verbose);
			buildCacheRef.current = next;
			return next.entries;
		} finally {
			doneStage();
			doneSlow();
		}
	}, [feedItems, feedEvents, postByToolUseId, verbose]);

	const runSummaries = useMemo((): RunSummary[] => {
		const map = new Map<string, RunSummary>();

		for (const event of feedEvents) {
			if (event.kind === 'run.start') {
				map.set(event.run_id, {
					runId: event.run_id,
					title: compactText(
						event.data.trigger.prompt_preview || 'Untitled run',
						46,
					),
					status: 'RUNNING',
					startedAt: event.ts,
				});
				continue;
			}
			if (event.kind === 'run.end') {
				const existing = map.get(event.run_id);
				if (existing) {
					existing.status = toRunStatus(event);
					existing.endedAt = event.ts;
				} else {
					map.set(event.run_id, {
						runId: event.run_id,
						title: 'Untitled run',
						status: toRunStatus(event),
						startedAt: event.ts,
						endedAt: event.ts,
					});
				}
			}
		}

		const summaries = Array.from(map.values()).sort(
			(a, b) => a.startedAt - b.startedAt,
		);

		if (currentRun) {
			const found = summaries.find(s => s.runId === currentRun.run_id);
			if (found) {
				found.status = 'RUNNING';
			} else {
				summaries.push({
					runId: currentRun.run_id,
					title: compactText(
						currentRun.trigger.prompt_preview || 'Untitled run',
						46,
					),
					status: 'RUNNING',
					startedAt: currentRun.started_at,
				});
			}
		}

		return summaries;
	}, [feedEvents, currentRun]);

	const filteredEntries = useMemo(() => {
		const done = startPerfStage('filter.search', {
			op: 'timeline.filter',
			entries: timelineEntries.length,
			run_filter: runFilter,
			errors_only: errorsOnly,
		});
		try {
			return timelineEntries.filter(entry => {
				if (runFilter !== 'all' && entry.runId !== runFilter) return false;
				if (errorsOnly && !entry.error) return false;
				return true;
			});
		} finally {
			done();
		}
	}, [timelineEntries, runFilter, errorsOnly]);

	const searchMatches = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return [] as number[];
		const done = startPerfStage('filter.search', {
			op: 'timeline.search',
			entries: filteredEntries.length,
			query_length: q.length,
		});
		try {
			const matches: number[] = [];
			for (let i = 0; i < filteredEntries.length; i++) {
				if (
					getTimelineEntrySearchText(filteredEntries[i]!)
						.toLowerCase()
						.includes(q)
				) {
					matches.push(i);
				}
			}
			return matches;
		} finally {
			done();
		}
	}, [filteredEntries, searchQuery]);

	const searchMatchSet = useMemo(() => new Set(searchMatches), [searchMatches]);

	return {
		timelineEntries,
		runSummaries,
		filteredEntries,
		searchMatches,
		searchMatchSet,
	};
}
