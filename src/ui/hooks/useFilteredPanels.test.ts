/** @vitest-environment jsdom */
import {describe, expect, it} from 'vitest';
import {renderHook} from '@testing-library/react';
import {useFilteredPanels} from './useFilteredPanels';
import {type TimelineEntry} from '../../core/feed/timeline';

function makeEntry(overrides: Partial<TimelineEntry>): TimelineEntry {
	return {
		id: overrides.id ?? 'entry-1',
		ts: overrides.ts ?? 0,
		op: overrides.op ?? 'Message',
		opTag: overrides.opTag ?? 'msg.agent',
		actor: overrides.actor ?? 'assistant',
		actorId: overrides.actorId ?? 'assistant',
		toolColumn: overrides.toolColumn ?? '',
		summary: overrides.summary ?? 'summary',
		summarySegments: overrides.summarySegments ?? [],
		searchText: overrides.searchText ?? '',
		error: overrides.error ?? false,
		expandable: overrides.expandable ?? true,
		details: overrides.details ?? '',
		duplicateActor: overrides.duplicateActor ?? false,
		feedEvent: overrides.feedEvent,
		pairedPostEvent: overrides.pairedPostEvent,
		runId: overrides.runId,
		summaryOutcome: overrides.summaryOutcome,
		summaryOutcomeZero: overrides.summaryOutcomeZero,
	};
}

describe('useFilteredPanels', () => {
	it('tracks which message entry owns each wrapped line', () => {
		const entries = [
			makeEntry({
				id: 'agent-1',
				opTag: 'msg.agent',
				details:
					'First line that wraps because it is intentionally long enough to exceed the panel width.',
			}),
			makeEntry({
				id: 'user-1',
				opTag: 'msg.user',
				details: 'Second message',
			}),
			makeEntry({
				id: 'feed-1',
				opTag: 'tool.call',
				summary: 'tool event',
			}),
		];

		const {result} = renderHook(() =>
			useFilteredPanels(entries, 'both', true, 20),
		);

		expect(result.current.messageEntries).toHaveLength(2);
		expect(result.current.feedEntries).toHaveLength(1);
		expect(result.current.messageLineCount).toBe(
			result.current.messageLineEntryIndexes.length,
		);
		expect(result.current.messageLineEntryIndexes).toContain(0);
		expect(result.current.messageLineEntryIndexes).toContain(1);
		expect(result.current.messageLineEntryIndexes.at(-1)).toBe(1);
	});
});
