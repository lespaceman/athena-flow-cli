import {beforeEach, describe, expect, it, vi} from 'vitest';

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
	beforeEach(() => {
		for (const key of Object.keys(files)) {
			delete files[key];
		}
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
		});
	});

	it('resolves workflow skill roots and Codex mcp config from workflow artifacts', () => {
		files['/plugins/e2e-test-builder/skills'] = '';
		files['/plugins/md-export/skills'] = '';
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
					pluginMcpConfig: '/tmp/plugin-mcp.json',
				},
			}),
		).toEqual({
			continuation: undefined,
			model: undefined,
			developerInstructions: undefined,
			skillRoots: [
				'/plugins/e2e-test-builder/skills',
				'/plugins/md-export/skills',
			],
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
			config: undefined,
			ephemeral: true,
		});
	});
});
