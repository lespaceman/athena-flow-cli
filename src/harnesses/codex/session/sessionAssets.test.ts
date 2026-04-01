import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import {resolveCodexMcpConfig} from './sessionAssets';

vi.mock('node:fs');
vi.mock('node:os');

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

describe('resolveCodexMcpConfig', () => {
	const savedEnv = {...process.env};

	beforeEach(() => {
		mockOs.tmpdir.mockReturnValue('/tmp');
		// Clear session env vars so they don't leak into tests
		delete process.env['DISPLAY'];
		delete process.env['XAUTHORITY'];
		delete process.env['WAYLAND_DISPLAY'];
		delete process.env['XDG_RUNTIME_DIR'];
	});

	afterEach(() => {
		process.env = {...savedEnv};
		vi.restoreAllMocks();
	});

	function setupMcpFile(
		servers: Record<string, Record<string, unknown>>,
	): string {
		const configPath = '/tmp/test-mcp.json';
		mockFs.readFileSync.mockReturnValue(JSON.stringify({mcpServers: servers}));
		return configPath;
	}

	it('passes through standard fields without env', () => {
		const configPath = setupMcpFile({
			myServer: {
				command: 'npx',
				args: ['-y', 'my-server@latest'],
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;

		expect(servers['myServer']).toEqual({
			command: 'npx',
			args: ['-y', 'my-server@latest'],
		});
	});

	it('wraps command with shell when env is present', () => {
		const configPath = setupMcpFile({
			'agent-web-interface': {
				command: 'npx',
				args: ['-y', 'agent-web-interface@latest'],
				env: {DISPLAY: ':0'},
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;
		const server = servers['agent-web-interface'];

		expect(server['command']).toBe('sh');
		expect(server['args']).toEqual([
			'-c',
			"export DISPLAY=':0' && exec npx '-y' 'agent-web-interface@latest'",
		]);
		expect(server).not.toHaveProperty('env');
	});

	it('wraps command with multiple env vars', () => {
		const configPath = setupMcpFile({
			myServer: {
				command: 'node',
				args: ['server.js'],
				env: {DISPLAY: ':0', XAUTHORITY: '/tmp/.Xauth', DEBUG: '1'},
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;
		const server = servers['myServer'];

		expect(server['command']).toBe('sh');
		const shellCmd = (server['args'] as string[])[1];
		expect(shellCmd).toContain("export DISPLAY=':0'");
		expect(shellCmd).toContain("export XAUTHORITY='/tmp/.Xauth'");
		expect(shellCmd).toContain("export DEBUG='1'");
		expect(shellCmd).toContain("exec node 'server.js'");
		expect(server).not.toHaveProperty('env');
	});

	it('skips env wrapping when env object is empty', () => {
		const configPath = setupMcpFile({
			myServer: {
				command: 'npx',
				args: ['foo'],
				env: {},
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;
		const server = servers['myServer'];

		expect(server['command']).toBe('npx');
		expect(server['args']).toEqual(['foo']);
		expect(server).not.toHaveProperty('env');
	});

	it('escapes single quotes in env values', () => {
		const configPath = setupMcpFile({
			myServer: {
				command: 'node',
				args: ['server.js'],
				env: {PATH: "/usr/bin:/it's/tricky"},
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;
		const shellCmd = ((servers['myServer']['args'] as string[]) ?? [])[1];
		expect(shellCmd).toContain("export PATH='/usr/bin:/it'\"'\"'s/tricky'");
	});

	it('escapes single quotes in args', () => {
		const configPath = setupMcpFile({
			myServer: {
				command: 'node',
				args: ["it's a test"],
				env: {FOO: 'bar'},
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;
		const shellCmd = ((servers['myServer']['args'] as string[]) ?? [])[1];
		expect(shellCmd).toContain("'it'\"'\"'s a test'");
	});

	it('handles command with no args when env is present', () => {
		const configPath = setupMcpFile({
			myServer: {
				command: 'my-server',
				env: {DISPLAY: ':0'},
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;
		const server = servers['myServer'];

		expect(server['command']).toBe('sh');
		expect(server['args']).toEqual([
			'-c',
			"export DISPLAY=':0' && exec my-server",
		]);
	});

	it('converts bearerTokenEnvVar to snake_case', () => {
		const configPath = setupMcpFile({
			myServer: {
				command: 'npx',
				args: ['server'],
				bearerTokenEnvVar: 'MY_TOKEN',
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;
		const server = servers['myServer'];

		expect(server['bearer_token_env_var']).toBe('MY_TOKEN');
		expect(server).not.toHaveProperty('bearerTokenEnvVar');
	});

	it('strips options field', () => {
		const configPath = setupMcpFile({
			myServer: {
				command: 'npx',
				args: ['server'],
				options: [{label: 'Default', args: ['server']}],
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;

		expect(servers['myServer']).not.toHaveProperty('options');
	});

	it('injects DISPLAY from process.env when not in config', () => {
		process.env['DISPLAY'] = ':0';
		const configPath = setupMcpFile({
			myServer: {
				command: 'npx',
				args: ['server'],
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;
		const server = servers['myServer'];

		expect(server['command']).toBe('sh');
		const shellCmd = (server['args'] as string[])[1];
		expect(shellCmd).toContain("export DISPLAY=':0'");
		expect(shellCmd).toContain("exec npx 'server'");
	});

	it('injects multiple session env vars from process.env', () => {
		process.env['DISPLAY'] = ':0';
		process.env['XAUTHORITY'] = '/run/user/1000/gdm/Xauthority';
		const configPath = setupMcpFile({
			myServer: {
				command: 'npx',
				args: ['server'],
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;
		const shellCmd = ((servers['myServer']['args'] as string[]) ?? [])[1];

		expect(shellCmd).toContain("export DISPLAY=':0'");
		expect(shellCmd).toContain(
			"export XAUTHORITY='/run/user/1000/gdm/Xauthority'",
		);
	});

	it('does not override explicit env values with process.env', () => {
		process.env['DISPLAY'] = ':0';
		const configPath = setupMcpFile({
			myServer: {
				command: 'npx',
				args: ['server'],
				env: {DISPLAY: ':99'},
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;
		const shellCmd = ((servers['myServer']['args'] as string[]) ?? [])[1];

		expect(shellCmd).toContain("export DISPLAY=':99'");
		expect(shellCmd).not.toContain("':0'");
	});

	it('does not shell-wrap when no session env vars are set', () => {
		const configPath = setupMcpFile({
			myServer: {
				command: 'npx',
				args: ['server'],
			},
		});

		const result = resolveCodexMcpConfig(configPath);
		const servers = result?.mcp_servers as Record<
			string,
			Record<string, unknown>
		>;

		expect(servers['myServer']['command']).toBe('npx');
		expect(servers['myServer']['args']).toEqual(['server']);
	});

	it('includes Codex workflow plugin refs for Codex-native plugin install', () => {
		const result = resolveCodexMcpConfig(undefined, {
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
			},
			resolvedPlugins: [
				{
					ref: 'plugin-a@owner/repo',
					pluginName: 'plugin-a',
					marketplaceName: 'owner/repo',
					pluginDir: '/cache/repo/plugin-a',
					claudeArtifactDir: '/cache/repo/plugin-a',
					codexPluginDir: '/cache/repo/plugin-a',
					codexMarketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [],
			agentRoots: [],
			codexPlugins: [],
		});

		expect(result).toEqual({
			_athenaWorkflowCodexPlugins: [
				{
					ref: 'plugin-a@owner/repo',
					pluginName: 'plugin-a',
					marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
				},
			],
		});
	});
});
