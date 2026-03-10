// src/feed/__tests__/mapper.test.ts
import {describe, it, expect, afterEach} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createFeedMapper} from '../mapper';
import type {RuntimeEvent} from '../../runtime/types';
import type {FeedEvent} from '../types';
import {mapLegacyHookNameToRuntimeKind} from '../../runtime/events';

function makeRuntimeEvent(
	hookName: string,
	extra?: Partial<RuntimeEvent>,
): RuntimeEvent {
	const kind = extra?.kind ?? mapLegacyHookNameToRuntimeKind(hookName);
	const payload = {
		hook_event_name: hookName,
		session_id: 'sess-1',
		transcript_path: '/tmp/t.jsonl',
		cwd: '/project',
		...(typeof extra?.payload === 'object' && extra.payload !== null
			? (extra.payload as Record<string, unknown>)
			: {}),
	};
	return {
		id: `req-${Date.now()}`,
		timestamp: Date.now(),
		kind,
		data:
			extra?.data ??
			(kind === 'unknown' ? {source_event_name: hookName, payload} : payload),
		hookName,
		sessionId: 'sess-1',
		context: {cwd: '/project', transcriptPath: '/tmp/t.jsonl'},
		interaction: {expectsDecision: false},
		payload,
		...extra,
	};
}

