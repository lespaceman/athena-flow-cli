import {type TimelineEntry} from './timeline';

type PanelKind = 'user' | 'agent' | 'feed';

export type MessageTab = 'user' | 'agent' | 'both';

const USER_TAGS = new Set(['msg.user', 'prompt']);
const AGENT_TAGS = new Set(['msg.agent', 'agent.msg']);

export function classifyEntry(entry: TimelineEntry): PanelKind {
	if (USER_TAGS.has(entry.opTag)) return 'user';
	if (AGENT_TAGS.has(entry.opTag)) return 'agent';
	return 'feed';
}

export function partitionEntries(entries: TimelineEntry[]): {
	messageEntries: TimelineEntry[];
	feedEntries: TimelineEntry[];
} {
	const messageEntries: TimelineEntry[] = [];
	const feedEntries: TimelineEntry[] = [];
	for (const entry of entries) {
		const kind = classifyEntry(entry);
		if (kind === 'feed') {
			feedEntries.push(entry);
		} else {
			messageEntries.push(entry);
		}
	}
	return {messageEntries, feedEntries};
}

export function filterByTab(
	entries: TimelineEntry[],
	tab: MessageTab,
): TimelineEntry[] {
	if (tab === 'both') return entries;
	const tags = tab === 'user' ? USER_TAGS : AGENT_TAGS;
	return entries.filter(e => tags.has(e.opTag));
}

export function messageText(entry: TimelineEntry): string {
	if (
		entry.details &&
		(entry.opTag === 'msg.user' || entry.opTag === 'msg.agent')
	) {
		return entry.details;
	}
	const event = entry.feedEvent;
	if (event) {
		if (event.kind === 'user.prompt') return String(event.data.prompt);
		if (event.kind === 'agent.message') return String(event.data.message);
	}
	return entry.summary;
}
