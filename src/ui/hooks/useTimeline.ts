import {useMemo, useEffect, useState} from 'react';
import {type FeedItem} from '../../core/feed/items';
import {type FeedEvent} from '../../core/feed/types';
import {
	type TimelineEntry,
	type RunSummary,
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
import {startPerfMeasure} from '../../shared/utils/perf';

function subagentActorLabel(agentType?: string, agentId?: string): string {
	void agentType;
	void agentId;
	return 'SUB AGENT';
}

function buildSubagentTypeMap(feedEvents: FeedEvent[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const event of feedEvents) {
		if (event.kind !== 'subagent.start' && event.kind !== 'subagent.stop') {
			continue;
		}
		const agentId = event.data.agent_id;
		const agentType = event.data.agent_type;
		if (!agentId || !agentType || map.has(agentId)) continue;
		map.set(agentId, agentType);
	}
	return map;
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
	searchMatchPos: number;
	setSearchMatchPos: React.Dispatch<React.SetStateAction<number>>;
};

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
	const [searchMatchPos, setSearchMatchPos] = useState(0);

	const timelineEntries = useMemo((): TimelineEntry[] => {
		const done = startPerfMeasure('timeline.entries.compute', {
			feed_items: feedItems.length,
			feed_events: feedEvents.length,
		});
		try {
			const entries: TimelineEntry[] = [];
			let activeRunId: string | undefined;
			let messageCounter = 1;
			const subagentTypes = buildSubagentTypeMap(feedEvents);

			for (const item of feedItems) {
				if (item.type === 'message') {
					const id = `M${String(messageCounter++).padStart(3, '0')}`;
					const summary = compactText(item.data.content, 200);
					const details = item.data.content;
					entries.push({
						id,
						ts: item.data.timestamp.getTime(),
						runId: activeRunId,
						op: item.data.role === 'user' ? 'User Msg' : 'Agent Msg',
						opTag: item.data.role === 'user' ? 'msg.user' : 'msg.agent',
						actor: item.data.role === 'user' ? 'USER' : 'AGENT',
						actorId: item.data.role === 'user' ? 'user' : 'agent:root',
						toolColumn: '',
						summary,
						summarySegments: [{text: summary, role: 'plain' as const}],
						searchText: `${summary}\n${details}`,
						error: false,
						expandable: details.length > 120,
						details,
						duplicateActor: false,
					});
					continue;
				}

				const event = item.data;
				if (event.kind === 'run.start') {
					activeRunId = event.run_id;
				}

				// Verbose filtering: skip lifecycle events when not verbose
				if (!verbose && VERBOSE_ONLY_KINDS.has(event.kind)) {
					// Still track run boundaries for activeRunId
					if (event.kind === 'run.end') {
						activeRunId = undefined;
					}
					continue;
				}

				// Hide inactive stop hooks unless verbose — they're just noise
				if (
					!verbose &&
					event.kind === 'stop.request' &&
					!event.data.stop_hook_active
				) {
					continue;
				}

				// Merge tool.post/tool.failure into their paired tool.pre
				// If this post/failure event is in the map, it will be rendered
				// by the paired tool.pre entry — skip it here.
				if (
					(event.kind === 'tool.post' || event.kind === 'tool.failure') &&
					event.data.tool_name !== 'Task' &&
					postByToolUseId &&
					event.data.tool_use_id &&
					postByToolUseId.get(event.data.tool_use_id) === event
				) {
					continue;
				}

				// For tool.pre, look up paired post event
				const pairedPost =
					(event.kind === 'tool.pre' || event.kind === 'permission.request') &&
					event.data.tool_name !== 'Task' &&
					event.data.tool_use_id
						? postByToolUseId?.get(event.data.tool_use_id)
						: undefined;

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
				const details = isEventExpandable(event)
					? expansionForEvent(event)
					: '';
				const toolColumn =
					event.kind === 'tool.pre' ||
					event.kind === 'tool.post' ||
					event.kind === 'tool.failure'
						? resolveToolColumn(event.data.tool_name)
						: resolveEventToolColumn(event);
				entries.push({
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
					searchText: `${summary}\n${details}`,
					error: isEventError(event) || pairedPost?.kind === 'tool.failure',
					expandable: isEventExpandable(event),
					details,
					feedEvent: event,
					pairedPostEvent: pairedPost,
					duplicateActor: false,
				});
				if (event.kind === 'run.end') {
					activeRunId = undefined;
				}
			}
			computeDuplicateActors(entries);
			return entries;
		} finally {
			done();
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
		return timelineEntries.filter(entry => {
			if (runFilter !== 'all' && entry.runId !== runFilter) return false;
			if (errorsOnly && !entry.error) return false;
			return true;
		});
	}, [timelineEntries, runFilter, errorsOnly]);

	const searchMatches = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return [] as number[];
		const matches: number[] = [];
		for (let i = 0; i < filteredEntries.length; i++) {
			if (filteredEntries[i]!.searchText.toLowerCase().includes(q)) {
				matches.push(i);
			}
		}
		return matches;
	}, [filteredEntries, searchQuery]);

	const searchMatchSet = useMemo(() => new Set(searchMatches), [searchMatches]);

	useEffect(() => {
		setSearchMatchPos(prev =>
			Math.min(prev, Math.max(0, searchMatches.length - 1)),
		);
	}, [searchMatches.length]);

	return {
		timelineEntries,
		runSummaries,
		filteredEntries,
		searchMatches,
		searchMatchSet,
		searchMatchPos,
		setSearchMatchPos,
	};
}
