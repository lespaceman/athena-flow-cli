import {describe, it, expect} from 'vitest';
import {type FeedEvent, type FeedEventBase} from './types';
import {type Message} from '../../shared/types/common';
import {
	eventOperation,
	eventLabel,
	eventDetail,
	mergedEventLabel,
	eventSummary,
	isEventError,
	isEventExpandable,
	isEntryStable,
	toRunStatus,
	deriveRunTitle,
	mergedEventOperation,
	mergedEventSummary,
	VERBOSE_ONLY_KINDS,
	computeDuplicateActors,
	type TimelineEntry,
} from './timeline';

function base(overrides: Partial<FeedEventBase> = {}): FeedEventBase {
	return {
		event_id: 'e1',
		seq: 1,
		ts: 1000000,
		session_id: 's1',
		run_id: 'R1',
		kind: 'run.start',
		level: 'info',
		actor_id: 'agent:root',
		title: '',
		...overrides,
	};
}

describe('eventOperation', () => {
	it('returns correct op for run.start', () => {
		const ev = {
			...base(),
			kind: 'run.start' as const,
			data: {trigger: {type: 'user_prompt_submit' as const}},
		};
		expect(eventOperation(ev)).toBe('run.start');
	});

	it('returns run.ok for completed run.end', () => {
		const ev = {
			...base({kind: 'run.end'}),
			kind: 'run.end' as const,
			data: {
				status: 'completed' as const,
				counters: {
					tool_uses: 0,
					tool_failures: 0,
					permission_requests: 0,
					blocks: 0,
				},
			},
		};
		expect(eventOperation(ev)).toBe('run.ok');
	});

	it('returns run.fail for failed run.end', () => {
		const ev = {
			...base({kind: 'run.end'}),
			kind: 'run.end' as const,
			data: {
				status: 'failed' as const,
				counters: {
					tool_uses: 0,
					tool_failures: 0,
					permission_requests: 0,
					blocks: 0,
				},
			},
		};
		expect(eventOperation(ev)).toBe('run.fail');
	});

	it('returns prompt for user.prompt', () => {
		const ev = {
			...base({kind: 'user.prompt'}),
			kind: 'user.prompt' as const,
			data: {prompt: 'hello', cwd: '/tmp'},
		};
		expect(eventOperation(ev)).toBe('prompt');
	});

	it('returns tool.call for tool.pre', () => {
		const ev = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {}},
		};
		expect(eventOperation(ev)).toBe('tool.call');
	});

	it('returns tm.idle for teammate.idle', () => {
		const ev = {
			...base(),
			kind: 'teammate.idle' as const,
			data: {teammate_name: 'alice', team_name: 'backend'},
		};
		expect(eventOperation(ev)).toBe('tm.idle');
	});

	it('returns task.ok for task.completed', () => {
		const ev = {
			...base(),
			kind: 'task.completed' as const,
			data: {task_id: 't1', task_subject: 'Fix bug'},
		};
		expect(eventOperation(ev)).toBe('task.ok');
	});

	it('returns cfg.chg for config.change', () => {
		const ev = {
			...base(),
			kind: 'config.change' as const,
			data: {source: 'user', file_path: '.claude/settings.json'},
		};
		expect(eventOperation(ev)).toBe('cfg.chg');
	});

	it('returns perm.deny for permission.decision deny', () => {
		const ev = {
			...base({kind: 'permission.decision'}),
			kind: 'permission.decision' as const,
			data: {decision_type: 'deny' as const, message: 'no'},
		};
		expect(eventOperation(ev)).toBe('perm.deny');
	});
});

