import React from 'react';
import type {FeedEvent} from '../../core/feed/types';
import SessionEndEvent from './SessionEndEvent';
import AskUserQuestionEvent from './AskUserQuestionEvent';
import {TASK_TOOL_NAMES} from '../../core/feed/todo';
import UnifiedToolCallEvent from './UnifiedToolCallEvent';
import TaskAgentEvent from './TaskAgentEvent';
import SubagentStartEvent from './SubagentStartEvent';
import SubagentStopEvent from './SubagentStopEvent';
import SubagentResultEvent from './SubagentResultEvent';
import AgentMessageEvent from './AgentMessageEvent';
import PostToolResult from './PostToolResult';
import GenericHookEvent from './GenericHookEvent';

type Props = {
	event: FeedEvent;
	verbose?: boolean;
	expanded?: boolean;
	parentWidth?: number;
};

export default function HookEvent({
	event,
	verbose,
	expanded,
	parentWidth,
}: Props): React.ReactNode {
	if (
		!verbose &&
		(event.kind === 'session.start' || event.kind === 'user.prompt')
	) {
		return null;
	}

	if (event.kind === 'session.end') {
		return <SessionEndEvent event={event} />;
	}

	if (
		(event.kind === 'tool.pre' && event.data.tool_name === 'AskUserQuestion') ||
		(event.kind === 'permission.request' &&
			event.data.tool_name === 'user_input')
	) {
		return <AskUserQuestionEvent event={event} />;
	}

	if (event.kind === 'tool.pre' && TASK_TOOL_NAMES.has(event.data.tool_name)) {
		return null;
	}

	if (event.kind === 'tool.pre' && event.data.tool_name === 'Task') {
		return <TaskAgentEvent event={event} />;
	}

	if (event.kind === 'tool.pre' || event.kind === 'permission.request') {
		return (
			<UnifiedToolCallEvent
				event={event}
				verbose={verbose}
				expanded={expanded}
				parentWidth={parentWidth}
			/>
		);
	}

	if (
		(event.kind === 'tool.post' || event.kind === 'tool.failure') &&
		event.data.tool_name === 'Task'
	) {
		return <SubagentResultEvent event={event} verbose={verbose} />;
	}

	if (event.kind === 'tool.post' || event.kind === 'tool.failure') {
		return (
			<PostToolResult
				event={event}
				verbose={verbose}
				parentWidth={parentWidth}
			/>
		);
	}

	if (event.kind === 'subagent.start') {
		return <SubagentStartEvent event={event} />;
	}

	if (event.kind === 'subagent.stop') {
		return (
			<SubagentStopEvent
				event={event}
				expanded={expanded}
				parentWidth={parentWidth}
			/>
		);
	}

	if (event.kind === 'agent.message') {
		return (
			<AgentMessageEvent
				event={event}
				expanded={expanded}
				parentWidth={parentWidth}
			/>
		);
	}

	return <GenericHookEvent event={event} verbose={verbose} />;
}
