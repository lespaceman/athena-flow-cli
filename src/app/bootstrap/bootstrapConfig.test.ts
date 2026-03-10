import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const readGlobalConfigMock = vi.fn();
const readConfigMock = vi.fn();
const registerPluginsMock = vi.fn();
const resolveWorkflowMock = vi.fn();
const installWorkflowPluginsMock = vi.fn();
const readClaudeSettingsModelMock = vi.fn();

vi.mock('../../infra/plugins/index', () => ({
	readGlobalConfig: () => readGlobalConfigMock(),
	readConfig: (projectDir: string) => readConfigMock(projectDir),
	registerPlugins: (
		dirs: string[],
		mcpServerOptions?: Record<string, string[]>,
	) => registerPluginsMock(dirs, mcpServerOptions),
}));

vi.mock('../../core/workflows/index', () => ({
	resolveWorkflow: (name: string) => resolveWorkflowMock(name),
	installWorkflowPlugins: (workflow: unknown) =>
		installWorkflowPluginsMock(workflow),
	compileWorkflowPlan: ({
		workflow,
		pluginDirs,
		pluginMcpConfig,
	}: {
		workflow?: unknown;
		pluginDirs?: string[];
		pluginMcpConfig?: string;
	}) =>
		workflow
			? {
					workflow,
					pluginDirs: pluginDirs ?? installWorkflowPluginsMock(workflow),
					pluginMcpConfig,
				}
			: undefined,
}));

vi.mock('../../harnesses/claude/config/readSettingsModel', () => ({
	readClaudeSettingsModel: (projectDir: string) =>
		readClaudeSettingsModelMock(projectDir),
}));

const {bootstrapRuntimeConfig} = await import('./bootstrapConfig');

const emptyConfig = {plugins: [], additionalDirectories: []};
const initialAnthropicModel = process.env['ANTHROPIC_MODEL'];