describe('eventLabel', () => {
	it('returns Title Case labels for all event kinds', () => {
		const cases: Array<[() => FeedEvent, string]> = [
			[
				() => ({
					...base(),
					kind: 'tool.pre' as const,
					data: {tool_name: 'Bash', tool_input: {}},
				}),
				'Tool Call',
			],
			[
				() => ({
					...base({kind: 'tool.post'}),
					kind: 'tool.post' as const,
					data: {tool_name: 'Bash', tool_input: {}, tool_response: {}},
				}),
				'Tool OK',
			],
			[
				() => ({
					...base({kind: 'tool.failure'}),
					kind: 'tool.failure' as const,
					data: {tool_name: 'Bash', tool_input: {}, error: 'fail'},
				}),
				'Tool Fail',
			],
			[
				() => ({
					...base({kind: 'user.prompt'}),
					kind: 'user.prompt' as const,
					data: {prompt: 'hi', cwd: '/'},
				}),
				'User Prompt',
			],
			[
				() => ({
					...base({kind: 'plan.update'}),
					kind: 'plan.update' as const,
					data: {explanation: 'Inspect code first'},
				}),
				'Plan Update',
			],
			[
				() => ({
					...base({kind: 'reasoning.summary'}),
					kind: 'reasoning.summary' as const,
					data: {message: 'Inspecting code paths'},
				}),
				'Reasoning',
			],
			[
				() => ({
					...base({kind: 'runtime.error'}),
					kind: 'runtime.error' as const,
					data: {message: 'turn failed'},
				}),
				'Error',
			],
			[
				() => ({
					...base({kind: 'turn.diff'}),
					kind: 'turn.diff' as const,
					data: {message: 'diff updated', diff: '@@ -1 +1 @@'},
				}),
				'Diff',
			],
			[
				() => ({
					...base({kind: 'subagent.start'}),
					kind: 'subagent.start' as const,
					data: {agent_id: 'a1', agent_type: 'Explore'},
				}),
				'Sub Start',
			],
			[
				() => ({
					...base({kind: 'subagent.stop'}),
					kind: 'subagent.stop' as const,
					data: {
						agent_id: 'a1',
						agent_type: 'Explore',
						stop_hook_active: false,
					},
				}),
				'Sub Stop',
			],
			[
				() => ({
					...base({kind: 'permission.request'}),
					kind: 'permission.request' as const,
					data: {tool_name: 'Bash', tool_input: {}, permission_suggestions: []},
				}),
				'Perm Request',
			],
			[
				() => ({
					...base({kind: 'permission.decision'}),
					kind: 'permission.decision' as const,
					data: {decision_type: 'allow' as const},
				}),
				'Perm Allow',
			],
			[
				() => ({
					...base({kind: 'permission.decision'}),
					kind: 'permission.decision' as const,
					data: {decision_type: 'deny' as const, message: 'no'},
				}),
				'Perm Deny',
			],
			[
				() => ({
					...base({kind: 'permission.decision'}),
					kind: 'permission.decision' as const,
					data: {decision_type: 'ask' as const},
				}),
				'Perm Ask',
			],
			[
				() => ({
					...base({kind: 'permission.decision'}),
					kind: 'permission.decision' as const,
					data: {decision_type: 'no_opinion' as const},
				}),
				'Perm Skip',
			],
			[
				() => ({
					...base({kind: 'stop.request'}),
					kind: 'stop.request' as const,
					data: {stop_hook_active: true},
				}),
				'Stop Request',
			],
			[
				() => ({
					...base({kind: 'stop.decision'}),
					kind: 'stop.decision' as const,
					data: {decision_type: 'block' as const, reason: 'x'},
				}),
				'Stop Block',
			],
			[
				() => ({
					...base({kind: 'stop.decision'}),
					kind: 'stop.decision' as const,
					data: {decision_type: 'allow' as const},
				}),
				'Stop Allow',
			],
			[
				() => ({
					...base({kind: 'stop.decision'}),
					kind: 'stop.decision' as const,
					data: {decision_type: 'no_opinion' as const},
				}),
				'Stop Skip',
			],
			[
				() => ({
					...base({kind: 'run.start'}),
					kind: 'run.start' as const,
					data: {trigger: {type: 'user_prompt_submit' as const}},
				}),
				'Run Start',
			],
			[
				() => ({
					...base({kind: 'run.end'}),
					kind: 'run.end' as const,
					data: {
						status: 'completed' as const,
						counters: {
							tool_uses: 0,
							tool_failures: 0,
							permission_requests: 0,
							blocks: 0,
						},
					},
				}),
				'Run OK',
			],
			[
				() => ({
					...base({kind: 'run.end'}),
					kind: 'run.end' as const,
					data: {
						status: 'failed' as const,
						counters: {
							tool_uses: 0,
							tool_failures: 0,
							permission_requests: 0,
							blocks: 0,
						},
					},
				}),
				'Run Fail',
			],
			[
				() => ({
					...base({kind: 'run.end'}),
					kind: 'run.end' as const,
					data: {
						status: 'aborted' as const,
						counters: {
							tool_uses: 0,
							tool_failures: 0,
							permission_requests: 0,
							blocks: 0,
						},
					},
				}),
				'Run Abort',
			],
			[
				() => ({
					...base({kind: 'session.start'}),
					kind: 'session.start' as const,
					data: {source: 'startup'},
				}),
				'Sess Start',
			],
			[
				() => ({
					...base({kind: 'session.end'}),
					kind: 'session.end' as const,
					data: {reason: 'done'},
				}),
				'Sess End',
			],
			[
				() => ({
					...base({kind: 'notification'}),
					kind: 'notification' as const,
					data: {message: 'hi'},
				}),
				'Notify',
			],
			[
				() => ({
					...base({kind: 'skills.loaded'}),
					kind: 'skills.loaded' as const,
					data: {message: 'Loaded 2 skills'},
				}),
				'Skills',
			],
			[
				() => ({
					...base({kind: 'compact.pre'}),
					kind: 'compact.pre' as const,
					data: {trigger: 'auto'},
				}),
				'Compact',
			],
			[
				() => ({
					...base({kind: 'setup'}),
					kind: 'setup' as const,
					data: {trigger: 'init'},
				}),
				'Setup',
			],
			[
				() => ({
					...base({kind: 'unknown.hook'}),
					kind: 'unknown.hook' as const,
					data: {hook_event_name: 'x', payload: {}},
				}),
				'Unknown',
			],
			[
				() => ({
					...base({kind: 'todo.add'}),
					kind: 'todo.add' as const,
					data: {todo_id: 't1', text: 'x'},
				}),
				'Todo Add',
			],
			[
				() => ({
					...base({kind: 'todo.update'}),
					kind: 'todo.update' as const,
					data: {todo_id: 't1', patch: {}},
				}),
				'Todo Update',
			],
			[
				() => ({
					...base({kind: 'todo.done'}),
					kind: 'todo.done' as const,
					data: {todo_id: 't1'},
				}),
				'Todo Done',
			],
			[
				() => ({
					...base({kind: 'agent.message'}),
					kind: 'agent.message' as const,
					data: {
						message: 'hi',
						source: 'hook' as const,
						scope: 'root' as const,
					},
				}),
				'Agent Msg',
			],
			[
				() => ({
					...base(),
					kind: 'teammate.idle' as const,
					data: {teammate_name: 'a', team_name: 'b'},
				}),
				'Team Idle',
			],
			[
				() => ({
					...base(),
					kind: 'task.completed' as const,
					data: {task_id: 't1', task_subject: 'x'},
				}),
				'Task OK',
			],
			[
				() => ({
					...base(),
					kind: 'config.change' as const,
					data: {source: 'user'},
				}),
				'Config Chg',
			],
		];
		for (const [factory, expected] of cases) {
			expect(eventLabel(factory())).toBe(expected);
		}
	});
});

