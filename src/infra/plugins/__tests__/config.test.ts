import {describe, it, expect, vi, beforeEach} from 'vitest';

const files: Record<string, string> = {};

vi.mock('node:fs', () => ({
	default: {
		existsSync: (p: string) => p in files,
		readFileSync: (p: string) => {
			if (!(p in files)) throw new Error(`ENOENT: ${p}`);
			return files[p];
		},
		mkdirSync: () => undefined,
		writeFileSync: (p: string, content: string) => {
			files[p] = content;
		},
	},
}));

vi.mock('node:os', () => ({
	default: {
		homedir: () => '/home/testuser',
	},
}));

const resolveMarketplacePluginMock = vi.fn();

vi.mock('../marketplace', () => ({
	isMarketplaceRef: (entry: string) =>
		/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(entry),
	resolveMarketplacePlugin: (ref: string) => resolveMarketplacePluginMock(ref),
}));

// Import after mocks are set up
const {readConfig, readGlobalConfig, writeGlobalConfig} =
	await import('../config');

beforeEach(() => {
	for (const key of Object.keys(files)) {
		delete files[key];
	}
	resolveMarketplacePluginMock.mockReset();
});

describe('readConfig', () => {
	it('returns empty plugins when config file does not exist', () => {
		expect(readConfig('/project')).toEqual({
			plugins: [],
			additionalDirectories: [],
		});
	});

	it('reads plugins from .athena/config.json', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: ['/absolute/plugin'],
		});

		expect(readConfig('/project')).toEqual({
			plugins: ['/absolute/plugin'],
			additionalDirectories: [],
		});
	});

	it('resolves relative paths against projectDir', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: ['relative/plugin'],
		});

		const result = readConfig('/project');

		expect(result.plugins).toEqual(['/project/relative/plugin']);
	});

	it('passes through absolute paths unchanged', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: ['/absolute/plugin', 'relative/one'],
		});

		const result = readConfig('/project');

		expect(result.plugins).toEqual([
			'/absolute/plugin',
			'/project/relative/one',
		]);
	});

	it('returns empty plugins when plugins key is missing', () => {
		files['/project/.athena/config.json'] = JSON.stringify({});

		expect(readConfig('/project')).toEqual({
			plugins: [],
			additionalDirectories: [],
		});
	});

	it('reads additionalDirectories and resolves relative paths', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
			additionalDirectories: ['/absolute/dir', 'relative/dir'],
		});

		expect(readConfig('/project')).toEqual({
			plugins: [],
			additionalDirectories: ['/absolute/dir', '/project/relative/dir'],
		});
	});
});

describe('model field', () => {
	it('reads model from project config', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			model: 'claude-opus-4-6',
		});

		expect(readConfig('/project').model).toBe('claude-opus-4-6');
	});

	it('reads model from global config', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			model: 'sonnet',
		});

		expect(readGlobalConfig().model).toBe('sonnet');
	});

	it('returns undefined model when not set', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
		});

		expect(readConfig('/project').model).toBeUndefined();
	});
});

describe('readGlobalConfig', () => {
	it('returns empty plugins when global config does not exist', () => {
		expect(readGlobalConfig()).toEqual({
			plugins: [],
			additionalDirectories: [],
		});
	});

	it('reads plugins from ~/.config/athena/config.json', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			plugins: ['/absolute/global-plugin'],
		});

		expect(readGlobalConfig()).toEqual({
			plugins: ['/absolute/global-plugin'],
			additionalDirectories: [],
		});
	});

	it('resolves relative paths against home directory', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			plugins: ['my-plugins/custom'],
		});

		const result = readGlobalConfig();

		expect(result.plugins).toEqual(['/home/testuser/my-plugins/custom']);
	});

	it('returns empty plugins when plugins key is missing', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({});

		expect(readGlobalConfig()).toEqual({
			plugins: [],
			additionalDirectories: [],
		});
	});

	it('reads telemetryDiagnostics from global config', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			telemetryDiagnostics: true,
		});

		expect(readGlobalConfig().telemetryDiagnostics).toBe(true);
	});
});

describe('marketplace ref integration', () => {
	it('delegates marketplace refs to resolveMarketplacePlugin', () => {
		resolveMarketplacePluginMock.mockReturnValue(
			'/resolved/marketplace/plugin',
		);

		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: ['my-plugin@owner/repo'],
		});

		const result = readConfig('/project');

		expect(resolveMarketplacePluginMock).toHaveBeenCalledWith(
			'my-plugin@owner/repo',
		);
		expect(result.plugins).toEqual(['/resolved/marketplace/plugin']);
	});

	it('skips marketplace refs that fail to resolve and warns on stderr', () => {
		resolveMarketplacePluginMock.mockImplementation(() => {
			throw new Error('Plugin "bad-plugin" not found in marketplace');
		});

		const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: ['/absolute/plugin', 'bad-plugin@owner/repo', 'relative/plugin'],
		});

		const result = readConfig('/project');

		expect(result.plugins).toEqual([
			'/absolute/plugin',
			'/project/relative/plugin',
		]);
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining('bad-plugin@owner/repo'),
		);

		stderrSpy.mockRestore();
	});

	it('handles mix of paths and marketplace refs', () => {
		resolveMarketplacePluginMock.mockReturnValue(
			'/resolved/marketplace/plugin',
		);

		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: ['/absolute/plugin', 'my-plugin@owner/repo', 'relative/plugin'],
		});

		const result = readConfig('/project');

		expect(result.plugins).toEqual([
			'/absolute/plugin',
			'/resolved/marketplace/plugin',
			'/project/relative/plugin',
		]);
	});
});

