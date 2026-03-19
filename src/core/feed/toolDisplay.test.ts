import {describe, it, expect} from 'vitest';
import {
	resolveToolDisplay,
	resolveToolColumn,
	resolveEventDisplay,
	humanizeToolName,
} from './toolDisplay';
import {type FeedEvent} from './types';

// ── resolveToolColumn ───────────────────────────────────

describe('resolveToolColumn', () => {
	it('returns display name for known core tools', () => {
		expect(resolveToolColumn('Read')).toBe('Read');
		expect(resolveToolColumn('Write')).toBe('Write');
		expect(resolveToolColumn('Edit')).toBe('Edit');
		expect(resolveToolColumn('Bash')).toBe('Bash');
		expect(resolveToolColumn('Glob')).toBe('Glob');
		expect(resolveToolColumn('Grep')).toBe('Grep');
		expect(resolveToolColumn('WebFetch')).toBe('WebFetch');
		expect(resolveToolColumn('WebSearch')).toBe('WebSearch');
		expect(resolveToolColumn('Task')).toBe('Task');
		expect(resolveToolColumn('Skill')).toBe('Skill');
		expect(resolveToolColumn('NotebookEdit')).toBe('Notebook');
		expect(resolveToolColumn('AskUserQuestion')).toBe('AskUser');
		expect(resolveToolColumn('EnterPlanMode')).toBe('PlanMode');
		expect(resolveToolColumn('ExitPlanMode')).toBe('PlanMode');
	});

	it('returns display name for known MCP actions', () => {
		expect(resolveToolColumn('mcp__server__navigate')).toBe('Navigate');
		expect(resolveToolColumn('mcp__server__click')).toBe('Click');
		expect(resolveToolColumn('mcp__server__find_elements')).toBe('Find');
		expect(resolveToolColumn('mcp__server__take_screenshot')).toBe(
			'Screenshot',
		);
		expect(resolveToolColumn('mcp__server__scroll_page')).toBe('Scroll');
		expect(resolveToolColumn('mcp__context7__query-docs')).toBe('QueryDocs');
	});

	it('humanizes unknown tool names', () => {
		expect(resolveToolColumn('SomeCustomTool')).toBe('SomeCustomTool');
		expect(resolveToolColumn('mcp__srv__unknown_action')).toBe('UnknownAction');
	});
});

// ── humanizeToolName ────────────────────────────────────

describe('humanizeToolName', () => {
	it('capitalizes and joins segments', () => {
		expect(humanizeToolName('scroll_page')).toBe('ScrollPage');
		expect(humanizeToolName('get-element')).toBe('GetElement');
	});

	it('truncates long names to 14 chars', () => {
		const result = humanizeToolName('very_long_tool_name_here');
		expect(result.length).toBeLessThanOrEqual(14);
		expect(result.endsWith('…')).toBe(true);
	});
});

// ── resolveToolDisplay ──────────────────────────────────