describe('eventDetail', () => {
	it('returns tool name for tool events', () => {
		const ev = {
			...base(),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {}},
		};
		expect(eventDetail(ev)).toBe('Bash');
	});

	it('returns friendly MCP tool display for MCP tools', () => {
		const ev = {
			...base(),
			kind: 'tool.pre' as const,
			data: {
				tool_name: 'mcp__plugin_web-testing_agent-web__navigate',
				tool_input: {},
			},
		};
		expect(eventDetail(ev)).toContain('navigate');
	});

	it('returns tool name for permission.request', () => {
		const ev = {
			...base({kind: 'permission.request'}),
			kind: 'permission.request' as const,
			data: {tool_name: 'Read', tool_input: {}, permission_suggestions: []},
		};
		expect(eventDetail(ev)).toBe('Read');
	});

	it('returns agent_type for subagent events', () => {
		const ev = {
			...base({kind: 'subagent.start'}),
			kind: 'subagent.start' as const,
			data: {agent_id: 'a1', agent_type: 'general-purpose'},
		};
		expect(eventDetail(ev)).toBe('general-purpose');
	});

	it('returns priority for todo.add', () => {
		const ev = {
			...base({kind: 'todo.add'}),
			kind: 'todo.add' as const,
			data: {todo_id: 't1', text: 'x', priority: 'p1' as const},
		};
		expect(eventDetail(ev)).toBe('P1');
	});

	it('returns source for session.start', () => {
		const ev = {
			...base({kind: 'session.start'}),
			kind: 'session.start' as const,
			data: {source: 'startup'},
		};
		expect(eventDetail(ev)).toBe('startup');
	});

	it('returns source for config.change', () => {
		const ev = {
			...base(),
			kind: 'config.change' as const,
			data: {source: 'user'},
		};
		expect(eventDetail(ev)).toBe('user');
	});

	it('returns ─ for events without detail', () => {
		const ev = {
			...base({kind: 'user.prompt'}),
			kind: 'user.prompt' as const,
			data: {prompt: 'hi', cwd: '/'},
		};
		expect(eventDetail(ev)).toBe('─');
	});
});

describe('eventSummary', () => {
	it('formats teammate.idle summary', () => {
		const ev = {
			...base(),
			kind: 'teammate.idle' as const,
			data: {teammate_name: 'alice', team_name: 'backend'},
		};
		expect(eventSummary(ev).text).toBe('alice idle in backend');
	});

	it('formats task.completed summary', () => {
		const ev = {
			...base(),
			kind: 'task.completed' as const,
			data: {task_id: 't1', task_subject: 'Fix the login bug'},
		};
		expect(eventSummary(ev).text).toBe('Fix the login bug');
	});

	it('surfaces subagent descriptions for subagent.start and subagent.stop', () => {
		const start = {
			...base({kind: 'subagent.start'}),
			kind: 'subagent.start' as const,
			data: {
				agent_id: 'a1',
				agent_type: 'general-purpose',
				description: 'Write Playwright tests',
			},
		};
		const startResult = eventSummary(start);
		expect(startResult.segments).toEqual([
			{text: 'Write Playwright tests', role: 'target'},
		]);
		expect(startResult.text).toBe('Write Playwright tests');

		const stop = {
			...base({kind: 'subagent.stop'}),
			kind: 'subagent.stop' as const,
			data: {
				agent_id: 'a1',
				agent_type: 'Explore',
				stop_hook_active: false,
				description: 'Find test patterns',
			},
		};
		const stopResult = eventSummary(stop);
		expect(stopResult.segments).toEqual([
			{text: 'Find test patterns', role: 'target'},
		]);
		expect(stopResult.text).toBe('Find test patterns');
	});

	it('falls back to agent id when no subagent description is present', () => {
		const stop = {
			...base({kind: 'subagent.stop'}),
			kind: 'subagent.stop' as const,
			data: {
				agent_id: 'agent-123',
				agent_type: 'Explore',
				stop_hook_active: false,
			},
		};
		const result = eventSummary(stop);
		expect(result.text).toBe('id:agent-123');
		expect(result.segments).toEqual([{text: 'id:agent-123', role: 'target'}]);
	});

	it('formats session.start as natural text', () => {
		const ev = {
			...base({kind: 'session.start'}),
			kind: 'session.start' as const,
			data: {source: 'startup'},
		};
		expect(eventSummary(ev).text).toBe('startup');
	});

	it('formats session.end as reason only', () => {
		const ev = {
			...base({kind: 'session.end'}),
			kind: 'session.end' as const,
			data: {reason: 'completed'},
		};
		expect(eventSummary(ev).text).toBe('completed');
	});

	it('formats plan.update explanation', () => {
		const ev = {
			...base({kind: 'plan.update'}),
			kind: 'plan.update' as const,
			data: {explanation: 'Inspect code then patch bug'},
		};
		expect(eventSummary(ev).text).toBe('Inspect code then patch bug');
	});

	it('formats reasoning.summary text', () => {
		const ev = {
			...base({kind: 'reasoning.summary'}),
			kind: 'reasoning.summary' as const,
			data: {message: 'Inspecting code paths. Preparing patch.'},
		};
		expect(eventSummary(ev).text).toBe('Inspecting code paths.');
	});

	it('formats usage.update totals', () => {
		const ev = {
			...base({kind: 'usage.update'}),
			kind: 'usage.update' as const,
			data: {usage: {total: 120}, delta: {total: 20}},
		};
		expect(eventSummary(ev).text).toBe('120 total (+20)');
	});

	it('formats skills.loaded like a status line', () => {
		const ev = {
			...base({kind: 'skills.loaded'}),
			kind: 'skills.loaded' as const,
			data: {message: 'Loaded 2 workflow skills: Skill A, Skill B.'},
		};
		expect(eventSummary(ev).text).toBe(
			'Loaded 2 workflow skills: Skill A, Skill B.',
		);
	});

	it('formats run.end with natural text', () => {
		const ev = {
			...base({kind: 'run.end'}),
			kind: 'run.end' as const,
			data: {
				status: 'completed' as const,
				counters: {
					tool_uses: 5,
					tool_failures: 0,
					permission_requests: 1,
					blocks: 0,
				},
			},
		};
		expect(eventSummary(ev).text).toBe('completed · 5 tools');
	});

	it('formats run.end failures only when non-zero', () => {
		const ev = {
			...base({kind: 'run.end'}),
			kind: 'run.end' as const,
			data: {
				status: 'failed' as const,
				counters: {
					tool_uses: 2,
					tool_failures: 1,
					permission_requests: 0,
					blocks: 0,
				},
			},
		};
		expect(eventSummary(ev).text).toBe('failed · 2 tools, 1 failure');
	});

	it('formats compact.pre as trigger only', () => {
		const ev = {
			...base({kind: 'compact.pre'}),
			kind: 'compact.pre' as const,
			data: {trigger: 'auto'},
		};
		expect(eventSummary(ev).text).toBe('auto');
	});

	it('formats setup as trigger only', () => {
		const ev = {
			...base({kind: 'setup'}),
			kind: 'setup' as const,
			data: {trigger: 'first-run'},
		};
		expect(eventSummary(ev).text).toBe('first-run');
	});

	it('formats config.change summary', () => {
		const ev = {
			...base(),
			kind: 'config.change' as const,
			data: {source: 'user', file_path: '.claude/settings.json'},
		};
		expect(eventSummary(ev).text).toBe('user .claude/settings.json');
	});
});

