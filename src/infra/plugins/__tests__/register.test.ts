import {describe, it, expect, vi, beforeEach} from 'vitest';
import {buildPluginMcpConfig, registerPlugins} from '../register';
import {clear, get} from '../../../app/commands/registry';

// Virtual file system for tests
const files: Record<string, string> = {};

vi.mock('node:fs', () => ({
	default: {
		existsSync: (p: string) => p in files,
		readFileSync: (p: string) => {
			if (!(p in files)) throw new Error(`ENOENT: ${p}`);
			return files[p];
		},
		readdirSync: (dir: string) => {
			const prefix = dir.endsWith('/') ? dir : dir + '/';
			const names = new Set<string>();
			for (const key of Object.keys(files)) {
				if (key.startsWith(prefix)) {
					const rest = key.slice(prefix.length);
					const firstSegment = rest.split('/')[0]!;
					names.add(firstSegment);
				}
			}
			return [...names].map(name => ({
				name,
				isDirectory: () => {
					const full = prefix + name + '/';
					return Object.keys(files).some(k => k.startsWith(full));
				},
			}));
		},
		writeFileSync: vi.fn(),
	},
}));

const manifest = JSON.stringify({
	name: 'test-plugin',
	description: 'A test plugin',
	version: '1.0.0',
});

function addPlugin(
	dir: string,
	opts?: {
		mcpServers?: Record<string, unknown>;
		skillName?: string;
		workflow?: Record<string, unknown>;
	},
) {
	files[dir] = '';
	files[`${dir}/.claude-plugin/plugin.json`] = manifest;
	files[`${dir}/skills`] = '';

	if (opts?.mcpServers) {
		files[`${dir}/.mcp.json`] = JSON.stringify({mcpServers: opts.mcpServers});
	}

	if (opts?.workflow) {
		files[`${dir}/workflow.json`] = JSON.stringify(opts.workflow);
	}

	if (opts?.skillName) {
		files[`${dir}/skills/${opts.skillName}/SKILL.md`] =
			`---\nname: ${opts.skillName}\ndescription: Test\nuser-invocable: true\n---\nBody`;
	}
}

beforeEach(() => {
	for (const key of Object.keys(files)) {
		delete files[key];
	}
	clear();
	vi.clearAllMocks();
});