describe('activeWorkflow field', () => {
	it('reads activeWorkflow name from project config', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			activeWorkflow: 'e2e-testing',
		});

		expect(readConfig('/project').activeWorkflow).toBe('e2e-testing');
	});

	it('reads activeWorkflow name from global config', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			activeWorkflow: 'code-review',
		});

		expect(readGlobalConfig().activeWorkflow).toBe('code-review');
	});

	it('returns undefined activeWorkflow when not set', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
		});

		expect(readConfig('/project').activeWorkflow).toBeUndefined();
	});
});

describe('workflowSelections field', () => {
	it('reads workflowSelections from config', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			workflowSelections: {
				'e2e-test-builder': {
					mcpServerOptions: {
						'agent-web-interface': ['--headless'],
					},
				},
			},
		});

		expect(readGlobalConfig().workflowSelections).toEqual({
			'e2e-test-builder': {
				mcpServerOptions: {
					'agent-web-interface': ['--headless'],
				},
			},
		});
	});
});

describe('setupComplete and harness fields', () => {
	it('parses setupComplete and harness fields', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
			setupComplete: true,
			harness: 'claude-code',
		});
		const config = readConfig('/project');
		expect(config.setupComplete).toBe(true);
		expect(config.harness).toBe('claude-code');
	});

	it('returns undefined when not set', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
		});
		const config = readConfig('/project');
		expect(config.setupComplete).toBeUndefined();
		expect(config.harness).toBeUndefined();
	});
});

describe('writeGlobalConfig', () => {
	it('writeGlobalConfig merges with existing config', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			plugins: ['existing'],
			theme: 'dark',
		});
		writeGlobalConfig({setupComplete: true, harness: 'claude-code'});
		const written = JSON.parse(
			files['/home/testuser/.config/athena/config.json']!,
		);
		expect(written.plugins).toEqual(['existing']);
		expect(written.setupComplete).toBe(true);
		expect(written.harness).toBe('claude-code');
	});

	it('writes telemetryDiagnostics preference to global config', () => {
		writeGlobalConfig({telemetryDiagnostics: false});

		const written = JSON.parse(
			files['/home/testuser/.config/athena/config.json']!,
		) as Record<string, unknown>;
		expect(written['telemetryDiagnostics']).toBe(false);
	});

	it('creates config when none exists', () => {
		writeGlobalConfig({harness: 'openai-codex'});
		const written = JSON.parse(
			files['/home/testuser/.config/athena/config.json']!,
		);
		expect(written.harness).toBe('openai-codex');
	});

	it('deep-merges workflowSelections by workflow key', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			workflowSelections: {
				workflowA: {
					mcpServerOptions: {
						serverA: ['--a'],
					},
				},
			},
		});

		writeGlobalConfig({
			workflowSelections: {
				workflowB: {
					mcpServerOptions: {
						serverB: ['--b'],
					},
				},
			},
		});

		const written = JSON.parse(
			files['/home/testuser/.config/athena/config.json']!,
		);
		expect(written.workflowSelections).toEqual({
			workflowA: {
				mcpServerOptions: {
					serverA: ['--a'],
				},
			},
			workflowB: {
				mcpServerOptions: {
					serverB: ['--b'],
				},
			},
		});
	});

	it('removes deprecated workflow and top-level mcpServerOptions keys', () => {
		files['/home/testuser/.config/athena/config.json'] = JSON.stringify({
			workflow: 'legacy-workflow',
			mcpServerOptions: {legacyServer: ['--legacy']},
			activeWorkflow: 'e2e-test-builder',
		});

		writeGlobalConfig({theme: 'dark'});

		const written = JSON.parse(
			files['/home/testuser/.config/athena/config.json']!,
		);
		expect(written).not.toHaveProperty('workflow');
		expect(written).not.toHaveProperty('mcpServerOptions');
		expect(written.activeWorkflow).toBe('e2e-test-builder');
		expect(written.theme).toBe('dark');
	});

	it('normalizes legacy codex harness to openai-codex when reading config', () => {
		files['/project/.athena/config.json'] = JSON.stringify({
			plugins: [],
			harness: 'codex',
		});
		const config = readConfig('/project');
		expect(config.harness).toBe('openai-codex');
	});
});