describe('eventSummary — segment roles', () => {
	it('eventSummary uses target role for non-tool events', () => {
		const stopReq = {
			...base({kind: 'stop.request'}),
			kind: 'stop.request' as const,
			data: {stop_hook_active: false},
		};
		const result = eventSummary(stopReq);
		expect(result.text).toBe('Stop hook inactive');
		expect(result.segments[0]!.role).toBe('target');
	});

	it('eventSummary uses plain role for agent.message', () => {
		const msg = {
			...base({kind: 'agent.message'}),
			kind: 'agent.message' as const,
			data: {message: 'Hello', scope: 'root' as const},
		};
		const result = eventSummary(msg);
		expect(result.segments[0]!.role).toBe('plain');
	});
});

describe('eventSummary — agent.message', () => {
	it('strips markdown syntax from agent.message summary', () => {
		const ev = {
			...base({kind: 'agent.message'}),
			kind: 'agent.message' as const,
			data: {
				message:
					"Here's what the **e2e-test-builder** plugin can do — it has `6 skills`",
				scope: 'root' as const,
			},
		};
		const result = eventSummary(ev);
		expect(result.text).not.toContain('**');
		expect(result.text).not.toContain('`');
		expect(result.text).toContain('e2e-test-builder');
		expect(result.text).toContain('6 skills');
	});

	it('strips heading markers from agent.message summary', () => {
		const ev = {
			...base({kind: 'agent.message'}),
			kind: 'agent.message' as const,
			data: {
				message: '## How Ralph Loop Works with `/add-e2e-tests`',
				scope: 'root' as const,
			},
		};
		const result = eventSummary(ev);
		expect(result.text).not.toMatch(/^##/);
		expect(result.text).toContain('How Ralph Loop Works');
	});

	it('extracts first sentence from long agent.message', () => {
		const ev = {
			...base({kind: 'agent.message'}),
			kind: 'agent.message' as const,
			data: {
				message:
					'Here is a summary of what was accomplished. Completed: Google Search E2E Test Case Specifications.',
				scope: 'root' as const,
			},
		};
		const result = eventSummary(ev);
		expect(result.text).toBe('Here is a summary of what was accomplished.');
	});

	it('extracts first line when no sentence break', () => {
		const ev = {
			...base({kind: 'agent.message'}),
			kind: 'agent.message' as const,
			data: {
				message: 'First line content\nSecond line content',
				scope: 'root' as const,
			},
		};
		const result = eventSummary(ev);
		expect(result.text).toBe('First line content');
	});
});

describe('eventSummary MCP clean verb formatting', () => {
	it('includes MCP server context and uses clean verb', () => {
		const ev = {
			...base(),
			kind: 'tool.pre' as const,
			data: {
				tool_name: 'mcp__plugin_x_agent-web-interface__navigate',
				tool_input: {url: 'https://google.com'},
			},
		};
		const result = eventSummary(ev);
		expect(result.text).toBe('Navigate [agent-web-interface] google.com');
	});

	it('uses fallback capitalized verb and keeps server context for unknown MCP actions', () => {
		const ev = {
			...base(),
			kind: 'tool.pre' as const,
			data: {
				tool_name: 'mcp__my-server__do_fancy_thing',
				tool_input: {},
			},
		};
		const result = eventSummary(ev);
		expect(result.text).toBe('Do fancy thing [my-server]');
	});

	it('uses clean verb in mergedEventSummary', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {
				tool_name:
					'mcp__plugin_web-testing-toolkit_agent-web-interface__navigate',
				tool_input: {url: 'https://example.com'},
			},
		};
		const post = {
			...base({kind: 'tool.post'}),
			kind: 'tool.post' as const,
			data: {
				tool_name:
					'mcp__plugin_web-testing-toolkit_agent-web-interface__navigate',
				tool_input: {url: 'https://example.com'},
				tool_response: {},
			},
		};
		const result = mergedEventSummary(pre, post);
		expect(result.text).toMatch(/^Navigate/);
		expect(result.text).toContain('[agent-web-interface]');
	});
});