describe('FeedMapper', () => {
	describe('session lifecycle', () => {
		it('maps SessionStart to session.start', () => {
			const mapper = createFeedMapper();
			const event = makeRuntimeEvent('SessionStart', {
				payload: {
					hook_event_name: 'SessionStart',
					session_id: 'sess-1',
					transcript_path: '/tmp/t.jsonl',
					cwd: '/project',
					source: 'startup',
				},
			});

			const results = mapper.mapEvent(event);
			const sessionStart = results.find(r => r.kind === 'session.start');
			expect(sessionStart).toBeDefined();
			expect(sessionStart!.data.source).toBe('startup');
			expect(sessionStart!.session_id).toBe('sess-1');
			expect(sessionStart!.actor_id).toBe('system');
		});

		it('maps SessionEnd to session.end + run.end when run is active', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('SessionStart', {
					payload: {
						hook_event_name: 'SessionStart',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						source: 'resume',
					},
				}),
			);

			const results = mapper.mapEvent(
				makeRuntimeEvent('SessionEnd', {
					payload: {
						hook_event_name: 'SessionEnd',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						reason: 'clear',
					},
				}),
			);

			expect(results.some(r => r.kind === 'session.end')).toBe(true);
			expect(results.some(r => r.kind === 'run.end')).toBe(true);
		});

		it('maps SessionEnd to session.end without run.end when no active run', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('SessionStart', {
					payload: {
						hook_event_name: 'SessionStart',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						source: 'startup',
					},
				}),
			);

			const results = mapper.mapEvent(
				makeRuntimeEvent('SessionEnd', {
					payload: {
						hook_event_name: 'SessionEnd',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						reason: 'clear',
					},
				}),
			);

			expect(results.some(r => r.kind === 'session.end')).toBe(true);
			expect(results.some(r => r.kind === 'run.end')).toBe(false);
		});
	});

	describe('run lifecycle', () => {
		it('creates implicit run on first event if no active run', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					toolName: 'Bash',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Bash',
						tool_input: {command: 'ls'},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			expect(results.some(r => r.kind === 'run.start')).toBe(true);
			expect(results.some(r => r.kind === 'tool.pre')).toBe(true);
			expect(mapper.getCurrentRun()).not.toBeNull();
		});

		it('creates new run on UserPromptSubmit', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'Fix the bug',
						permission_mode: 'default',
					},
				}),
			);

			const runStart = results.find(r => r.kind === 'run.start');
			expect(runStart).toBeDefined();
			expect(runStart!.data.trigger.type).toBe('user_prompt_submit');

			const userPrompt = results.find(r => r.kind === 'user.prompt');
			expect(userPrompt).toBeDefined();
			expect(userPrompt!.data.prompt).toBe('Fix the bug');
			expect(userPrompt!.actor_id).toBe('user');
		});

		it('emits Codex agent messages when item completion arrives', () => {
			const mapper = createFeedMapper();
			const startResults = mapper.mapEvent(
				makeRuntimeEvent('turn/started', {
					kind: 'turn.start',
					hookName: 'turn/started',
					data: {
						thread_id: 'th-1',
						turn_id: 'turn-1',
						status: 'inProgress',
						prompt: 'Hello Codex',
					},
					payload: {
						threadId: 'th-1',
						turn: {id: 'turn-1', status: 'inProgress'},
					},
				}),
			);

			expect(startResults).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: 'run.start',
						data: expect.objectContaining({
							trigger: expect.objectContaining({type: 'user_prompt_submit'}),
						}),
					}),
					expect.objectContaining({
						kind: 'user.prompt',
						data: expect.objectContaining({prompt: 'Hello Codex'}),
					}),
				]),
			);

			const deltaResults = mapper.mapEvent(
				makeRuntimeEvent('item/agentMessage/delta', {
					kind: 'message.delta',
					hookName: 'item/agentMessage/delta',
					data: {
						thread_id: 'th-1',
						turn_id: 'turn-1',
						item_id: 'msg-1',
						delta: 'Hello from Codex',
					},
					payload: {
						threadId: 'th-1',
						turnId: 'turn-1',
						itemId: 'msg-1',
						delta: 'Hello from Codex',
					},
				}),
			);

			expect(deltaResults).toEqual([]);

			const completeMessageResults = mapper.mapEvent(
				makeRuntimeEvent('item/completed', {
					kind: 'message.complete',
					hookName: 'item/completed',
					data: {
						thread_id: 'th-1',
						turn_id: 'turn-1',
						item_id: 'msg-1',
						message: 'Hello from Codex',
						phase: 'commentary',
					},
					payload: {
						threadId: 'th-1',
						turnId: 'turn-1',
						item: {
							id: 'msg-1',
							type: 'agentMessage',
							text: 'Hello from Codex',
							phase: 'commentary',
						},
					},
				}),
			);

			expect(completeMessageResults).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: 'agent.message',
						data: expect.objectContaining({message: 'Hello from Codex'}),
					}),
				]),
			);

			const completeResults = mapper.mapEvent(
				makeRuntimeEvent('turn/completed', {
					kind: 'turn.complete',
					hookName: 'turn/completed',
					data: {thread_id: 'th-1', turn_id: 'turn-1', status: 'completed'},
					payload: {
						threadId: 'th-1',
						turn: {id: 'turn-1', status: 'completed'},
					},
				}),
			);

			expect(completeResults.some(r => r.kind === 'stop.request')).toBe(true);
			expect(completeResults.some(r => r.kind === 'run.end')).toBe(true);
			expect(completeResults.some(r => r.kind === 'agent.message')).toBe(false);
			expect(mapper.getCurrentRun()).toBeNull();
		});

		it('does not create a phantom run on turn.complete without a turn.start', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('turn/completed', {
					kind: 'turn.complete',
					hookName: 'turn/completed',
					data: {thread_id: 'th-1', turn_id: 'turn-1', status: 'completed'},
					payload: {
						threadId: 'th-1',
						turn: {id: 'turn-1', status: 'completed'},
					},
				}),
			);

			expect(results).toEqual([]);
			expect(mapper.getCurrentRun()).toBeNull();
		});

		it('accumulates tool.delta output by tool_use_id', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('item/started', {
					kind: 'tool.pre',
					hookName: 'item/started',
					toolName: 'Bash',
					toolUseId: 'cmd-1',
					data: {
						tool_name: 'Bash',
						tool_input: {command: 'npm test'},
						tool_use_id: 'cmd-1',
					},
				}),
			);

			const first = mapper.mapEvent(
				makeRuntimeEvent('item/commandExecution/outputDelta', {
					kind: 'tool.delta',
					hookName: 'item/commandExecution/outputDelta',
					toolName: 'Bash',
					toolUseId: 'cmd-1',
					data: {
						tool_name: 'Bash',
						tool_input: {},
						tool_use_id: 'cmd-1',
						delta: 'line 1\n',
					},
				}),
			);
			const second = mapper.mapEvent(
				makeRuntimeEvent('item/commandExecution/outputDelta', {
					kind: 'tool.delta',
					hookName: 'item/commandExecution/outputDelta',
					toolName: 'Bash',
					toolUseId: 'cmd-1',
					data: {
						tool_name: 'Bash',
						tool_input: {},
						tool_use_id: 'cmd-1',
						delta: 'line 2\n',
					},
				}),
			);

			expect(first.find(r => r.kind === 'tool.delta')?.data).toEqual(
				expect.objectContaining({
					tool_use_id: 'cmd-1',
					delta: 'line 1\n',
				}),
			);
			expect(second.find(r => r.kind === 'tool.delta')?.data).toEqual(
				expect.objectContaining({
					tool_use_id: 'cmd-1',
					delta: 'line 1\nline 2\n',
				}),
			);
		});

		it('truncates oversized cumulative tool.delta output', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('item/started', {
					kind: 'tool.pre',
					hookName: 'item/started',
					toolName: 'Bash',
					toolUseId: 'cmd-big',
					data: {
						tool_name: 'Bash',
						tool_input: {command: 'npm test'},
						tool_use_id: 'cmd-big',
					},
				}),
			);

			const largeChunk = 'x'.repeat(70_000);
			const results = mapper.mapEvent(
				makeRuntimeEvent('item/commandExecution/outputDelta', {
					kind: 'tool.delta',
					hookName: 'item/commandExecution/outputDelta',
					toolName: 'Bash',
					toolUseId: 'cmd-big',
					data: {
						tool_name: 'Bash',
						tool_input: {},
						tool_use_id: 'cmd-big',
						delta: largeChunk,
					},
				}),
			);

			const deltaEvent = results.find(r => r.kind === 'tool.delta');
			expect(deltaEvent).toBeDefined();
			expect(deltaEvent!.data).toEqual(
				expect.objectContaining({
					tool_use_id: 'cmd-big',
				}),
			);
			const deltaText = (deltaEvent!.data as {delta: string}).delta;
			expect(deltaText.startsWith('[streaming output truncated')).toBe(true);
			expect(deltaText.length).toBeLessThan(70_000);
		});
	});

	describe('tool mapping', () => {
		it('tool events without active subagent are attributed to agent:root', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					toolName: 'Read',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/a.ts'},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const toolPre = results.find(r => r.kind === 'tool.pre');
			expect(toolPre!.actor_id).toBe('agent:root');
		});

		it('maps PreToolUse to tool.pre', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					toolName: 'Read',
					toolUseId: 'tu-1',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/foo.ts'},
						tool_use_id: 'tu-1',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			const toolPre = results.find(r => r.kind === 'tool.pre');
			expect(toolPre).toBeDefined();
			expect(toolPre!.data.tool_name).toBe('Read');
			expect(toolPre!.cause?.tool_use_id).toBe('tu-1');
		});

		it('maps PostToolUse to tool.post with parent correlation', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					id: 'req-pre',
					toolName: 'Read',
					toolUseId: 'tu-1',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/foo.ts'},
						tool_use_id: 'tu-1',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			const results = mapper.mapEvent(
				makeRuntimeEvent('PostToolUse', {
					toolName: 'Read',
					toolUseId: 'tu-1',
					payload: {
						hook_event_name: 'PostToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/foo.ts'},
						tool_use_id: 'tu-1',
						tool_response: {content: 'file contents'},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			const toolPost = results.find(r => r.kind === 'tool.post');
			expect(toolPost).toBeDefined();
			expect(toolPost!.cause?.parent_event_id).toBeDefined();
		});

		it('maps PostToolUseFailure to tool.failure', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('PostToolUseFailure', {
					toolName: 'Bash',
					payload: {
						hook_event_name: 'PostToolUseFailure',
						tool_name: 'Bash',
						tool_input: {command: 'bad'},
						error: 'exit code 1',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			const failure = results.find(r => r.kind === 'tool.failure');
			expect(failure).toBeDefined();
			expect(failure!.data.error).toBe('exit code 1');
			expect(failure!.level).toBe('error');
		});
	});

	describe('permission mapping', () => {
		it('maps PermissionRequest to permission.request', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('PermissionRequest', {
					toolName: 'Bash',
					payload: {
						hook_event_name: 'PermissionRequest',
						tool_name: 'Bash',
						tool_input: {command: 'rm -rf /'},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			const perm = results.find(r => r.kind === 'permission.request');
			expect(perm).toBeDefined();
			expect(perm!.data.tool_name).toBe('Bash');
			expect(perm!.actor_id).toBe('system');
		});
	});

	describe('subagent mapping', () => {
		it('maps SubagentStart and registers actor', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('SubagentStart', {
					agentId: 'agent-1',
					agentType: 'Explore',
					payload: {
						hook_event_name: 'SubagentStart',
						agent_id: 'agent-1',
						agent_type: 'Explore',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			expect(results.some(r => r.kind === 'subagent.start')).toBe(true);
			const actors = mapper.getActors();
			expect(actors.some(a => a.actor_id === 'subagent:agent-1')).toBe(true);
		});
	});

	describe('unknown events', () => {
		it('maps unknown hook events to unknown.hook', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('FutureEvent', {
					payload: {
						hook_event_name: 'FutureEvent',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						custom_field: true,
					},
				}),
			);

			const unknown = results.find(r => r.kind === 'unknown.hook');
			expect(unknown).toBeDefined();
			expect(unknown!.data.hook_event_name).toBe('FutureEvent');
		});
	});

	describe('decision mapping', () => {
		it('maps permission decision to permission.decision', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('PermissionRequest', {
					id: 'req-perm',
					toolName: 'Bash',
					payload: {
						hook_event_name: 'PermissionRequest',
						tool_name: 'Bash',
						tool_input: {},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			const decision = mapper.mapDecision('req-perm', {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			});

			expect(decision).not.toBeNull();
			expect(decision!.kind).toBe('permission.decision');
			expect(decision!.data.decision_type).toBe('allow');
			expect(decision!.cause?.parent_event_id).toBeDefined();
		});

		it('maps timeout decision to no_opinion', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('PermissionRequest', {
					id: 'req-timeout',
					toolName: 'Bash',
					payload: {
						hook_event_name: 'PermissionRequest',
						tool_name: 'Bash',
						tool_input: {},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			const decision = mapper.mapDecision('req-timeout', {
				type: 'passthrough',
				source: 'timeout',
			});

			expect(decision).not.toBeNull();
			expect(decision!.kind).toBe('permission.decision');
			expect(decision!.data.decision_type).toBe('no_opinion');
			expect(decision!.data.reason).toBe('timeout');
		});

		it('maps Stop to stop.request with actor agent:root and no scope', () => {
			const mapper = createFeedMapper();
			const stopEvent = makeRuntimeEvent('Stop', {
				id: 'req-stop',
				payload: {
					hook_event_name: 'Stop',
					session_id: 'sess-1',
					transcript_path: '/tmp/t.jsonl',
					cwd: '/project',
					stop_hook_active: false,
				},
			});
			const results = mapper.mapEvent(stopEvent);
			const stop = results.find(r => r.kind === 'stop.request');
			expect(stop).toBeDefined();
			expect(stop!.actor_id).toBe('agent:root');
			expect(stop!.data).not.toHaveProperty('scope');
			expect(stop!.data).not.toHaveProperty('agent_id');
			expect(stop!.data).not.toHaveProperty('agent_type');
		});

		it('emits stop.decision block from command hook schema (decision:"block")', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('Stop', {
					id: 'req-stop-cmd',
					payload: {
						hook_event_name: 'Stop',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						stop_hook_active: false,
					},
				}),
			);

			const decision = mapper.mapDecision('req-stop-cmd', {
				type: 'json',
				source: 'rule',
				data: {decision: 'block', reason: 'Tests not passing'},
			});

			expect(decision).not.toBeNull();
			expect(decision!.kind).toBe('stop.decision');
			expect(decision!.data.decision_type).toBe('block');
			expect(decision!.data.reason).toBe('Tests not passing');
		});

		it('emits stop.decision block from prompt/agent hook schema (ok:false)', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('Stop', {
					id: 'req-stop-prompt',
					payload: {
						hook_event_name: 'Stop',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						stop_hook_active: false,
					},
				}),
			);

			const decision = mapper.mapDecision('req-stop-prompt', {
				type: 'json',
				source: 'rule',
				data: {ok: false, reason: 'Lint errors remain'},
			});

			expect(decision).not.toBeNull();
			expect(decision!.kind).toBe('stop.decision');
			expect(decision!.data.decision_type).toBe('block');
			expect(decision!.data.reason).toBe('Lint errors remain');
		});

		it('emits stop.decision with no_opinion on timeout', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('Stop', {
					id: 'req-stop-timeout',
					payload: {
						hook_event_name: 'Stop',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						stop_hook_active: false,
					},
				}),
			);

			const decision = mapper.mapDecision('req-stop-timeout', {
				type: 'passthrough',
				source: 'timeout',
			});

			expect(decision).not.toBeNull();
			expect(decision!.kind).toBe('stop.decision');
			expect(decision!.data.decision_type).toBe('no_opinion');
		});

		it('returns null for decision on unknown event', () => {
			const mapper = createFeedMapper();
			const result = mapper.mapDecision('nonexistent', {
				type: 'passthrough',
				source: 'timeout',
			});
			expect(result).toBeNull();
		});
	});

	describe('bug fixes', () => {
		it('SessionStart(startup) does NOT emit run.start', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('SessionStart', {
					payload: {
						hook_event_name: 'SessionStart',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						source: 'startup',
					},
				}),
			);

			expect(results.some(r => r.kind === 'run.start')).toBe(false);
			expect(results.some(r => r.kind === 'session.start')).toBe(true);
			expect(mapper.getCurrentRun()).toBeNull();
		});

		it('SessionStart(resume) DOES emit run.start', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('SessionStart', {
					payload: {
						hook_event_name: 'SessionStart',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						source: 'resume',
					},
				}),
			);

			expect(results.some(r => r.kind === 'run.start')).toBe(true);
			expect(results.some(r => r.kind === 'session.start')).toBe(true);
			expect(mapper.getCurrentRun()).not.toBeNull();
		});

		it('SessionStart(clear) emits run.start', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('SessionStart', {
					payload: {
						hook_event_name: 'SessionStart',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						source: 'clear',
					},
				}),
			);
			expect(results.some(r => r.kind === 'run.start')).toBe(true);
			expect(mapper.getCurrentRun()).not.toBeNull();
		});

		it('SessionStart(compact) emits run.start', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('SessionStart', {
					payload: {
						hook_event_name: 'SessionStart',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						source: 'compact',
					},
				}),
			);
			expect(results.some(r => r.kind === 'run.start')).toBe(true);
			expect(mapper.getCurrentRun()).not.toBeNull();
		});

		it('correlation indexes are cleared on run boundaries', () => {
			const mapper = createFeedMapper();

			// Run 1: PreToolUse with tu-1
			mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					id: 'req-run1-pre',
					toolName: 'Read',
					toolUseId: 'tu-1',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/a.ts'},
						tool_use_id: 'tu-1',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			// New run via UserPromptSubmit (closes run 1, opens run 2)
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'next',
					},
				}),
			);

			// Run 2: PostToolUse with same tu-1 should NOT correlate to run 1's PreToolUse
			const results = mapper.mapEvent(
				makeRuntimeEvent('PostToolUse', {
					toolName: 'Read',
					toolUseId: 'tu-1',
					payload: {
						hook_event_name: 'PostToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/a.ts'},
						tool_use_id: 'tu-1',
						tool_response: {content: 'x'},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			const toolPost = results.find(r => r.kind === 'tool.post');
			expect(toolPost).toBeDefined();
			// parent_event_id should be undefined — the PreToolUse was in a different run
			expect(toolPost!.cause?.parent_event_id).toBeUndefined();
		});
	});

	describe('ui.collapsed_default', () => {
		it('sets collapsed_default on setup events', () => {
			const mapper = createFeedMapper();
			const events = mapper.mapEvent(
				makeRuntimeEvent('Setup', {
					payload: {
						hook_event_name: 'Setup',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						trigger: 'init',
					},
				}),
			);
			const setupEvent = events.find(e => e.kind === 'setup');
			expect(setupEvent?.ui?.collapsed_default).toBe(true);
		});

		it('sets collapsed_default on compact.pre events', () => {
			const mapper = createFeedMapper();
			const events = mapper.mapEvent(
				makeRuntimeEvent('PreCompact', {
					payload: {
						hook_event_name: 'PreCompact',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						trigger: 'auto',
					},
				}),
			);
			const compactEvent = events.find(e => e.kind === 'compact.pre');
			expect(compactEvent?.ui?.collapsed_default).toBe(true);
		});

		it('sets collapsed_default on unknown.hook events', () => {
			const mapper = createFeedMapper();
			const events = mapper.mapEvent(
				makeRuntimeEvent('SomeFutureHook', {
					payload: {
						hook_event_name: 'SomeFutureHook',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const unknownEvent = events.find(e => e.kind === 'unknown.hook');
			expect(unknownEvent?.ui?.collapsed_default).toBe(true);
		});
	});

	describe('last_assistant_message passthrough', () => {
		it('passes last_assistant_message through Stop to StopRequestData', () => {
			const mapper = createFeedMapper();
			const events = mapper.mapEvent(
				makeRuntimeEvent('Stop', {
					payload: {
						hook_event_name: 'Stop',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						stop_hook_active: false,
						last_assistant_message: 'Here is my answer.',
					},
				}),
			);
			const stopEvt = events.find(e => e.kind === 'stop.request');
			expect(stopEvt).toBeDefined();
			expect(stopEvt!.data.last_assistant_message).toBe('Here is my answer.');
		});

		it('passes last_assistant_message through SubagentStop to SubagentStopData', () => {
			const mapper = createFeedMapper();
			const events = mapper.mapEvent(
				makeRuntimeEvent('SubagentStop', {
					agentId: 'agent-1',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStop',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						agent_id: 'agent-1',
						agent_type: 'task',
						stop_hook_active: false,
						last_assistant_message: 'Subagent done.',
					},
				}),
			);
			const stopEvt = events.find(e => e.kind === 'subagent.stop');
			expect(stopEvt).toBeDefined();
			expect(stopEvt!.data.last_assistant_message).toBe('Subagent done.');
		});

		it('omits last_assistant_message when not in payload', () => {
			const mapper = createFeedMapper();
			const events = mapper.mapEvent(
				makeRuntimeEvent('Stop', {
					payload: {
						hook_event_name: 'Stop',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						stop_hook_active: false,
					},
				}),
			);
			const stopEvt = events.find(e => e.kind === 'stop.request');
			expect(stopEvt!.data.last_assistant_message).toBeUndefined();
		});
	});

	describe('new hook events', () => {
		it('maps TeammateIdle to teammate.idle', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('TeammateIdle', {
					payload: {
						hook_event_name: 'TeammateIdle',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						teammate_name: 'researcher',
						team_name: 'my-project',
					},
				}),
			);
			const evt = results.find(r => r.kind === 'teammate.idle');
			expect(evt).toBeDefined();
			expect(evt!.data.teammate_name).toBe('researcher');
			expect(evt!.data.team_name).toBe('my-project');
			expect(evt!.actor_id).toBe('system');
			expect(evt!.ui?.collapsed_default).toBe(true);
		});

		it('maps TaskCompleted to task.completed', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('TaskCompleted', {
					payload: {
						hook_event_name: 'TaskCompleted',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						task_id: 'task-001',
						task_subject: 'Implement auth',
						task_description: 'Add login endpoints',
						teammate_name: 'implementer',
						team_name: 'my-project',
					},
				}),
			);
			const evt = results.find(r => r.kind === 'task.completed');
			expect(evt).toBeDefined();
			expect(evt!.data.task_id).toBe('task-001');
			expect(evt!.data.task_subject).toBe('Implement auth');
			expect(evt!.actor_id).toBe('system');
		});

		it('maps ConfigChange to config.change', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('ConfigChange', {
					payload: {
						hook_event_name: 'ConfigChange',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						source: 'project_settings',
						file_path: '/project/.claude/settings.json',
					},
				}),
			);
			const evt = results.find(r => r.kind === 'config.change');
			expect(evt).toBeDefined();
			expect(evt!.data.source).toBe('project_settings');
			expect(evt!.data.file_path).toBe('/project/.claude/settings.json');
			expect(evt!.actor_id).toBe('system');
		});

		it('maps ConfigChange with policy_settings source (note: cannot be blocked per docs)', () => {
			const mapper = createFeedMapper();
			const results = mapper.mapEvent(
				makeRuntimeEvent('ConfigChange', {
					payload: {
						hook_event_name: 'ConfigChange',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						source: 'policy_settings',
					},
				}),
			);
			const evt = results.find(r => r.kind === 'config.change');
			expect(evt).toBeDefined();
			expect(evt!.data.source).toBe('policy_settings');
			expect(evt!.ui?.badge).toBeUndefined();
		});
	});

	describe('subagent tool attribution', () => {
		it('attributes tool events between SubagentStart and SubagentStop to the subagent', () => {
			const mapper = createFeedMapper();
			// Start a run
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'do stuff',
					},
				}),
			);
			// Start subagent
			mapper.mapEvent(
				makeRuntimeEvent('SubagentStart', {
					agentId: 'sa-1',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStart',
						agent_id: 'sa-1',
						agent_type: 'task',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			// PreToolUse while subagent active
			const results = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					toolName: 'Read',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/a.ts'},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const toolPre = results.find(r => r.kind === 'tool.pre');
			expect(toolPre!.actor_id).toBe('subagent:sa-1');
		});

		it('attributes PostToolUse to the subagent while active', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'do stuff',
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent('SubagentStart', {
					agentId: 'sa-1',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStart',
						agent_id: 'sa-1',
						agent_type: 'task',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const results = mapper.mapEvent(
				makeRuntimeEvent('PostToolUse', {
					toolName: 'Read',
					payload: {
						hook_event_name: 'PostToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/a.ts'},
						tool_response: {content: 'x'},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const toolPost = results.find(r => r.kind === 'tool.post');
			expect(toolPost!.actor_id).toBe('subagent:sa-1');
		});

		it('attributes PostToolUseFailure to the subagent while active', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'do stuff',
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent('SubagentStart', {
					agentId: 'sa-1',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStart',
						agent_id: 'sa-1',
						agent_type: 'task',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const results = mapper.mapEvent(
				makeRuntimeEvent('PostToolUseFailure', {
					toolName: 'Bash',
					payload: {
						hook_event_name: 'PostToolUseFailure',
						tool_name: 'Bash',
						tool_input: {command: 'bad'},
						error: 'fail',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const failure = results.find(r => r.kind === 'tool.failure');
			expect(failure!.actor_id).toBe('subagent:sa-1');
		});

		it('reverts to agent:root after SubagentStop', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'do stuff',
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent('SubagentStart', {
					agentId: 'sa-1',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStart',
						agent_id: 'sa-1',
						agent_type: 'task',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent('SubagentStop', {
					agentId: 'sa-1',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStop',
						agent_id: 'sa-1',
						agent_type: 'task',
						stop_hook_active: false,
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const results = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					toolName: 'Read',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/a.ts'},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const toolPre = results.find(r => r.kind === 'tool.pre');
			expect(toolPre!.actor_id).toBe('agent:root');
		});

		it('handles nested subagents with stack (LIFO)', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'do stuff',
					},
				}),
			);
			// Start outer
			mapper.mapEvent(
				makeRuntimeEvent('SubagentStart', {
					agentId: 'outer',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStart',
						agent_id: 'outer',
						agent_type: 'task',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			// Start inner
			mapper.mapEvent(
				makeRuntimeEvent('SubagentStart', {
					agentId: 'inner',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStart',
						agent_id: 'inner',
						agent_type: 'task',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			// Tool while inner active -> inner
			let results = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					toolName: 'Read',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/a.ts'},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			expect(results.find(r => r.kind === 'tool.pre')!.actor_id).toBe(
				'subagent:inner',
			);
			// Stop inner
			mapper.mapEvent(
				makeRuntimeEvent('SubagentStop', {
					agentId: 'inner',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStop',
						agent_id: 'inner',
						agent_type: 'task',
						stop_hook_active: false,
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			// Tool after inner stopped -> outer
			results = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					toolName: 'Read',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/b.ts'},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			expect(results.find(r => r.kind === 'tool.pre')!.actor_id).toBe(
				'subagent:outer',
			);
		});

		it('clears active subagent stack on run boundaries', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'first',
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent('SubagentStart', {
					agentId: 'sa-1',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStart',
						agent_id: 'sa-1',
						agent_type: 'task',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			// New run boundary
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'second',
					},
				}),
			);
			// Tool after run boundary -> agent:root
			const results = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					toolName: 'Read',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Read',
						tool_input: {file_path: '/a.ts'},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const toolPre = results.find(r => r.kind === 'tool.pre');
			expect(toolPre!.actor_id).toBe('agent:root');
		});
	});

	describe('agent.message enrichment', () => {
		it('generates agent.message from Stop with last_assistant_message', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'do stuff',
					},
				}),
			);
			const results = mapper.mapEvent(
				makeRuntimeEvent('Stop', {
					payload: {
						hook_event_name: 'Stop',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						stop_hook_active: false,
						last_assistant_message: 'Here is the final answer.',
					},
				}),
			);
			const agentMsg = results.find(r => r.kind === 'agent.message');
			expect(agentMsg).toBeDefined();
			expect(agentMsg!.data.message).toBe('Here is the final answer.');
			expect(agentMsg!.data.source).toBe('hook');
			expect(agentMsg!.data.scope).toBe('root');
			expect(agentMsg!.actor_id).toBe('agent:root');
			expect(Number.isInteger(agentMsg!.seq)).toBe(true);
			// Parent should be the stop.request event
			const stopEvt = results.find(r => r.kind === 'stop.request');
			expect(agentMsg!.cause?.parent_event_id).toBe(stopEvt!.event_id);
		});

		it('does NOT generate agent.message when no last_assistant_message', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'do stuff',
					},
				}),
			);
			const results = mapper.mapEvent(
				makeRuntimeEvent('Stop', {
					payload: {
						hook_event_name: 'Stop',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						stop_hook_active: false,
					},
				}),
			);
			expect(results.find(r => r.kind === 'agent.message')).toBeUndefined();
		});

		it('generates agent.message from SubagentStop with last_assistant_message', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						prompt: 'do stuff',
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent('SubagentStart', {
					agentId: 'sa-1',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStart',
						agent_id: 'sa-1',
						agent_type: 'task',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const results = mapper.mapEvent(
				makeRuntimeEvent('SubagentStop', {
					agentId: 'sa-1',
					agentType: 'task',
					payload: {
						hook_event_name: 'SubagentStop',
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
						agent_id: 'sa-1',
						agent_type: 'task',
						stop_hook_active: false,
						last_assistant_message: 'Subagent result text',
					},
				}),
			);
			const agentMsg = results.find(r => r.kind === 'agent.message');
			expect(agentMsg).toBeDefined();
			expect(agentMsg!.data.message).toBe('Subagent result text');
			expect(agentMsg!.data.scope).toBe('subagent');
			expect(agentMsg!.actor_id).toBe('subagent:sa-1');
			expect(Number.isInteger(agentMsg!.seq)).toBe(true);
			const subStopEvt = results.find(r => r.kind === 'subagent.stop');
			expect(agentMsg!.cause?.parent_event_id).toBe(subStopEvt!.event_id);
		});
	});

	describe('transcript-based agent.message extraction', () => {
		const tmpFiles: string[] = [];

		afterEach(() => {
			for (const f of tmpFiles) {
				try {
					fs.unlinkSync(f);
					fs.rmdirSync(path.dirname(f));
				} catch {
					/* ignore */
				}
			}
			tmpFiles.length = 0;
		});

		function makeTmpTranscript(lines: unknown[]): string {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-transcript-'));
			const fp = path.join(dir, 'transcript.jsonl');
			fs.writeFileSync(fp, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
			tmpFiles.push(fp);
			return fp;
		}

		it('extracts intermediate assistant messages from transcript on PreToolUse', () => {
			// Start with just the user message in transcript
			const transcriptPath = makeTmpTranscript([
				{type: 'user', message: {role: 'user', content: 'hello'}},
			]);

			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: transcriptPath,
						cwd: '/project',
						prompt: 'hello',
					},
					context: {cwd: '/project', transcriptPath},
				}),
			);

			// Simulate Claude writing text then calling a tool — append assistant entry
			fs.appendFileSync(
				transcriptPath,
				JSON.stringify({
					type: 'assistant',
					message: {role: 'assistant', content: 'Let me read that file.'},
				}) + '\n',
			);

			const results = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					payload: {
						hook_event_name: 'PreToolUse',
						session_id: 'sess-1',
						transcript_path: transcriptPath,
						cwd: '/project',
						tool_name: 'Read',
						tool_input: {},
					},
					context: {cwd: '/project', transcriptPath},
				}),
			);

			const agentMsgs = results.filter(r => r.kind === 'agent.message');
			expect(agentMsgs).toHaveLength(1);
			expect(agentMsgs[0]!.data.message).toBe('Let me read that file.');
			expect(agentMsgs[0]!.data.source).toBe('transcript');
			expect(agentMsgs[0]!.data.scope).toBe('root');
		});

		it('deduplicates via byte offset — same text not emitted twice', () => {
			const transcriptPath = makeTmpTranscript([
				{
					type: 'assistant',
					message: {role: 'assistant', content: 'First message'},
				},
			]);

			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: transcriptPath,
						cwd: '/project',
						prompt: 'go',
					},
					context: {cwd: '/project', transcriptPath},
				}),
			);

			const r1 = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					payload: {
						hook_event_name: 'PreToolUse',
						session_id: 'sess-1',
						transcript_path: transcriptPath,
						cwd: '/project',
						tool_name: 'Read',
						tool_input: {},
					},
					context: {cwd: '/project', transcriptPath},
				}),
			);
			expect(r1.filter(r => r.kind === 'agent.message')).toHaveLength(0);
			// First read happened on UserPromptSubmit — second read should have nothing new
		});

		it('falls back to last_assistant_message on stop when transcript is missing', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent('UserPromptSubmit', {
					payload: {
						hook_event_name: 'UserPromptSubmit',
						session_id: 'sess-1',
						transcript_path: '/nonexistent.jsonl',
						cwd: '/project',
						prompt: 'go',
					},
					context: {cwd: '/project', transcriptPath: '/nonexistent.jsonl'},
				}),
			);
			const results = mapper.mapEvent(
				makeRuntimeEvent('Stop', {
					payload: {
						hook_event_name: 'Stop',
						session_id: 'sess-1',
						transcript_path: '/nonexistent.jsonl',
						cwd: '/project',
						stop_hook_active: false,
						last_assistant_message: 'Fallback text',
					},
					context: {cwd: '/project', transcriptPath: '/nonexistent.jsonl'},
				}),
			);
			const agentMsg = results.find(r => r.kind === 'agent.message');
			expect(agentMsg).toBeDefined();
			expect(agentMsg!.data.message).toBe('Fallback text');
			expect(agentMsg!.data.source).toBe('hook');
		});
	});

	describe('bootstrap from stored session', () => {
		it('rebuilds currentRun from stored events with open run', () => {
			const bootstrap: import('../bootstrap').MapperBootstrap = {
				adapterSessionIds: ['sess-1'],
				createdAt: 1000,
				feedEvents: [
					{
						event_id: 'sess-1:R1:E1',
						seq: 1,
						ts: 1000,
						session_id: 'sess-1',
						run_id: 'sess-1:R1',
						kind: 'run.start',
						level: 'info',
						actor_id: 'system',
						title: 'Run started',
						data: {
							trigger: {type: 'user_prompt_submit', prompt_preview: 'fix bug'},
						},
					},
					{
						event_id: 'sess-1:R1:E2',
						seq: 2,
						ts: 1100,
						session_id: 'sess-1',
						run_id: 'sess-1:R1',
						kind: 'tool.pre',
						level: 'info',
						actor_id: 'agent:root',
						title: 'Read',
						data: {tool_name: 'Read', tool_input: {file_path: '/a.ts'}},
					},
					{
						event_id: 'sess-1:R1:E3',
						seq: 3,
						ts: 1200,
						session_id: 'sess-1',
						run_id: 'sess-1:R1',
						kind: 'tool.pre',
						level: 'info',
						actor_id: 'agent:root',
						title: 'Bash',
						data: {tool_name: 'Bash', tool_input: {command: 'ls'}},
					},
					{
						event_id: 'sess-1:R1:E4',
						seq: 4,
						ts: 1300,
						session_id: 'sess-1',
						run_id: 'sess-1:R1',
						kind: 'permission.request',
						level: 'info',
						actor_id: 'system',
						title: 'Permission',
						data: {tool_name: 'Bash', tool_input: {}},
					},
				] as FeedEvent[],
			};

			const mapper = createFeedMapper(bootstrap);
			const run = mapper.getCurrentRun();
			expect(run).not.toBeNull();
			expect(run!.run_id).toBe('sess-1:R1');
			expect(run!.status).toBe('running');
			expect(run!.counters.tool_uses).toBe(2);
			expect(run!.counters.permission_requests).toBe(1);
			expect(run!.trigger.type).toBe('user_prompt_submit');
		});

		it('does NOT rebuild currentRun when last run is closed', () => {
			const bootstrap: import('../bootstrap').MapperBootstrap = {
				adapterSessionIds: ['sess-1'],
				createdAt: 1000,
				feedEvents: [
					{
						event_id: 'sess-1:R1:E1',
						seq: 1,
						ts: 1000,
						session_id: 'sess-1',
						run_id: 'sess-1:R1',
						kind: 'run.start',
						level: 'info',
						actor_id: 'system',
						title: 'Run started',
						data: {trigger: {type: 'user_prompt_submit'}},
					},
					{
						event_id: 'sess-1:R1:E2',
						seq: 2,
						ts: 2000,
						session_id: 'sess-1',
						run_id: 'sess-1:R1',
						kind: 'run.end',
						level: 'info',
						actor_id: 'system',
						title: 'Run ended',
						data: {status: 'completed', counters: {}},
					},
				] as FeedEvent[],
			};

			const mapper = createFeedMapper(bootstrap);
			expect(mapper.getCurrentRun()).toBeNull();
		});
	});

	describe('seq numbering', () => {
		it('assigns monotonically increasing seq within a run', () => {
			const mapper = createFeedMapper();
			const r1 = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					id: 'req-1',
					toolName: 'Bash',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Bash',
						tool_input: {},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);
			const r2 = mapper.mapEvent(
				makeRuntimeEvent('PreToolUse', {
					id: 'req-2',
					toolName: 'Read',
					payload: {
						hook_event_name: 'PreToolUse',
						tool_name: 'Read',
						tool_input: {},
						session_id: 'sess-1',
						transcript_path: '/tmp/t.jsonl',
						cwd: '/project',
					},
				}),
			);

			const allEvents = [...r1, ...r2];
			const seqs = allEvents.map(e => e.seq);
			for (let i = 1; i < seqs.length; i++) {
				expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
			}
		});
	});
});