describe('bootstrapRuntimeConfig', () => {
	beforeEach(() => {
		delete process.env['ANTHROPIC_MODEL'];
		readGlobalConfigMock.mockReset();
		readConfigMock.mockReset();
		registerPluginsMock.mockReset();
		resolveWorkflowMock.mockReset();
		installWorkflowPluginsMock.mockReset();
		installWorkflowPluginsMock.mockReturnValue([]);
		readClaudeSettingsModelMock.mockReset();
	});

	afterEach(() => {
		if (initialAnthropicModel === undefined) {
			delete process.env['ANTHROPIC_MODEL'];
		} else {
			process.env['ANTHROPIC_MODEL'] = initialAnthropicModel;
		}
	});

	it('re-resolves configured workflow and installs workflow plugins when setup is not shown', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/global-plugin'],
			additionalDirectories: ['/global-dir'],
			activeWorkflow: 'e2e-test-builder',
			workflowSelections: {
				'e2e-test-builder': {
					mcpServerOptions: {
						'agent-web-interface': ['--headless'],
					},
				},
			},
		});
		readConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/project-plugin'],
			additionalDirectories: ['/project-dir'],
			model: 'opus',
		});
		resolveWorkflowMock.mockReturnValue({
			name: 'e2e-test-builder',
			plugins: [],
			promptTemplate: '{input}',
			isolation: 'minimal',
		});
		installWorkflowPluginsMock.mockReturnValue(['/workflow-plugin']);
		registerPluginsMock.mockReturnValue({
			mcpConfig: '/tmp/mcp.json',
			workflows: [],
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			pluginFlags: ['/cli-plugin'],
			isolationPreset: 'strict',
			verbose: true,
		});

		expect(resolveWorkflowMock).toHaveBeenCalledWith('e2e-test-builder');
		expect(registerPluginsMock).toHaveBeenCalledWith(
			['/workflow-plugin', '/global-plugin', '/project-plugin', '/cli-plugin'],
			{
				'agent-web-interface': ['--headless'],
			},
		);
		expect(result.workflow?.name).toBe('e2e-test-builder');
		expect(result.workflowRef).toBe('e2e-test-builder');
		expect(result.workflowPlan).toEqual({
			workflow: result.workflow,
			pluginDirs: ['/workflow-plugin'],
			pluginMcpConfig: '/tmp/mcp.json',
		});
		expect(result.harness).toBe('claude-code');
		expect(result.isolationConfig.preset).toBe('minimal');
		expect(result.isolationConfig.additionalDirectories).toEqual([
			'/global-dir',
			'/project-dir',
		]);
		expect(result.isolationConfig.model).toBe('opus');
		expect(result.modelName).toBe('opus');
		expect(result.warnings).toEqual([
			"Workflow 'e2e-test-builder' requires 'minimal' isolation (upgrading from 'strict')",
		]);
	});

	it('skips resolving configured workflow while setup is shown', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/global-plugin'],
			activeWorkflow: 'e2e-test-builder',
		});
		readConfigMock.mockReturnValue(emptyConfig);
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
			workflows: [
				{
					name: 'plugin-workflow',
					plugins: [],
					promptTemplate: '{input}',
				},
			],
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: true,
			isolationPreset: 'strict',
		});

		expect(resolveWorkflowMock).not.toHaveBeenCalled();
		expect(result.workflow?.name).toBe('plugin-workflow');
		expect(result.workflowRef).toBe('plugin-workflow');
		expect(result.workflowPlan).toEqual({
			workflow: result.workflow,
			pluginDirs: [],
			pluginMcpConfig: undefined,
		});
		expect(result.harness).toBe('claude-code');
		expect(result.modelName).toBe('claude-settings-model');
	});

	it('warns with workflow use command when multiple plugin workflows are found', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/global-plugin'],
		});
		readConfigMock.mockReturnValue(emptyConfig);
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
			workflows: [
				{name: 'alpha', plugins: [], promptTemplate: '{input}'},
				{name: 'beta', plugins: [], promptTemplate: '{input}'},
			],
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: true,
			isolationPreset: 'strict',
		});

		expect(result.warnings).toEqual([
			'Multiple workflows found: alpha, beta. Set one with `athena-flow workflow use <name>`.',
		]);
	});

	it('throws when setup is not shown and active workflow is missing', () => {
		readGlobalConfigMock.mockReturnValue(emptyConfig);
		readConfigMock.mockReturnValue(emptyConfig);

		expect(() =>
			bootstrapRuntimeConfig({
				projectDir: '/project',
				showSetup: false,
				isolationPreset: 'strict',
			}),
		).toThrow(/No active workflow selected/i);
	});

	it('always resolves workflow from global activeWorkflow only', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			activeWorkflow: 'global-workflow',
		});
		readConfigMock.mockReturnValue({
			...emptyConfig,
			workflow: 'project-workflow',
		});
		resolveWorkflowMock.mockReturnValue({
			name: 'global-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});
		installWorkflowPluginsMock.mockReturnValue([]);
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
			workflows: [],
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(resolveWorkflowMock).toHaveBeenCalledWith('global-workflow');
	});

	it('does not probe Claude-specific model sources for non-claude harnesses', () => {
		process.env['ANTHROPIC_MODEL'] = 'anthropic-env-model';
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			harness: 'openai-codex',
			activeWorkflow: 'non-claude-workflow',
		});
		readConfigMock.mockReturnValue(emptyConfig);
		resolveWorkflowMock.mockReturnValue({
			name: 'non-claude-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});
		installWorkflowPluginsMock.mockReturnValue([]);
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
			workflows: [],
		});
		readClaudeSettingsModelMock.mockReturnValue('claude-settings-model');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(result.harness).toBe('openai-codex');
		expect(result.modelName).toBe('gpt-5.3-codex');
		expect(readClaudeSettingsModelMock).not.toHaveBeenCalled();
	});
});