describe('eventSummary MCP formatting (clean verb)', () => {
	it('formats MCP tool.pre with clean verb and server context', () => {
		const ev = {
			...base(),
			kind: 'tool.pre' as const,
			data: {
				tool_name:
					'mcp__plugin_web-testing-toolkit_agent-web-interface__navigate',
				tool_input: {url: 'https://example.com'},
			},
		};
		expect(eventSummary(ev).text).toBe(
			'Navigate [agent-web-interface] example.com',
		);
	});

	it('formats built-in tool.pre without brackets', () => {
		const ev = {
			...base(),
			kind: 'tool.pre' as const,
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/foo.ts'},
			},
		};
		const {text} = eventSummary(ev);
		expect(text).toContain('Read');
		expect(text).not.toContain('[');
	});

	it('formats MCP permission.request with clean verb and server context', () => {
		const ev = {
			...base(),
			kind: 'permission.request' as const,
			data: {
				tool_name: 'mcp__plugin_web-testing-toolkit_agent-web-interface__click',
				tool_input: {eid: 'btn-1'},
				permission_suggestions: [],
			},
		};
		expect(eventSummary(ev).text).toBe(
			'Click [agent-web-interface] eid:btn-1…',
		);
	});

	it('formats MCP tool.post with clean verb and server context', () => {
		const ev = {
			...base(),
			kind: 'tool.post' as const,
			data: {
				tool_name:
					'mcp__plugin_web-testing-toolkit_agent-web-interface__navigate',
				tool_input: {},
				tool_response: {},
			},
		};
		expect(eventSummary(ev).text).toBe('Navigate [agent-web-interface]');
	});

	it('formats MCP tool.failure with clean verb, server context, and error', () => {
		const ev = {
			...base(),
			kind: 'tool.failure' as const,
			data: {
				tool_name:
					'mcp__plugin_web-testing-toolkit_agent-web-interface__navigate',
				tool_input: {},
				error: 'timeout',
				is_interrupt: false,
			},
		};
		const {text} = eventSummary(ev);
		expect(text).toMatch(/^Navigate /);
		expect(text).toContain('[agent-web-interface]');
		expect(text).toContain('timeout');
	});

	it('formats non-plugin MCP tool with fallback capitalized verb and server context', () => {
		const ev = {
			...base(),
			kind: 'tool.pre' as const,
			data: {
				tool_name: 'mcp__my-server__do_thing',
				tool_input: {},
			},
		};
		expect(eventSummary(ev).text).toBe('Do thing [my-server]');
	});

	it('returns verb+target segments for tool.pre with args', () => {
		const ev = {
			...base(),
			kind: 'tool.pre' as const,
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/foo.ts'},
			},
		};
		const result = eventSummary(ev);
		expect(result.segments[0]!.role).toBe('verb');
		expect(result.segments[1]!.role).toBe('target');
	});

	it('returns verb-only segments for tool.post without args', () => {
		const ev = {
			...base(),
			kind: 'tool.post' as const,
			data: {
				tool_name: 'Read',
				tool_input: {},
				tool_response: {},
			},
		};
		expect(eventSummary(ev).segments).toHaveLength(1);
	});

	it('formats tool.pre with primary input instead of key=value', () => {
		const ev = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/project/source/app.tsx'},
			},
		};
		const result = eventSummary(ev);
		expect(result.text).toBe('Read …/source/app.tsx');
		expect(result.segments[0]!.role).toBe('verb');
		expect(result.segments[1]!.role).toBe('target');
	});

	it('formats tool.pre for Bash with command', () => {
		const ev = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {command: 'npm test'}},
		};
		const result = eventSummary(ev);
		expect(result.text).toBe('Bash npm test');
	});

	it('formats tool.pre for Task with [type] description', () => {
		const ev = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {
				tool_name: 'Task',
				tool_input: {
					subagent_type: 'general-purpose',
					description: 'Write tests',
					prompt: '...',
				},
			},
		};
		const result = eventSummary(ev);
		expect(result.text).toContain('Write tests');
		expect(result.text).not.toContain('[general-purpose]');
	});

	it('formats tool.post with primary input', () => {
		const ev = {
			...base({kind: 'tool.post'}),
			kind: 'tool.post' as const,
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/project/source/app.tsx'},
				tool_response: {},
			},
		};
		const result = eventSummary(ev);
		expect(result.text).toBe('Read …/source/app.tsx');
		expect(result.segments[0]!.role).toBe('verb');
		expect(result.segments[1]!.role).toBe('target');
	});

	it('formats tool.failure with primary input and error', () => {
		const ev = {
			...base({kind: 'tool.failure'}),
			kind: 'tool.failure' as const,
			data: {
				tool_name: 'Bash',
				tool_input: {command: 'bad-cmd'},
				error: 'not found',
				is_interrupt: false,
			},
		};
		const result = eventSummary(ev);
		expect(result.text).toBe('Bash bad-cmd not found');
	});

	it('formats permission.request with primary input', () => {
		const ev = {
			...base({kind: 'permission.request'}),
			kind: 'permission.request' as const,
			data: {
				tool_name: 'Bash',
				tool_input: {command: 'rm -rf /'},
				permission_suggestions: [],
			},
		};
		const result = eventSummary(ev);
		expect(result.text).toBe('Bash rm -rf /');
	});

	it('formats permission.request with network approval context', () => {
		const ev = {
			...base({kind: 'permission.request'}),
			kind: 'permission.request' as const,
			data: {
				tool_name: 'Bash',
				tool_input: {command: 'curl https://api.example.com'},
				network_context: {host: 'api.example.com', protocol: 'https'},
				permission_suggestions: [],
			},
		};
		const result = eventSummary(ev);
		expect(result.text).toBe(
			'Bash curl https://api.example.com → https api.example.com',
		);
	});

	it('formats web.search, review.status, image.view, and request resolution summaries', () => {
		expect(
			eventSummary({
				...base({kind: 'web.search'}),
				kind: 'web.search' as const,
				data: {
					message: 'Opened search result https://example.com.',
					phase: 'completed',
					action_type: 'openPage',
					url: 'https://example.com',
				},
			}).text,
		).toBe('Opened search result https://example.com.');
		expect(
			eventSummary({
				...base({kind: 'review.status'}),
				kind: 'review.status' as const,
				data: {
					message: 'Review finished: current changes.',
					phase: 'completed',
				},
			}).text,
		).toBe('Review finished: current changes.');
		expect(
			eventSummary({
				...base({kind: 'image.view'}),
				kind: 'image.view' as const,
				data: {
					message: 'Viewed image at /tmp/image.png.',
					path: '/tmp/image.png',
				},
			}).text,
		).toBe('Viewed image at /tmp/image.png.');
		expect(
			eventSummary({
				...base({kind: 'server.request.resolved'}),
				kind: 'server.request.resolved' as const,
				data: {
					message: 'Request #42 resolved.',
					request_id: '42',
				},
			}).text,
		).toBe('Request #42 resolved.');
	});
});

