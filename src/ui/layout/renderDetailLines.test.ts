import {describe, it, expect} from 'vitest';
import {renderDetailLines} from './renderDetailLines';
import type {FeedEvent} from '../../core/feed/types';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';

function makeEvent(
	overrides: Partial<FeedEvent> & Pick<FeedEvent, 'kind' | 'data'>,
): FeedEvent {
	return {
		event_id: 'E1',
		seq: 1,
		session_id: 'S1',
		run_id: 'R1',
		ts: Date.now(),
		actor_id: 'agent:root',
		level: 'info',
		title: 'test',
		...overrides,
	} as FeedEvent;
}

describe('renderDetailLines', () => {
	it('renders agent.message as markdown', () => {
		const event = makeEvent({
			kind: 'agent.message',
			data: {message: '**bold** text', source: 'hook', scope: 'root'},
		});
		const result = renderDetailLines(event, 80);
		expect(result.showLineNumbers).toBe(false);
		const joined = result.lines.join('\n');
		expect(joined).toContain('bold');
		expect(joined).not.toContain('**bold**');
	});

	it('renders bold inside list items in agent.message', () => {
		const event = makeEvent({
			kind: 'agent.message',
			data: {
				message: '* **Critical:** leaked data\n* **Warning:** slow query',
				source: 'hook',
				scope: 'root',
			},
		});
		const result = renderDetailLines(event, 80);
		const joined = result.lines.join('\n');
		expect(joined).not.toContain('**Critical:**');
		expect(joined).toContain('Critical:');
	});

	it('renders user.prompt as markdown', () => {
		const event = makeEvent({
			kind: 'user.prompt',
			data: {prompt: 'Hello **world**'},
		});
		const result = renderDetailLines(event, 80);
		expect(result.showLineNumbers).toBe(false);
		const joined = result.lines.join('\n');
		expect(joined).toContain('world');
	});

	it('wraps long markdown lines to detail width', () => {
		const longWord = 'x'.repeat(140);
		const event = makeEvent({
			kind: 'agent.message',
			data: {message: longWord, source: 'hook', scope: 'root'},
		});
		const width = 40;
		const result = renderDetailLines(event, width);
		const maxLineWidth = Math.max(
			...result.lines.map(line => stringWidth(stripAnsi(line))),
		);
		expect(maxLineWidth).toBeLessThanOrEqual(width);
	});

	it('wraps markdown table output to detail width', () => {
		const event = makeEvent({
			kind: 'agent.message',
			data: {
				source: 'hook',
				scope: 'root',
				message: [
					'| Col A | Col B | Col C |',
					'| --- | --- | --- |',
					'| one | very-long-token-without-spaces-abcdefghijklmnopqrstuvwxyz0123456789 | three |',
				].join('\n'),
			},
		});
		const width = 52;
		const result = renderDetailLines(event, width);
		const maxLineWidth = Math.max(
			...result.lines.map(line => stringWidth(stripAnsi(line))),
		);
		expect(maxLineWidth).toBeLessThanOrEqual(width);
	});

	it('renders tool.post Read with syntax highlighting', () => {
		const event = makeEvent({
			kind: 'tool.post',
			data: {
				tool_name: 'Read',
				tool_input: {file_path: 'test.ts'},
				tool_response: [{type: 'text', file: {content: 'const x = 1;'}}],
			},
		});
		const result = renderDetailLines(event, 80);
		expect(result.lines.some(l => l.includes('const'))).toBe(true);
	});

	it('renders Read .md file content as markdown (not syntax-highlighted)', () => {
		const event = makeEvent({
			kind: 'tool.post',
			data: {
				tool_name: 'Read',
				tool_input: {file_path: 'docs/README.md'},
				tool_response: [
					{type: 'text', file: {content: '# Title\n\n**bold** text'}},
				],
			},
		});
		const result = renderDetailLines(event, 80);
		expect(result.showLineNumbers).toBe(false);
		const joined = result.lines.join('\n');
		expect(joined).not.toContain('**bold**');
		expect(joined).toContain('bold');
	});

	it('renders tool.post Edit as diff', () => {
		const event = makeEvent({
			kind: 'tool.post',
			data: {
				tool_name: 'Edit',
				tool_input: {old_string: 'foo', new_string: 'bar'},
				tool_response: {filePath: 'test.ts', success: true},
			},
		});
		const result = renderDetailLines(event, 80);
		const joined = result.lines.join('\n');
		expect(joined).toContain('foo');
		expect(joined).toContain('bar');
	});

	it('renders tool.pre with subject line and input JSON', () => {
		const event = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name: 'Bash',
				tool_input: {command: 'echo hello'},
			},
		});
		const result = renderDetailLines(event, 80);
		const text = stripAnsi(result.lines.join('\n'));
		// Subject line shows the command
		expect(text).toContain('$ echo hello');
		// Full input JSON is shown below (no response yet)
		expect(text).toContain('echo hello');
	});

	it('renders streamed command output for tool.pre paired with tool.delta', () => {
		const pre = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name: 'Bash',
				tool_input: {command: 'npm test'},
				tool_use_id: 'cmd-1',
			},
		});
		const delta = makeEvent({
			kind: 'tool.delta',
			data: {
				tool_name: 'Bash',
				tool_input: {},
				tool_use_id: 'cmd-1',
				delta: 'PASS src/example.test.ts\n',
			},
		});
		const result = renderDetailLines(pre, 80, delta);
		const text = stripAnsi(result.lines.join('\n'));
		expect(text).toContain('$ npm test');
		expect(text).toContain('PASS src/example.test.ts');
	});

	it('wraps long tool request lines to detail width', () => {
		const event = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name: 'Bash',
				tool_input: {
					command:
						'npx playwright test tests/google-search.spec.ts --project=chromium --workers=1 --reporter=line --timeout=30000',
				},
			},
		});
		const width = 56;
		const result = renderDetailLines(event, width);
		const maxLineWidth = Math.max(
			...result.lines.map(line => stringWidth(stripAnsi(line))),
		);
		expect(maxLineWidth).toBeLessThanOrEqual(width);
	});

	it('shows compact header for MCP tool.pre with server name', () => {
		const event = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name:
					'mcp__plugin_web-testing-toolkit_agent-web-interface__scroll_element_into_view',
				tool_input: {eid: 'btn-1'},
			},
		});
		const result = renderDetailLines(event, 80);
		const text = stripAnsi(result.lines.join('\n'));
		// Header shows tool display name with server
		expect(text).toContain('agent-web-interface');
		// No verbose IDs
		expect(text).not.toContain('Session ID:');
		expect(text).not.toContain('Event ID:');
	});

	it('shows compact header for built-in tool.pre', () => {
		const event = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/foo.ts'},
			},
		});
		const result = renderDetailLines(event, 80);
		const text = stripAnsi(result.lines.join('\n'));
		// Subject line shows file path
		expect(text).toContain('/foo.ts');
		expect(text).not.toContain('Tool: Read');
		expect(text).not.toContain('Namespace:');
	});

	it('shows compact header for MCP tool.post with response content', () => {
		const event = makeEvent({
			kind: 'tool.post',
			data: {
				tool_name:
					'mcp__plugin_web-testing-toolkit_agent-web-interface__navigate',
				tool_input: {url: 'https://example.com'},
				tool_response: {result: 'ok'},
			},
		});
		const result = renderDetailLines(event, 80);
		const text = stripAnsi(result.lines.join('\n'));
		// Header shows server name
		expect(text).toContain('agent-web-interface');
		// No verbose labels
		expect(text).not.toContain('Request');
		expect(text).not.toContain('Response');
	});

	it('shows subject and content for merged built-in Read tool', () => {
		const pre = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/tmp/sample.ts'},
				tool_use_id: 'tu-1',
			},
		});
		const post = makeEvent({
			kind: 'tool.post',
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/tmp/sample.ts'},
				tool_response: [{type: 'text', file: {content: 'const x = 1;'}}],
				tool_use_id: 'tu-1',
			},
		});
		const result = renderDetailLines(pre, 80, post);
		const text = stripAnsi(result.lines.join('\n'));
		// Subject line shows file path (no JSON request)
		expect(text).toContain('/tmp/sample.ts');
		// Response content shown directly
		expect(text).toContain('const x = 1;');
		// No explicit "Request" / "Response" labels
		expect(text).not.toContain('Request');
		expect(text).not.toContain('Response');
	});

	it('shows compact view for merged MCP tool details', () => {
		const pre = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name:
					'mcp__plugin_web-testing-toolkit_agent-web-interface__find_elements',
				tool_input: {kind: 'button', label: 'Search'},
				tool_use_id: 'mcp-1',
			},
		});
		const post = makeEvent({
			kind: 'tool.post',
			data: {
				tool_name:
					'mcp__plugin_web-testing-toolkit_agent-web-interface__find_elements',
				tool_input: {kind: 'button', label: 'Search'},
				tool_response: {result: 'ok'},
				tool_use_id: 'mcp-1',
			},
		});
		const result = renderDetailLines(pre, 80, post);
		const text = stripAnsi(result.lines.join('\n'));
		// Header identifies the tool
		expect(text).toContain('agent-web-interface');
		// No verbose labels
		expect(text).not.toContain('Request');
		expect(text).not.toContain('Response');
	});

	it('shows command as subject for merged Bash tool', () => {
		const pre = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name: 'Bash',
				tool_input: {command: 'echo "hello world"'},
				tool_use_id: 'bash-1',
			},
		});
		const post = makeEvent({
			kind: 'tool.post',
			data: {
				tool_name: 'Bash',
				tool_input: {command: 'echo "hello world"'},
				tool_response: {stdout: 'hello world', stderr: '', interrupted: false},
				tool_use_id: 'bash-1',
			},
		});
		const result = renderDetailLines(pre, 80, post);
		const text = stripAnsi(result.lines.join('\n'));
		// Subject shows the command with $ prefix
		expect(text).toContain('$ echo "hello world"');
		// Response output shown directly
		expect(text).toContain('hello world');
	});

	it('shows file path as subject for merged Write tool', () => {
		const pre = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name: 'Write',
				tool_input: {
					file_path: '/tmp/out.md',
					content: '# Title\n\nlong body',
				},
				tool_use_id: 'write-1',
			},
		});
		const post = makeEvent({
			kind: 'tool.post',
			data: {
				tool_name: 'Write',
				tool_input: {
					file_path: '/tmp/out.md',
					content: '# Title\n\nlong body',
				},
				tool_response: 'File created successfully',
				tool_use_id: 'write-1',
			},
		});
		const result = renderDetailLines(pre, 80, post);
		const text = stripAnsi(result.lines.join('\n'));
		// Subject shows file path
		expect(text).toContain('/tmp/out.md');
		// Content shown directly, no labels
		expect(text).toContain('File created successfully');
		expect(text).not.toContain('Request');
		expect(text).not.toContain('Response');
	});

	it('shows file path as subject and diff for merged Edit tool', () => {
		const pre = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name: 'Edit',
				tool_input: {
					file_path: '/tmp/out.ts',
					old_string: 'foo',
					new_string: 'bar',
				},
				tool_use_id: 'edit-1',
			},
		});
		const post = makeEvent({
			kind: 'tool.post',
			data: {
				tool_name: 'Edit',
				tool_input: {
					file_path: '/tmp/out.ts',
					old_string: 'foo',
					new_string: 'bar',
				},
				tool_response: {success: true},
				tool_use_id: 'edit-1',
			},
		});
		const result = renderDetailLines(pre, 80, post);
		const text = stripAnsi(result.lines.join('\n'));
		// Subject shows file path
		expect(text).toContain('/tmp/out.ts');
		// Diff content shown directly, no labels
		expect(text).toContain('- foo');
		expect(text).toContain('+ bar');
		expect(text).not.toContain('Request');
		expect(text).not.toContain('Response');
	});

	it('renders subagent prompt and response as markdown', () => {
		const stop = makeEvent({
			kind: 'subagent.stop',
			data: {
				agent_id: 'sa-77',
				agent_type: 'Explore',
				stop_hook_active: false,
				description: 'Investigate **failed** tests',
				last_assistant_message: '- fixed flaky selector\n- updated test waits',
			},
		});
		const result = renderDetailLines(stop, 100);
		const text = stripAnsi(result.lines.join('\n'));
		// Compact header with agent type
		expect(text).toContain('Subagent · Explore');
		// Prompt content rendered (without bold markdown syntax)
		expect(text).toContain('Investigate failed tests');
		// Response content rendered
		expect(text).toContain('fixed flaky selector');
	});

	it('uses compact header without verbose IDs', () => {
		const event = makeEvent({
			event_id: 'evt_very_long_id_abcdefghijklmnopqrstuvwxyz_0123456789',
			session_id: 'sess_very_long_id_abcdefghijklmnopqrstuvwxyz_0123456789',
			run_id: 'run_very_long_id_abcdefghijklmnopqrstuvwxyz_0123456789',
			kind: 'user.prompt',
			data: {prompt: 'hello'},
		});
		const result = renderDetailLines(event, 120);
		const text = stripAnsi(result.lines.join('\n'));
		// Compact header — no IDs shown
		expect(text).not.toContain('Event ID:');
		expect(text).not.toContain('Session ID:');
		expect(text).not.toContain('Run ID:');
		// Content is still shown
		expect(text).toContain('hello');
	});

	it('splits multiline tool.failure error into individual lines', () => {
		const event = makeEvent({
			kind: 'tool.failure',
			data: {
				tool_name: 'Bash',
				tool_input: {command: 'npx playwright test'},
				error:
					'Exit code 1\n\nRunning 10 tests using 8 workers\n\n  ✓ 2 [chromium] › test.spec.ts:51:7 › Login\n  ✗ 3 [chromium] › test.spec.ts:80:7 › Signup',
				is_interrupt: false,
			},
		});
		const result = renderDetailLines(event, 120);
		// Every element in lines should be a single line (no embedded newlines)
		for (const line of result.lines) {
			expect(line).not.toContain('\n');
		}
		// The error content should be fully present
		const joined = result.lines.join('\n');
		expect(joined).toContain('Exit code 1');
		expect(joined).toContain('Running 10 tests');
		expect(joined).toContain('Login');
		expect(joined).toContain('Signup');
		// Should have significantly more than 5 lines
		expect(result.lines.length).toBeGreaterThan(5);
	});

	it('wraps long tool.failure lines to detail width', () => {
		const event = makeEvent({
			kind: 'tool.failure',
			data: {
				tool_name: 'Bash',
				tool_input: {
					command:
						'npx playwright test tests/google-search.spec.ts --project=chromium --workers=1 --reporter=line',
				},
				error:
					'Exit code 1\n' +
					'Running 16 tests using 1 worker and this line is intentionally very very very very very long to test wrapping behavior',
				is_interrupt: false,
			},
		});
		const width = 58;
		const result = renderDetailLines(event, width);
		const maxLineWidth = Math.max(
			...result.lines.map(line => stringWidth(stripAnsi(line))),
		);
		expect(maxLineWidth).toBeLessThanOrEqual(width);
	});

	it('falls back to JSON for unknown event kinds', () => {
		const event = makeEvent({
			kind: 'session.start',
			data: {source: 'startup', model: 'claude'},
		});
		const result = renderDetailLines(event, 80);
		expect(result.showLineNumbers).toBe(true);
		expect(result.lines.length).toBeGreaterThan(0);
	});

	it('shows Glob pattern as subject line', () => {
		const pre = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name: 'Glob',
				tool_input: {pattern: 'tests/**/*.spec.{ts,js}'},
				tool_use_id: 'glob-1',
			},
		});
		const post = makeEvent({
			kind: 'tool.post',
			data: {
				tool_name: 'Glob',
				tool_input: {pattern: 'tests/**/*.spec.{ts,js}'},
				tool_response: {
					filenames: ['tests/add-ticket.spec.ts', 'tests/filter.spec.ts'],
				},
				tool_use_id: 'glob-1',
			},
		});
		const result = renderDetailLines(pre, 80, post);
		const text = stripAnsi(result.lines.join('\n'));
		// Subject shows pattern directly
		expect(text).toContain('tests/**/*.spec.{ts,js}');
		// Results shown directly
		expect(text).toContain('add-ticket.spec.ts');
		expect(text).toContain('filter.spec.ts');
	});

	it('shows Grep pattern as subject line', () => {
		const pre = makeEvent({
			kind: 'tool.pre',
			data: {
				tool_name: 'Grep',
				tool_input: {
					pattern: 'TC-[A-Z]+-\\d+',
					glob: '*.spec.ts',
					path: '/project/tests',
				},
				tool_use_id: 'grep-1',
			},
		});
		const result = renderDetailLines(pre, 80);
		const text = stripAnsi(result.lines.join('\n'));
		// Subject shows pattern and glob
		expect(text).toContain('"TC-[A-Z]+-\\d+"');
		expect(text).toContain('*.spec.ts');
	});

	it('shows FAILED indicator in header for tool failures', () => {
		const event = makeEvent({
			kind: 'tool.failure',
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/missing.ts'},
				error: 'File not found',
				is_interrupt: false,
			},
		});
		const result = renderDetailLines(event, 80);
		const text = stripAnsi(result.lines.join('\n'));
		expect(text).toContain('FAILED');
		expect(text).toContain('/missing.ts');
		expect(text).toContain('File not found');
	});
});