describe('resolveToolDisplay', () => {
	describe('Tier 1: known core tools', () => {
		it('Read: extracts file path segments', () => {
			const result = resolveToolDisplay(
				'Read',
				{file_path: '/home/user/project/src/app.tsx'},
				undefined,
				undefined,
			);
			expect(result.toolColumn).toBe('Read');
			expect(result.segments.length).toBeGreaterThan(0);
			expect(result.segments.some(s => s.role === 'filename')).toBe(true);
			expect(result.outcome).toBeUndefined();
		});

		it('Glob: extracts pattern, produces count outcome', () => {
			const result = resolveToolDisplay(
				'Glob',
				{pattern: '**/*.ts'},
				{filenames: ['a.ts', 'b.ts', 'c.ts']},
				undefined,
			);
			expect(result.toolColumn).toBe('Glob');
			expect(result.segments[0]?.text).toBe('**/*.ts');
			expect(result.outcome).toBe('3 files');
			expect(result.outcomeZero).toBe(false);
		});

		it('Glob: zero files flags outcomeZero', () => {
			const result = resolveToolDisplay(
				'Glob',
				{pattern: '**/*.xyz'},
				{filenames: []},
				undefined,
			);
			expect(result.outcome).toBe('0 files');
			expect(result.outcomeZero).toBe(true);
		});

		it('Grep: extracts pattern and glob', () => {
			const result = resolveToolDisplay(
				'Grep',
				{pattern: 'TODO', glob: '*.ts'},
				'file1.ts\nfile2.ts\n',
				undefined,
			);
			expect(result.toolColumn).toBe('Grep');
			expect(result.segments[0]?.text).toContain('TODO');
			expect(result.outcome).toBe('2 matches');
		});

		it('Bash: extracts command, produces exit code outcome', () => {
			const result = resolveToolDisplay(
				'Bash',
				{command: 'npm test'},
				{stdout: 'ok', stderr: '', exitCode: 0, interrupted: false},
				undefined,
			);
			expect(result.toolColumn).toBe('Bash');
			expect(result.segments[0]?.text).toContain('npm test');
			expect(result.outcome).toBe('exit 0');
		});

		it('Bash: includes stderr in outcome on failure', () => {
			const result = resolveToolDisplay(
				'Bash',
				{command: 'npm test'},
				{
					stdout: '',
					stderr: 'Error: test failed',
					exitCode: 1,
					interrupted: false,
				},
				undefined,
			);
			expect(result.outcome).toContain('exit 1');
			expect(result.outcome).toContain('Error');
		});

		it('WebSearch: extracts query, produces result count', () => {
			const result = resolveToolDisplay(
				'WebSearch',
				{query: 'vitest docs'},
				{results: [{content: [{title: 'r1'}]}, {content: [{title: 'r2'}]}]},
				undefined,
			);
			expect(result.toolColumn).toBe('WebSearch');
			expect(result.segments[0]?.text).toContain('vitest docs');
			expect(result.outcome).toBe('2 results');
		});

		it('WebSearch: handles codex WebSearchAction response', () => {
			const result = resolveToolDisplay(
				'WebSearch',
				{query: 'cheapest mac'},
				{type: 'search', query: 'cheapest mac'},
				undefined,
			);
			expect(result.toolColumn).toBe('WebSearch');
			expect(result.segments[0]?.text).toContain('cheapest mac');
			expect(result.outcome).toBe('search');
		});

		it('Task: extracts description', () => {
			const result = resolveToolDisplay(
				'Task',
				{description: 'Explore codebase'},
				undefined,
				undefined,
			);
			expect(result.toolColumn).toBe('Task');
			expect(result.segments[0]?.text).toContain('Explore codebase');
		});

		it('Skill: strips prefix from skill name', () => {
			const result = resolveToolDisplay(
				'Skill',
				{skill: 'superpowers:brainstorming'},
				undefined,
				undefined,
			);
			expect(result.toolColumn).toBe('Skill');
			expect(result.segments[0]?.text).toBe('brainstorming');
		});
	});

	describe('Tier 2: MCP actions', () => {
		it('navigate: extracts domain', () => {
			const result = resolveToolDisplay(
				'mcp__browser__navigate',
				{url: 'https://example.com/page'},
				undefined,
				undefined,
			);
			expect(result.toolColumn).toBe('Navigate');
			expect(result.segments[0]?.text).toBe('example.com');
		});

		it('find_elements: extracts kind and label', () => {
			const result = resolveToolDisplay(
				'mcp__browser__find_elements',
				{kind: 'button', label: 'Submit'},
				{elements: [{id: 'e1'}, {id: 'e2'}]},
				undefined,
			);
			expect(result.toolColumn).toBe('Find');
			expect(result.segments[0]?.text).toContain('button');
			expect(result.segments[0]?.text).toContain('Submit');
			expect(result.outcome).toBe('2 found');
		});

		it('click: extracts eid', () => {
			const result = resolveToolDisplay(
				'mcp__browser__click',
				{eid: 'btn-12345-abc'},
				undefined,
				undefined,
			);
			expect(result.toolColumn).toBe('Click');
			expect(result.segments[0]?.text).toContain('btn-12');
		});

		it('type: extracts text and eid', () => {
			const result = resolveToolDisplay(
				'mcp__browser__type',
				{text: 'hello world', eid: 'input-xyz'},
				undefined,
				undefined,
			);
			expect(result.toolColumn).toBe('Type');
			expect(result.segments[0]?.text).toContain('hello world');
		});

		it('scroll_page: extracts direction and amount', () => {
			const result = resolveToolDisplay(
				'mcp__browser__scroll_page',
				{direction: 'down', amount: 500},
				undefined,
				undefined,
			);
			expect(result.toolColumn).toBe('Scroll');
			expect(result.segments[0]?.text).toContain('down');
			expect(result.segments[0]?.text).toContain('500');
		});
	});

	describe('Tier 3: generic fallback', () => {
		it('humanizes unknown MCP action names', () => {
			const result = resolveToolDisplay(
				'mcp__custom__do_something',
				{query: 'test query'},
				undefined,
				undefined,
			);
			expect(result.toolColumn).toBe('DoSomething');
			expect(result.segments[0]?.text).toContain('test query');
		});

		it('humanizes unknown built-in tool names', () => {
			const result = resolveToolDisplay(
				'CustomTool',
				{file_path: '/tmp/test.txt'},
				undefined,
				undefined,
			);
			expect(result.toolColumn).toBe('CustomTool');
			expect(result.segments[0]?.text).toContain('test.txt');
		});

		it('uses priority key order for generic details', () => {
			const result = resolveToolDisplay(
				'UnknownTool',
				{description: 'some desc', url: 'https://x.com'},
				undefined,
				undefined,
			);
			// url has higher priority than description
			expect(result.segments[0]?.text).toContain('x.com');
		});

		it('falls back to param count for objects with no string values', () => {
			const result = resolveToolDisplay(
				'UnknownTool',
				{count: 5, flag: true},
				undefined,
				undefined,
			);
			expect(result.segments[0]?.text).toBe('2 params');
		});
	});

	describe('error handling', () => {
		it('error overrides normal outcome', () => {
			const result = resolveToolDisplay(
				'Read',
				{file_path: '/tmp/missing.txt'},
				undefined,
				'File not found: /tmp/missing.txt',
			);
			expect(result.toolColumn).toBe('Read');
			expect(result.outcome).toContain('File not found');
			expect(result.outcomeZero).toBe(false);
		});

		it('truncates long error messages', () => {
			const longError = 'E'.repeat(100);
			const result = resolveToolDisplay(
				'Bash',
				{command: 'x'},
				undefined,
				longError,
			);
			expect(result.outcome!.length).toBeLessThanOrEqual(51); // 50 + ellipsis
		});
	});

	describe('in-flight (no output)', () => {
		it('returns undefined outcome when output is undefined', () => {
			const result = resolveToolDisplay(
				'Read',
				{file_path: '/tmp/file.ts'},
				undefined,
				undefined,
			);
			expect(result.toolColumn).toBe('Read');
			expect(result.outcome).toBeUndefined();
		});
	});
});