describe('isEventError', () => {
	it('returns true for tool.failure', () => {
		const ev = {
			...base({kind: 'tool.failure'}),
			kind: 'tool.failure' as const,
			data: {tool_name: 'Bash', tool_input: {}, error: 'fail'},
		};
		expect(isEventError(ev)).toBe(true);
	});

	it('returns true for error level', () => {
		const ev = {
			...base({kind: 'notification', level: 'error'}),
			kind: 'notification' as const,
			data: {message: 'bad'},
		};
		expect(isEventError(ev)).toBe(true);
	});

	it('returns false for completed run.end', () => {
		const ev = {
			...base({kind: 'run.end'}),
			kind: 'run.end' as const,
			data: {
				status: 'completed' as const,
				counters: {
					tool_uses: 0,
					tool_failures: 0,
					permission_requests: 0,
					blocks: 0,
				},
			},
		};
		expect(isEventError(ev)).toBe(false);
	});

	it('returns true for failed run.end', () => {
		const ev = {
			...base({kind: 'run.end'}),
			kind: 'run.end' as const,
			data: {
				status: 'failed' as const,
				counters: {
					tool_uses: 0,
					tool_failures: 0,
					permission_requests: 0,
					blocks: 0,
				},
			},
		};
		expect(isEventError(ev)).toBe(true);
	});

	it('returns true for permission.decision deny', () => {
		const ev = {
			...base({kind: 'permission.decision'}),
			kind: 'permission.decision' as const,
			data: {decision_type: 'deny' as const, message: 'no'},
		};
		expect(isEventError(ev)).toBe(true);
	});

	it('returns false for info notification', () => {
		const ev = {
			...base({kind: 'notification'}),
			kind: 'notification' as const,
			data: {message: 'hi'},
		};
		expect(isEventError(ev)).toBe(false);
	});
});

describe('isEventExpandable', () => {
	it('returns true for all event kinds', () => {
		for (const kind of [
			'tool.pre',
			'tool.post',
			'tool.failure',
			'permission.request',
			'permission.decision',
			'subagent.start',
			'subagent.stop',
			'run.start',
			'run.end',
			'user.prompt',
			'session.start',
			'session.end',
			'setup',
			'notification',
		] as const) {
			const ev = {
				...base({kind}),
				kind,
				data: {} as Record<string, unknown>,
			} as FeedEvent;
			expect(isEventExpandable(ev)).toBe(true);
		}
	});
});

describe('toRunStatus', () => {
	const makeRunEnd = (status: 'completed' | 'failed' | 'aborted') => ({
		...base({kind: 'run.end'}),
		kind: 'run.end' as const,
		data: {
			status,
			counters: {
				tool_uses: 0,
				tool_failures: 0,
				permission_requests: 0,
				blocks: 0,
			},
		},
	});

	it('maps completed to SUCCEEDED', () => {
		expect(toRunStatus(makeRunEnd('completed'))).toBe('SUCCEEDED');
	});

	it('maps failed to FAILED', () => {
		expect(toRunStatus(makeRunEnd('failed'))).toBe('FAILED');
	});

	it('maps aborted to CANCELLED', () => {
		expect(toRunStatus(makeRunEnd('aborted'))).toBe('CANCELLED');
	});
});

describe('deriveRunTitle', () => {
	it('uses currentPromptPreview when available', () => {
		expect(deriveRunTitle('Fix the bug', [], [])).toBe('Fix the bug');
	});

	it('falls back to run.start prompt_preview', () => {
		const events: FeedEvent[] = [
			{
				...base({kind: 'run.start'}),
				kind: 'run.start' as const,
				data: {
					trigger: {
						type: 'user_prompt_submit' as const,
						prompt_preview: 'from event',
					},
				},
			},
		];
		expect(deriveRunTitle(undefined, events, [])).toBe('from event');
	});

	it('falls back to user.prompt', () => {
		const events: FeedEvent[] = [
			{
				...base({kind: 'user.prompt'}),
				kind: 'user.prompt' as const,
				data: {prompt: 'user said this', cwd: '/tmp'},
			},
		];
		expect(deriveRunTitle(undefined, events, [])).toBe('user said this');
	});

	it('falls back to messages', () => {
		const msgs: Message[] = [
			{
				id: '1',
				role: 'user',
				content: 'from message',
				timestamp: new Date(),
				seq: 1,
			},
		];
		expect(deriveRunTitle(undefined, [], msgs)).toBe('from message');
	});

	it('returns Untitled run as last resort', () => {
		expect(deriveRunTitle(undefined, [], [])).toBe('Untitled run');
	});
});

