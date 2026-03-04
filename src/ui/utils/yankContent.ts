import type {TimelineEntry} from '../../core/feed/timeline';
import type {FeedEvent} from '../../core/feed/types';

/**
 * Extract copyable markdown/source content from a timeline entry.
 * Returns raw markdown for text content, JSON for structured data.
 */
export function extractYankContent(entry: TimelineEntry): string {
	const event = entry.feedEvent;
	if (!event) return entry.details || entry.summary;

	switch (event.kind) {
		case 'agent.message':
			return event.data.message;

		case 'user.prompt':
			return event.data.prompt;

		case 'notification':
			return event.data.message;

		case 'tool.pre':
		case 'permission.request':
			// If we have a paired post event, include the response too
			if (entry.pairedPostEvent) {
				if (entry.pairedPostEvent.kind === 'tool.post') {
					return formatToolResponse(entry.pairedPostEvent);
				}
				if (entry.pairedPostEvent.kind === 'tool.failure') {
					return formatToolFailure(entry.pairedPostEvent);
				}
			}
			return formatToolRequest(event);

		case 'tool.post':
			return formatToolResponse(event);

		case 'tool.failure':
			return formatToolFailure(event);

		default:
			return formatDefault(entry, event);
	}
}

function formatToolRequest(
	event: Extract<FeedEvent, {kind: 'tool.pre'} | {kind: 'permission.request'}>,
): string {
	return JSON.stringify(event.data.tool_input, null, 2);
}

function formatToolResponse(
	event: Extract<FeedEvent, {kind: 'tool.post'}>,
): string {
	const response = event.data.tool_response;
	const responseStr =
		typeof response === 'string' ? response : JSON.stringify(response, null, 2);
	return `${JSON.stringify(event.data.tool_input, null, 2)}\n\n---\n\n${responseStr}`;
}

function formatToolFailure(
	event: Extract<FeedEvent, {kind: 'tool.failure'}>,
): string {
	return `${JSON.stringify(event.data.tool_input, null, 2)}\n\n---\n\nERROR: ${event.data.error}`;
}

function formatDefault(_entry: TimelineEntry, event: FeedEvent): string {
	// Subagent stop: extract last assistant message if available
	if (event.kind === 'subagent.stop' && event.data.last_assistant_message) {
		return event.data.last_assistant_message;
	}

	return JSON.stringify(event.data, null, 2);
}
