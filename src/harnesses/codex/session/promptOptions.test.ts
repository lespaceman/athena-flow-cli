import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const files: Record<string, string> = {};

vi.mock('node:fs', () => ({
	default: {
		existsSync: (filePath: string) => filePath in files,
		readFileSync: (filePath: string) => {
			if (!(filePath in files)) {
				throw new Error(`ENOENT: ${filePath}`);
			}
			return files[filePath]!;
		},
	},
}));

const {buildCodexPromptOptions} = await import('./promptOptions');

describe('buildCodexPromptOptions', () => {
	const savedEnv = {...process.env};

	beforeEach(() => {
		for (const key of Object.keys(files)) {
			delete files[key];
		}
		// Clear session env vars so they don't leak into MCP shell wrapping
		delete process.env['DISPLAY'];
		delete process.env['XAUTHORITY'];
		delete process.env['WAYLAND_DISPLAY'];
		delete process.env['XDG_RUNTIME_DIR'];
	});

	afterEach(() => {
		process.env = {...savedEnv};
	});

	it('merges session id, process model, and workflow overrides into Codex prompt options', () => {
		expect(
			buildCodexPromptOptions({
				processConfig: {model: 'gpt-5.3-codex'},
				continuation: {mode: 'resume', handle: 'thread-123'},
				configOverride: {
					developerInstructions: 'Use the workflow tracker.',
				},
			}),
		).toEqual({
			continuation: {mode: 'resume', handle: 'thread-123'},
			model: 'gpt-5.3-codex',
			developerInstructions: 'Use the workflow tracker.',
			skillRoots: undefined,
			config: undefined,
			ephemeral: undefined,
			approvalPolicy: 'on-request',
			sandbox: 'workspace-write',
		});
	});

	it('lets per-turn model overrides win over the base process config', () => {
		expect(
			buildCodexPromptOptions({
				processConfig: {model: 'gpt-5.3-codex'},
				configOverride: {model: 'gpt-5.4-codex'},
			}),
		).toEqual({
			continuation: undefined,
			model: 'gpt-5.4-codex',
			developerInstructions: undefined,
			skillRoots: undefined,
			config: undefined,
			ephemeral: undefined,
			approvalPolicy: 'on-request',
			sandbox: 'workspace-write',
		});
	});

	it('uses workflow MCP config without deriving filesystem roots for Codex plugins', () => {
		files['/tmp/plugin-mcp.json'] = JSON.stringify({
			mcpServers: {
				'agent-web-interface': {
					command: 'npx',
					args: ['-y', 'agent-web-interface@latest'],
					bearerTokenEnvVar: 'AGENT_TOKEN',
					options: [{label: 'Headless', args: ['--headless']}],
				},
			},
		});
		expect(
			buildCodexPromptOptions({
				workflowPlan: {
					workflow: {
						name: 'e2e-test-builder',
						plugins: [],
						promptTemplate: '{input}',
					},
					pluginDirs: ['/plugins/e2e-test-builder', '/plugins/md-export'],
					pluginTargets: [],
					pluginMcpConfig: '/tmp/plugin-mcp.json',
				},
			}),
		).toEqual({
			continuation: undefined,
			model: undefined,
			developerInstructions: undefined,
			skillRoots: undefined,
			agentRoots: undefined,
			config: {
				mcp_servers: {
					'agent-web-interface': {
						command: 'npx',
						args: ['-y', 'agent-web-interface@latest'],
						bearer_token_env_var: 'AGENT_TOKEN',
					},
				},
			},
			ephemeral: undefined,
			approvalPolicy: 'on-request',
			sandbox: 'workspace-write',
		});
	});

	it('maps isolation preset to Codex approvalPolicy and sandbox', () => {
		expect(
			buildCodexPromptOptions({
				processConfig: {preset: 'strict'},
			}),
		).toEqual(
			expect.objectContaining({
				approvalPolicy: 'on-request',
				sandbox: 'locked-network',
			}),
		);

		expect(
			buildCodexPromptOptions({
				processConfig: {preset: 'permissive'},
			}),
		).toEqual(
			expect.objectContaining({
				approvalPolicy: 'auto-edit',
				sandbox: 'workspace-write',
			}),
		);

		expect(
			buildCodexPromptOptions({
				processConfig: {preset: 'minimal'},
			}),
		).toEqual(
			expect.objectContaining({
				approvalPolicy: 'on-request',
				sandbox: 'workspace-write',
			}),
		);
	});

	it('defaults to on-request / workspace-write when no isolation is specified', () => {
		expect(buildCodexPromptOptions({})).toEqual(
			expect.objectContaining({
				approvalPolicy: 'on-request',
				sandbox: 'workspace-write',
			}),
		);
	});

	it('merges pluginMcpConfig into Codex config alongside workflow MCP config', () => {
		files['/tmp/plugin-mcp.json'] = JSON.stringify({
			mcpServers: {
				'plugin-server': {
					command: 'node',
					args: ['server.js'],
				},
			},
		});
		files['/tmp/workflow-mcp.json'] = JSON.stringify({
			mcpServers: {
				'workflow-server': {
					command: 'npx',
					args: ['workflow-tool'],
				},
			},
		});
		const result = buildCodexPromptOptions({
			pluginMcpConfig: '/tmp/plugin-mcp.json',
			workflowPlan: {
				workflow: {
					name: 'test',
					plugins: [],
					promptTemplate: '{input}',
				},
				pluginDirs: [],
				pluginTargets: [],
				pluginMcpConfig: '/tmp/workflow-mcp.json',
			},
		});
		expect(result.config).toEqual({
			mcp_servers: {
				'plugin-server': {
					command: 'node',
					args: ['server.js'],
				},
				'workflow-server': {
					command: 'npx',
					args: ['workflow-tool'],
				},
			},
		});
	});

	it('passes pluginMcpConfig even without a workflowPlan', () => {
		files['/tmp/plugin-mcp.json'] = JSON.stringify({
			mcpServers: {
				'plugin-server': {
					command: 'node',
					args: ['server.js'],
				},
			},
		});
		const result = buildCodexPromptOptions({
			pluginMcpConfig: '/tmp/plugin-mcp.json',
		});
		expect(result.config).toEqual({
			mcp_servers: {
				'plugin-server': {
					command: 'node',
					args: ['server.js'],
				},
			},
		});
	});

	it('threads ephemeral through to Codex prompt options', () => {
		expect(
			buildCodexPromptOptions({
				ephemeral: true,
			}),
		).toEqual({
			continuation: undefined,
			model: undefined,
			developerInstructions: undefined,
			skillRoots: undefined,
			agentRoots: undefined,
			config: undefined,
			ephemeral: true,
			approvalPolicy: 'on-request',
			sandbox: 'workspace-write',
		});
	});

	it('does not derive workflow agent or skill roots from plugin dirs', () => {
		const result = buildCodexPromptOptions({
			workflowPlan: {
				workflow: {
					name: 'test',
					plugins: [],
					promptTemplate: '{input}',
				},
				pluginDirs: ['/plugins/my-plugin'],
				pluginTargets: [],
			},
		});
		expect(result.agentRoots).toBeUndefined();
		expect(result.skillRoots).toBeUndefined();
	});
});