describe('VERBOSE_ONLY_KINDS', () => {
	it('includes lifecycle event kinds', () => {
		expect(VERBOSE_ONLY_KINDS.has('session.start')).toBe(true);
		expect(VERBOSE_ONLY_KINDS.has('session.end')).toBe(true);
		expect(VERBOSE_ONLY_KINDS.has('run.start')).toBe(true);
		expect(VERBOSE_ONLY_KINDS.has('run.end')).toBe(true);
		expect(VERBOSE_ONLY_KINDS.has('config.change')).toBe(true);
		expect(VERBOSE_ONLY_KINDS.has('turn.diff')).toBe(true);
	});

	it('excludes tool and action event kinds', () => {
		expect(VERBOSE_ONLY_KINDS.has('notification')).toBe(false);
		expect(VERBOSE_ONLY_KINDS.has('tool.pre')).toBe(false);
		expect(VERBOSE_ONLY_KINDS.has('tool.post')).toBe(false);
		expect(VERBOSE_ONLY_KINDS.has('tool.failure')).toBe(false);
		expect(VERBOSE_ONLY_KINDS.has('user.prompt')).toBe(false);
		expect(VERBOSE_ONLY_KINDS.has('permission.request')).toBe(false);
		expect(VERBOSE_ONLY_KINDS.has('subagent.start')).toBe(false);
	});
});

describe('computeDuplicateActors', () => {
	it('resets at category boundaries', () => {
		const entries = [
			{actorId: 'agent:root', opTag: 'tool.ok', duplicateActor: false},
			{actorId: 'agent:root', opTag: 'tool.ok', duplicateActor: false},
			{actorId: 'agent:root', opTag: 'agent.msg', duplicateActor: false},
		] as TimelineEntry[];
		computeDuplicateActors(entries);
		expect(entries[0]!.duplicateActor).toBe(false);
		expect(entries[1]!.duplicateActor).toBe(true);
		expect(entries[2]!.duplicateActor).toBe(false);
	});
});

describe('mergedEventOperation', () => {
	it('returns tool.ok when postEvent is tool.post', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {}},
		};
		const post = {
			...base({kind: 'tool.post'}),
			kind: 'tool.post' as const,
			data: {tool_name: 'Bash', tool_input: {}, tool_response: {}},
		};
		expect(mergedEventOperation(pre, post)).toBe('tool.ok');
	});

	it('returns tool.fail when postEvent is tool.failure', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {}},
		};
		const post = {
			...base({kind: 'tool.failure'}),
			kind: 'tool.failure' as const,
			data: {
				tool_name: 'Bash',
				tool_input: {},
				error: 'fail',
				is_interrupt: false,
			},
		};
		expect(mergedEventOperation(pre, post)).toBe('tool.fail');
	});

	it('falls back to eventOperation when no postEvent', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {}},
		};
		expect(mergedEventOperation(pre)).toBe('tool.call');
	});
});

describe('mergedEventLabel', () => {
	it('returns Tool OK when postEvent is tool.post', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {}},
		};
		const post = {
			...base({kind: 'tool.post'}),
			kind: 'tool.post' as const,
			data: {tool_name: 'Bash', tool_input: {}, tool_response: {}},
		};
		expect(mergedEventLabel(pre, post)).toBe('Tool OK');
	});

	it('returns Tool Fail when postEvent is tool.failure', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {}},
		};
		const post = {
			...base({kind: 'tool.failure'}),
			kind: 'tool.failure' as const,
			data: {
				tool_name: 'Bash',
				tool_input: {},
				error: 'fail',
				is_interrupt: false,
			},
		};
		expect(mergedEventLabel(pre, post)).toBe('Tool Fail');
	});

	it('falls back to eventLabel when no postEvent', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {}},
		};
		expect(mergedEventLabel(pre)).toBe('Tool Call');
	});
});

