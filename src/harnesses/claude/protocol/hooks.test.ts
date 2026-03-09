import {describe, it, expect} from 'vitest';
import {
	isValidHookEventEnvelope,
	generateId,
	createPreToolUseDenyResult,
	createAskUserQuestionResult,
	createPermissionRequestAllowResult,
	type HookEventEnvelope,
	type PreToolUseEvent,
	type PermissionRequestEvent,
	type PostToolUseEvent,
	type PostToolUseFailureEvent,
	type NotificationEvent,
	type StopEvent,
	type SubagentStartEvent,
	type SubagentStopEvent,
	type SessionEndEvent,
	type TeammateIdleEvent,
	type TaskCompletedEvent,
	type ConfigChangeEvent,
	type InstructionsLoadedEvent,
	type WorktreeCreateEvent,
	type WorktreeRemoveEvent,
	isPreToolUseEvent,
	isSubagentStartEvent,
	isSubagentStopEvent,
	isToolEvent,
} from './';

// Helper to create base event fields
const createBaseEvent = () => ({
	session_id: 'test-session',
	transcript_path: '/path/to/transcript.jsonl',
	cwd: '/project',
});

describe('hooks types', () => {
	describe('generateId', () => {
		it('should generate unique IDs', () => {
			const id1 = generateId();
			const id2 = generateId();
			expect(id1).not.toBe(id2);
		});

		it('should generate IDs with timestamp prefix for ordering', () => {
			const before = Date.now();
			const id = generateId();
			const after = Date.now();

			const timestamp = Number.parseInt(id.split('-')[0] ?? '0', 10);
			expect(timestamp).toBeGreaterThanOrEqual(before);
			expect(timestamp).toBeLessThanOrEqual(after);
		});
	});

	describe('isValidHookEventEnvelope', () => {
		const validPayload: PreToolUseEvent = {
			...createBaseEvent(),
			hook_event_name: 'PreToolUse',
			tool_name: 'Bash',
			tool_input: {command: 'ls'},
		};

		const validEnvelope: HookEventEnvelope = {
			request_id: 'req-123',
			ts: Date.now(),
			session_id: 'test-session',
			hook_event_name: 'PreToolUse',
			payload: validPayload,
		};

		it('should return true for valid envelope', () => {
			expect(isValidHookEventEnvelope(validEnvelope)).toBe(true);
		});

		it('should return false for null or undefined', () => {
			expect(isValidHookEventEnvelope(null)).toBe(false);
			expect(isValidHookEventEnvelope(undefined)).toBe(false);
		});

		it('should return false for non-object types', () => {
			expect(isValidHookEventEnvelope('string')).toBe(false);
			expect(isValidHookEventEnvelope(123)).toBe(false);
			expect(isValidHookEventEnvelope([])).toBe(false);
		});

		it('should return false for missing or empty request_id', () => {
			expect(
				isValidHookEventEnvelope({...validEnvelope, request_id: undefined}),
			).toBe(false);
			expect(isValidHookEventEnvelope({...validEnvelope, request_id: ''})).toBe(
				false,
			);
		});

		it('should accept unknown hook_event_name for forward compatibility', () => {
			expect(
				isValidHookEventEnvelope({
					...validEnvelope,
					hook_event_name: 'InvalidEvent',
				}),
			).toBe(true);
		});

		it('should reject empty hook_event_name', () => {
			expect(
				isValidHookEventEnvelope({
					...validEnvelope,
					hook_event_name: '',
				}),
			).toBe(false);
		});

		it('should return false for missing or null payload', () => {
			expect(
				isValidHookEventEnvelope({...validEnvelope, payload: undefined}),
			).toBe(false);
			expect(isValidHookEventEnvelope({...validEnvelope, payload: null})).toBe(
				false,
			);
		});

		it('should return false for missing session_id', () => {
			expect(
				isValidHookEventEnvelope({...validEnvelope, session_id: undefined}),
			).toBe(false);
		});

		it('should accept unknown hook event names for forward compatibility', () => {
			expect(
				isValidHookEventEnvelope({
					...validEnvelope,
					hook_event_name: 'FutureEvent',
				}),
			).toBe(true);
		});

		it('should accept all valid hook event names', () => {
			const validNames = [
				'SessionStart',
				'UserPromptSubmit',
				'PreToolUse',
				'PermissionRequest',
				'PostToolUse',
				'PostToolUseFailure',
				'SubagentStart',
				'SubagentStop',
				'Stop',
				'PreCompact',
				'SessionEnd',
				'Notification',
				'Setup',
				'TeammateIdle',
				'TaskCompleted',
				'ConfigChange',
				'InstructionsLoaded',
				'WorktreeCreate',
				'WorktreeRemove',
			];

			for (const name of validNames) {
				const envelope = {...validEnvelope, hook_event_name: name};
				expect(isValidHookEventEnvelope(envelope)).toBe(true);
			}
		});
	});

	describe('result creators', () => {
		it('createPreToolUseDenyResult creates deny structure', () => {
			expect(createPreToolUseDenyResult('Blocked by policy')).toEqual({
				action: 'json_output',
				stdout_json: {
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						permissionDecision: 'deny',
						permissionDecisionReason: 'Blocked by policy',
					},
				},
			});
		});

		it('createAskUserQuestionResult includes answers and additionalContext', () => {
			const answers = {'Which library?': 'React', 'Which style?': 'CSS'};
			const result = createAskUserQuestionResult(answers);
			expect(result).toEqual({
				action: 'json_output',
				stdout_json: {
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						permissionDecision: 'allow',
						updatedInput: {answers},
						additionalContext:
							'User answered via athena-cli:\nQ: Which library?\nA: React\nQ: Which style?\nA: CSS',
					},
				},
			});
		});

		it('createAskUserQuestionResult handles empty answers', () => {
			const result = createAskUserQuestionResult({});
			const output = (result.stdout_json as Record<string, unknown>)
				?.hookSpecificOutput as Record<string, unknown>;
			expect(output.updatedInput).toEqual({answers: {}});
			expect(output.additionalContext).toBe('User answered via athena-cli:\n');
		});

		it('createPermissionRequestAllowResult without updatedInput', () => {
			expect(createPermissionRequestAllowResult()).toEqual({
				action: 'json_output',
				stdout_json: {
					hookSpecificOutput: {
						hookEventName: 'PermissionRequest',
						decision: {behavior: 'allow'},
					},
				},
			});
		});

		it('createPermissionRequestAllowResult with updatedInput', () => {
			const result = createPermissionRequestAllowResult({answers: {q: 'a'}});
			expect(result.stdout_json).toEqual({
				hookSpecificOutput: {
					hookEventName: 'PermissionRequest',
					decision: {
						behavior: 'allow',
						updatedInput: {answers: {q: 'a'}},
					},
				},
			});
		});
	});

	describe('type guards', () => {
		const permissionRequestEvent: PermissionRequestEvent = {
			...createBaseEvent(),
			hook_event_name: 'PermissionRequest',
			tool_name: 'Bash',
			tool_input: {command: 'ls'},
			permission_suggestions: [{type: 'toolAlwaysAllow', tool: 'Bash'}],
		};

		const preToolUseEvent: PreToolUseEvent = {
			...createBaseEvent(),
			hook_event_name: 'PreToolUse',
			tool_name: 'Bash',
			tool_input: {command: 'ls'},
		};

		const postToolUseEvent: PostToolUseEvent = {
			...createBaseEvent(),
			hook_event_name: 'PostToolUse',
			tool_name: 'Bash',
			tool_input: {command: 'ls'},
			tool_response: 'file1.txt\nfile2.txt',
		};

		const postToolUseFailureEvent: PostToolUseFailureEvent = {
			...createBaseEvent(),
			hook_event_name: 'PostToolUseFailure',
			tool_name: 'Bash',
			tool_input: {command: 'ls'},
			error: 'command not found',
		};

		const notificationEvent: NotificationEvent = {
			...createBaseEvent(),
			hook_event_name: 'Notification',
			message: 'Test notification',
			title: 'Permission needed',
			notification_type: 'permission_prompt',
		};

		const stopEvent: StopEvent = {
			...createBaseEvent(),
			hook_event_name: 'Stop',
			stop_hook_active: true,
		};

		const subagentStartEvent: SubagentStartEvent = {
			...createBaseEvent(),
			hook_event_name: 'SubagentStart',
			agent_id: 'agent-123',
			agent_type: 'Explore',
		};

		const subagentStopEvent: SubagentStopEvent = {
			...createBaseEvent(),
			hook_event_name: 'SubagentStop',
			stop_hook_active: false,
			agent_id: 'agent-123',
			agent_type: 'Explore',
		};

		const sessionEndEvent: SessionEndEvent = {
			...createBaseEvent(),
			hook_event_name: 'SessionEnd',
			reason: 'bypass_permissions_disabled',
		};

		const teammateIdleEvent: TeammateIdleEvent = {
			...createBaseEvent(),
			hook_event_name: 'TeammateIdle',
			teammate_name: 'researcher',
			team_name: 'my-project',
		};

		const taskCompletedEvent: TaskCompletedEvent = {
			...createBaseEvent(),
			hook_event_name: 'TaskCompleted',
			task_id: 'task-001',
			task_subject: 'Implement auth',
			task_description: 'Add login and signup endpoints',
			teammate_name: 'implementer',
			team_name: 'my-project',
		};

		const configChangeEvent: ConfigChangeEvent = {
			...createBaseEvent(),
			hook_event_name: 'ConfigChange',
			source: 'project_settings',
			file_path: '/home/user/project/.claude/settings.json',
		};

		const instructionsLoadedEvent: InstructionsLoadedEvent = {
			...createBaseEvent(),
			hook_event_name: 'InstructionsLoaded',
			file_path: '/home/user/project/CLAUDE.md',
			memory_type: 'Project',
			load_reason: 'session_start',
		};

		const worktreeCreateEvent: WorktreeCreateEvent = {
			...createBaseEvent(),
			hook_event_name: 'WorktreeCreate',
			name: 'feature-auth',
		};

		const worktreeRemoveEvent: WorktreeRemoveEvent = {
			...createBaseEvent(),
			hook_event_name: 'WorktreeRemove',
			worktree_path: '/home/user/project/.claude/worktrees/feature-auth',
		};

		it('accepts the refined documented hook shapes', () => {
			expect(permissionRequestEvent.permission_suggestions).toEqual([
				{type: 'toolAlwaysAllow', tool: 'Bash'},
			]);
			expect(notificationEvent.title).toBe('Permission needed');
			expect(sessionEndEvent.reason).toBe('bypass_permissions_disabled');
			expect(teammateIdleEvent.team_name).toBe('my-project');
			expect(taskCompletedEvent.task_id).toBe('task-001');
			expect(configChangeEvent.source).toBe('project_settings');
			expect(instructionsLoadedEvent.load_reason).toBe('session_start');
			expect(worktreeCreateEvent.name).toBe('feature-auth');
			expect(worktreeRemoveEvent.worktree_path).toContain('feature-auth');
		});

		it.each([
			['isPreToolUseEvent', isPreToolUseEvent, preToolUseEvent],
			['isSubagentStartEvent', isSubagentStartEvent, subagentStartEvent],
			['isSubagentStopEvent', isSubagentStopEvent, subagentStopEvent],
		])('%s returns true for matching event', (_name, guard, event) => {
			expect(guard(event)).toBe(true);
		});

		// Test isToolEvent composite guard
		it('isToolEvent returns true for tool-related events', () => {
			expect(isToolEvent(preToolUseEvent)).toBe(true);
			expect(isToolEvent(postToolUseEvent)).toBe(true);
			expect(isToolEvent(postToolUseFailureEvent)).toBe(true);
		});

		it('isToolEvent returns false for non-tool events', () => {
			expect(isToolEvent(notificationEvent)).toBe(false);
			expect(isToolEvent(stopEvent)).toBe(false);
			expect(isToolEvent(subagentStartEvent)).toBe(false);
		});

		it('isSubagentStartEvent distinguishes SubagentStart from SubagentStop', () => {
			expect(isSubagentStartEvent(subagentStartEvent)).toBe(true);
			expect(isSubagentStartEvent(subagentStopEvent)).toBe(false);
		});
	});
});