// ── resolveEventDisplay ─────────────────────────────────

describe('resolveEventDisplay', () => {
	const baseEvent = {
		event_id: 'e1',
		seq: 1,
		ts: Date.now(),
		session_id: 's1',
		run_id: 'r1',
		level: 'info' as const,
		actor_id: 'agent:root',
		title: '',
	};

	it('subagent.start: returns agent_type as toolColumn', () => {
		const event = {
			...baseEvent,
			kind: 'subagent.start' as const,
			data: {agent_type: 'general-purpose', description: 'Explore code'},
		} as FeedEvent;
		const result = resolveEventDisplay(event);
		expect(result.toolColumn).toBe('general-purpose');
		expect(result.segments[0]?.text).toContain('Explore code');
	});

	it('agent.message: returns empty toolColumn', () => {
		const event = {
			...baseEvent,
			kind: 'agent.message' as const,
			data: {message: 'Here is a **bold** explanation.'},
		} as FeedEvent;
		const result = resolveEventDisplay(event);
		expect(result.toolColumn).toBe('');
		expect(result.segments[0]?.text).toContain('Here is a bold explanation');
	});

	it('permission.request: returns tool display name as toolColumn', () => {
		const event = {
			...baseEvent,
			kind: 'permission.request' as const,
			data: {
				tool_name: 'mcp__browser__navigate',
				tool_input: {url: 'https://example.com'},
			},
		} as FeedEvent;
		const result = resolveEventDisplay(event);
		expect(result.toolColumn).toBe('Navigate');
	});

	it('unknown event: returns empty toolColumn and segments', () => {
		const event = {
			...baseEvent,
			kind: 'notification' as const,
			data: {message: 'test notification'},
		} as FeedEvent;
		const result = resolveEventDisplay(event);
		expect(result.toolColumn).toBe('');
		expect(result.segments).toEqual([]);
	});
});
