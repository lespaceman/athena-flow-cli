// src/feed/titleGen.ts
import type {FeedEvent} from './types';
import {getGlyphs} from '../../ui/glyphs/index';

const MAX_TITLE_LEN = 80;

function truncate(s: string, max = MAX_TITLE_LEN): string {
	return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function generateTitle(event: FeedEvent, ascii = false): string {
	const g = getGlyphs(ascii);

	switch (event.kind) {
		case 'session.start':
			return `Session started (${event.data.source})`;
		case 'session.end':
			return `Session ended (${event.data.reason})`;
		case 'run.start':
			return event.data.trigger.prompt_preview
				? truncate(`Run: ${event.data.trigger.prompt_preview}`)
				: 'Run started';
		case 'run.end':
			return `Run ${event.data.status}`;
		case 'user.prompt':
			return truncate(event.data.prompt);
		case 'tool.delta':
			return `${g['tool.gutter']} ${event.data.tool_name} output`;
		case 'tool.pre':
			return `${g['tool.bullet']} ${event.data.tool_name}`;
		case 'tool.post':
			return `${g['tool.gutter']} ${event.data.tool_name} result`;
		case 'tool.failure':
			return truncate(
				`${g['status.blocked']} ${event.data.tool_name} failed: ${event.data.error}`,
			);
		case 'permission.request':
			return `${g['permission.warn']} Permission: ${event.data.tool_name}`;
		case 'permission.decision':
			switch (event.data.decision_type) {
				case 'allow':
					return `${g['task.completed']} Allowed`;
				case 'deny':
					return `${g['status.blocked']} Denied: ${event.data.message}`;
				case 'no_opinion':
					return `${g['permission.timeout']} No opinion: ${event.data.reason ?? 'timeout'}`;
				case 'ask':
					return '? Ask';
				default:
					return '? Permission';
			}
		case 'stop.request':
			return `${g['stop.icon']} Stop requested`;
		case 'stop.decision':
			switch (event.data.decision_type) {
				case 'block':
					return `${g['stop.icon']} Blocked: ${event.data.reason}`;
				case 'allow':
					return `${g['task.completed']} Stop allowed`;
				case 'no_opinion':
					return `${g['permission.timeout']} Stop: no opinion`;
				default:
					return `${g['stop.icon']} Stop decision`;
			}
		case 'subagent.start':
			return `${g['subagent.start']} Subagent: ${event.data.agent_type}`;
		case 'subagent.stop':
			return `${g['subagent.done']} Subagent done: ${event.data.agent_type}`;
		case 'notification':
			return truncate(event.data.message);
		case 'compact.pre':
			return `Compacting context (${event.data.trigger})`;
		case 'setup':
			return `Setup (${event.data.trigger})`;
		case 'teammate.idle':
			return `${g['status.idle']} Teammate idle: ${event.data.teammate_name}`;
		case 'task.completed':
			return truncate(
				`${g['task.completed']} Task completed: ${event.data.task_subject}`,
			);
		case 'config.change':
			return `${g['config.icon']} Config changed: ${event.data.source}`;
		case 'unknown.hook':
			return `? ${event.data.hook_event_name}`;
		case 'todo.add':
			return truncate(`${g['todo.open']} Todo: ${event.data.text}`);
		case 'todo.update':
			return `${g['todo.open']} Todo updated: ${event.data.todo_id}`;
		case 'todo.done':
			return `${g['todo.done']} Todo done: ${event.data.todo_id}`;
		case 'agent.message':
			return event.data.scope === 'subagent'
				? truncate(`${g['message.agent']} Subagent response`)
				: truncate(`${g['message.agent']} Agent response`);
	}
}