describe('mergedEventSummary', () => {
	it('returns outcome separately from text', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Glob', tool_input: {pattern: '**/*.ts'}},
		};
		const filenames = Array.from({length: 13}, (_, i) => `file${i}.ts`);
		const post = {
			...base({kind: 'tool.post'}),
			kind: 'tool.post' as const,
			data: {
				tool_name: 'Glob',
				tool_input: {pattern: '**/*.ts'},
				tool_response: {filenames},
			},
		};
		const result = mergedEventSummary(pre, post);
		expect(result.outcome).toBe('13 files');
		expect(result.text).not.toContain('—');
	});

	it('marks zero results with outcomeZero', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Glob', tool_input: {pattern: '**/*.xyz'}},
		};
		const post = {
			...base({kind: 'tool.post'}),
			kind: 'tool.post' as const,
			data: {
				tool_name: 'Glob',
				tool_input: {pattern: '**/*.xyz'},
				tool_response: {filenames: []},
			},
		};
		const result = mergedEventSummary(pre, post);
		expect(result.outcome).toBe('0 files');
		expect(result.outcomeZero).toBe(true);
	});

	it('returns merged summary with primary input and tool result when paired', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {command: 'ls'}},
		};
		const post = {
			...base({kind: 'tool.post'}),
			kind: 'tool.post' as const,
			data: {
				tool_name: 'Bash',
				tool_input: {command: 'ls'},
				tool_response: {stdout: 'file\n', stderr: '', exitCode: 0},
			},
		};
		const result = mergedEventSummary(pre, post);
		expect(result.outcome).toBe('exit 0');
		expect(result.text).not.toContain('—');
		expect(result.segments[0]!.role).toBe('verb');
		expect(result.segments[0]!.text).toBe('Bash');
	});

	it('includes primary input in merged Read summary', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/project/source/app.tsx'},
			},
		};
		const post = {
			...base({kind: 'tool.post'}),
			kind: 'tool.post' as const,
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/project/source/app.tsx'},
				tool_response: [{type: 'text', file: {content: 'line1\nline2\nline3'}}],
			},
		};
		const result = mergedEventSummary(pre, post);
		expect(result.text).toContain('Read');
		expect(result.text).toContain('source/app.tsx');
		expect(result.outcome).toBe('3 lines');
	});

	it('includes command in merged Bash summary', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {command: 'npm test'}},
		};
		const post = {
			...base({kind: 'tool.post'}),
			kind: 'tool.post' as const,
			data: {
				tool_name: 'Bash',
				tool_input: {command: 'npm test'},
				tool_response: {stdout: '', stderr: '', exitCode: 0},
			},
		};
		const result = mergedEventSummary(pre, post);
		expect(result.text).toBe('Bash npm test');
		expect(result.outcome).toBe('exit 0');
	});

	it('returns merged summary with error for tool.failure', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Bash', tool_input: {command: 'bad'}},
		};
		const post = {
			...base({kind: 'tool.failure'}),
			kind: 'tool.failure' as const,
			data: {
				tool_name: 'Bash',
				tool_input: {command: 'bad'},
				error: 'command not found',
				is_interrupt: false,
			},
		};
		const result = mergedEventSummary(pre, post);
		expect(result.text).toContain('Bash');
		expect(result.outcome).toBe('command not found');
	});

	it('falls back to eventSummary when no postEvent', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Read', tool_input: {file_path: '/foo.ts'}},
		};
		const result = mergedEventSummary(pre);
		expect(result.text).toContain('Read');
		expect(result.text).toContain('foo.ts');
	});

	it('uses tool.post input when tool.pre input values are null (WebSearch)', () => {
		const pre = {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'WebSearch', tool_input: {query: null}},
		};
		const post = {
			...base({kind: 'tool.post'}),
			kind: 'tool.post' as const,
			data: {
				tool_name: 'WebSearch',
				tool_input: {query: 'cheapest mac'},
				tool_response: {type: 'search', query: 'cheapest mac'},
			},
		};
		const result = mergedEventSummary(pre, post);
		expect(result.text).toContain('cheapest mac');
		expect(result.outcome).toBe('search');
	});
});

describe('isEntryStable', () => {
	const stableEntry = (overrides: Partial<TimelineEntry> = {}): TimelineEntry =>
		({
			id: 'e1',
			ts: 1000,
			op: 'Tool Call',
			opTag: 'tool.call',
			actor: 'root',
			actorId: 'agent:root',
			toolColumn: '',
			summary: '',
			summarySegments: [],
			searchText: '',
			error: false,
			expandable: false,
			details: '',
			duplicateActor: false,
			...overrides,
		}) as TimelineEntry;

	it('returns true for entry without feedEvent (message entry)', () => {
		expect(isEntryStable(stableEntry())).toBe(true);
	});

	it('returns true for immutable event kinds', () => {
		for (const kind of [
			'user.prompt',
			'session.start',
			'session.end',
			'notification',
			'run.start',
			'run.end',
			'tool.post',
			'tool.failure',
			'subagent.start',
			'subagent.stop',
		] as const) {
			const entry = stableEntry({
				feedEvent: {...base({kind}), kind, data: {}} as FeedEvent,
			});
			expect(isEntryStable(entry)).toBe(true);
		}
	});

	it('returns false for tool.pre without pairedPostEvent', () => {
		const entry = stableEntry({
			feedEvent: {
				...base({kind: 'tool.pre'}),
				kind: 'tool.pre' as const,
				data: {tool_name: 'Bash', tool_input: {}},
			},
		});
		expect(isEntryStable(entry)).toBe(false);
	});

	it('returns true for tool.pre with pairedPostEvent', () => {
		const entry = stableEntry({
			feedEvent: {
				...base({kind: 'tool.pre'}),
				kind: 'tool.pre' as const,
				data: {tool_name: 'Bash', tool_input: {}},
			},
			pairedPostEvent: {
				...base({kind: 'tool.post'}),
				kind: 'tool.post' as const,
				data: {tool_name: 'Bash', tool_input: {}, tool_response: {}},
			},
		});
		expect(isEntryStable(entry)).toBe(true);
	});

	it('returns false for permission.request without pairedPostEvent', () => {
		const entry = stableEntry({
			feedEvent: {
				...base({kind: 'permission.request'}),
				kind: 'permission.request' as const,
				data: {tool_name: 'Bash', tool_input: {}, permission_suggestions: []},
			},
		});
		expect(isEntryStable(entry)).toBe(false);
	});

	it('returns true for permission.request with pairedPostEvent', () => {
		const entry = stableEntry({
			feedEvent: {
				...base({kind: 'permission.request'}),
				kind: 'permission.request' as const,
				data: {tool_name: 'Bash', tool_input: {}, permission_suggestions: []},
			},
			pairedPostEvent: {
				...base({kind: 'permission.decision'}),
				kind: 'permission.decision' as const,
				data: {decision_type: 'allow' as const},
			},
		});
		expect(isEntryStable(entry)).toBe(true);
	});
});