describe('registerPlugins', () => {
	it('returns undefined mcpConfig when no plugins have MCP configs', () => {
		addPlugin('/plugins/a', {skillName: 'cmd-a'});

		const result = registerPlugins(['/plugins/a']);

		expect(result.mcpConfig).toBeUndefined();
		expect(result.workflows).toEqual([]);
	});

	it('returns a merged MCP config path when plugins have .mcp.json', () => {
		addPlugin('/plugins/a', {
			mcpServers: {server1: {command: 'node', args: ['s1.js']}},
			skillName: 'cmd-a',
		});

		const result = registerPlugins(['/plugins/a']);

		expect(result.mcpConfig).toBeDefined();
		expect(typeof result.mcpConfig).toBe('string');
	});

	it('merges mcpServers from multiple plugins', async () => {
		const fs = await import('node:fs');

		addPlugin('/plugins/a', {
			mcpServers: {serverA: {command: 'node', args: ['a.js']}},
			skillName: 'cmd-a',
		});
		addPlugin('/plugins/b', {
			mcpServers: {serverB: {command: 'node', args: ['b.js']}},
			skillName: 'cmd-b',
		});

		registerPlugins(['/plugins/a', '/plugins/b']);

		const writeCall = vi.mocked(fs.default.writeFileSync).mock.calls[0];
		expect(writeCall).toBeDefined();
		const written = JSON.parse(writeCall![1] as string);
		expect(written.mcpServers).toHaveProperty('serverA');
		expect(written.mcpServers).toHaveProperty('serverB');
	});

	it('skips plugins without .mcp.json when merging', async () => {
		const fs = await import('node:fs');

		addPlugin('/plugins/a', {
			mcpServers: {serverA: {command: 'node', args: ['a.js']}},
			skillName: 'cmd-a',
		});
		addPlugin('/plugins/b', {skillName: 'cmd-b'});

		registerPlugins(['/plugins/a', '/plugins/b']);

		const writeCall = vi.mocked(fs.default.writeFileSync).mock.calls[0];
		expect(writeCall).toBeDefined();
		const written = JSON.parse(writeCall![1] as string);
		expect(written.mcpServers).toHaveProperty('serverA');
		expect(written.mcpServers).not.toHaveProperty('serverB');
	});

	it('still registers commands alongside MCP config merging', () => {
		addPlugin('/plugins/a', {
			mcpServers: {serverA: {command: 'node', args: ['a.js']}},
			skillName: 'cmd-a',
		});

		registerPlugins(['/plugins/a']);

		// Commands should still be registered
		expect(get('cmd-a')).toBeDefined();
	});

	it('throws when multiple plugins define the same MCP server name', () => {
		addPlugin('/plugins/a', {
			mcpServers: {database: {command: 'pg-server'}},
		});
		addPlugin('/plugins/b', {
			mcpServers: {database: {command: 'mysql-server'}},
		});

		expect(() => registerPlugins(['/plugins/a', '/plugins/b'])).toThrow(
			/MCP server name collision.*"database"/,
		);
	});

	it('allows different MCP server names across plugins', () => {
		addPlugin('/plugins/a', {
			mcpServers: {serverA: {command: 'a'}},
		});
		addPlugin('/plugins/b', {
			mcpServers: {serverB: {command: 'b'}},
		});

		expect(() => registerPlugins(['/plugins/a', '/plugins/b'])).not.toThrow();
	});

	it('discovers workflow.json from plugin directories', () => {
		const workflow = {
			name: 'e2e-test-builder',
			promptTemplate: 'Use /add-e2e-tests {input}',
			loop: {
				enabled: true,
				completionPromise: 'E2E COMPLETE',
				maxIterations: 15,
			},
			isolation: 'minimal',
		};
		addPlugin('/plugins/a', {workflow});

		const result = registerPlugins(['/plugins/a']);

		expect(result.workflows).toHaveLength(1);
		expect(result.workflows[0]!.name).toBe('e2e-test-builder');
		expect(result.workflows[0]!.promptTemplate).toBe(
			'Use /add-e2e-tests {input}',
		);
	});

	it('returns empty workflows array when no workflow.json exists', () => {
		addPlugin('/plugins/a');

		const result = registerPlugins(['/plugins/a']);

		expect(result.workflows).toEqual([]);
	});

	it('applies mcpServerOptions to override server args', async () => {
		const fs = await import('node:fs');

		addPlugin('/plugins/a', {
			mcpServers: {
				'agent-web-interface': {
					command: 'npx',
					args: ['agent-web-interface'],
					options: [
						{label: 'Visible', args: []},
						{label: 'Headless', args: ['--headless']},
					],
				},
			},
		});

		registerPlugins(['/plugins/a'], {
			'agent-web-interface': ['--headless'],
		});

		const writeCall = vi.mocked(fs.default.writeFileSync).mock.calls[0];
		const written = JSON.parse(writeCall![1] as string);
		expect(written.mcpServers['agent-web-interface'].args).toEqual([
			'--headless',
		]);
	});

	it('strips options field from written MCP config', async () => {
		const fs = await import('node:fs');

		addPlugin('/plugins/a', {
			mcpServers: {
				'my-server': {
					command: 'npx',
					args: ['my-server'],
					options: [
						{label: 'Default', args: []},
						{label: 'Custom', args: ['--custom']},
					],
				},
			},
		});

		registerPlugins(['/plugins/a']);

		const writeCall = vi.mocked(fs.default.writeFileSync).mock.calls[0];
		const written = JSON.parse(writeCall![1] as string);
		expect(written.mcpServers['my-server']).not.toHaveProperty('options');
	});

	it('preserves original args when no mcpServerOptions provided', async () => {
		const fs = await import('node:fs');

		addPlugin('/plugins/a', {
			mcpServers: {
				'my-server': {
					command: 'npx',
					args: ['my-server', '--default'],
					options: [{label: 'Default', args: ['--default']}],
				},
			},
		});

		registerPlugins(['/plugins/a']);

		const writeCall = vi.mocked(fs.default.writeFileSync).mock.calls[0];
		const written = JSON.parse(writeCall![1] as string);
		expect(written.mcpServers['my-server'].args).toEqual([
			'my-server',
			'--default',
		]);
	});
});

describe('buildPluginMcpConfig', () => {
	it('builds MCP config for a subset of plugin dirs', async () => {
		const fs = await import('node:fs');
		addPlugin('/plugins/a', {
			mcpServers: {serverA: {command: 'node', args: ['a.js']}},
		});
		addPlugin('/plugins/b', {
			mcpServers: {serverB: {command: 'node', args: ['b.js']}},
		});

		buildPluginMcpConfig(['/plugins/b']);

		const writeCall = vi.mocked(fs.default.writeFileSync).mock.calls[0];
		const written = JSON.parse(writeCall![1] as string);
		expect(written.mcpServers).toHaveProperty('serverB');
		expect(written.mcpServers).not.toHaveProperty('serverA');
	});
});

describe('registerPlugins with MCP disabled', () => {
	it('discovers workflows and commands without building MCP config', async () => {
		const fs = await import('node:fs');
		addPlugin('/plugins/a', {
			mcpServers: {serverA: {command: 'node', args: ['a.js']}},
			skillName: 'cmd-a',
			workflow: {
				name: 'test-workflow',
				plugins: [],
				promptTemplate: '{input}',
			},
		});

		const result = registerPlugins(['/plugins/a'], undefined, false);

		expect(result.mcpConfig).toBeUndefined();
		expect(result.workflows).toEqual([
			{
				name: 'test-workflow',
				plugins: [],
				promptTemplate: '{input}',
			},
		]);
		expect(get('cmd-a')).toBeDefined();
		expect(vi.mocked(fs.default.writeFileSync)).not.toHaveBeenCalled();
	});
});
