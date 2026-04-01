import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const readGlobalConfigMock = vi.fn();
const readConfigMock = vi.fn();
const registerPluginsMock = vi.fn();
const buildPluginMcpConfigMock = vi.fn();
const resolveWorkflowMock = vi.fn();
const installWorkflowPluginsMock = vi.fn();
const resolveWorkflowPluginsMock = vi.fn();
const readClaudeSettingsModelMock = vi.fn();

vi.mock('../../infra/plugins/index', () => ({
	readGlobalConfig: () => readGlobalConfigMock(),
	readConfig: (projectDir: string) => readConfigMock(projectDir),
	registerPlugins: (
		dirs: string[],
		mcpServerOptions?: Record<string, string[]>,
		includeMcpConfig?: boolean,
	) => registerPluginsMock(dirs, mcpServerOptions, includeMcpConfig),
	buildPluginMcpConfig: (
		dirs: string[],
		mcpServerOptions?: Record<string, string[]>,
	) => buildPluginMcpConfigMock(dirs, mcpServerOptions),
}));

vi.mock('../../core/workflows/index', () => ({
	resolveWorkflow: (name: string) => resolveWorkflowMock(name),
	installWorkflowPlugins: (workflow: unknown) =>
		installWorkflowPluginsMock(workflow),
	resolveWorkflowPlugins: (workflow: unknown) =>
		resolveWorkflowPluginsMock(workflow),
	compileWorkflowPlan: ({
		workflow,
		resolvedPlugins,
		localPlugins,
		codexPlugins,
		pluginMcpConfig,
	}: {
		workflow?: unknown;
		resolvedPlugins?: Array<{
			ref: string;
			pluginName: string;
			claudeArtifactDir: string;
			codexMarketplacePath: string;
		}>;
		localPlugins?: unknown[];
		codexPlugins?: unknown[];
		pluginMcpConfig?: string;
	}) => {
		if (!workflow) return undefined;
		const resolved = resolveWorkflowPluginsMock(workflow);
		const rp = resolvedPlugins ?? resolved?.resolvedPlugins ?? [];
		const lp =
			localPlugins ??
			rp.map((plugin: {ref: string; claudeArtifactDir: string}) => ({
				ref: plugin.ref,
				pluginDir: plugin.claudeArtifactDir,
			})) ??
			resolved?.localPlugins ??
			[];
		const cp =
			codexPlugins ??
			rp.map(
				(plugin: {
					ref: string;
					pluginName: string;
					codexMarketplacePath: string;
				}) => ({
					ref: plugin.ref,
					pluginName: plugin.pluginName,
					marketplacePath: plugin.codexMarketplacePath,
				}),
			) ??
			resolved?.codexPlugins ??
			[];
		return {
			workflow,
			resolvedPlugins: rp,
			localPlugins: lp,
			agentRoots: (rp as Array<{claudeArtifactDir: string}>).map(
				plugin => `${plugin.claudeArtifactDir}/agents`,
			),
			codexPlugins: cp,
			pluginMcpConfig,
		};
	},
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
		buildPluginMcpConfigMock.mockReset();
		resolveWorkflowMock.mockReset();
		installWorkflowPluginsMock.mockReset();
		installWorkflowPluginsMock.mockReturnValue([]);
		resolveWorkflowPluginsMock.mockReset();
		resolveWorkflowPluginsMock.mockReturnValue({
			resolvedPlugins: [],
			localPlugins: [],
			codexPlugins: [],
		});
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
		resolveWorkflowPluginsMock.mockReturnValue({
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath:
						'/workflow-marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			codexPlugins: [],
		});
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
			true,
		);
		expect(result.workflow?.name).toBe('e2e-test-builder');
		expect(result.workflowRef).toBe('e2e-test-builder');
		expect(result.workflowPlan).toEqual({
			workflow: result.workflow,
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath:
						'/workflow-marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			agentRoots: ['/workflow-plugin/agents'],
			codexPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplacePath:
						'/workflow-marketplace/.agents/plugins/marketplace.json',
				},
			],
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
			resolvedPlugins: [],
			localPlugins: [],
			agentRoots: [],
			codexPlugins: [],
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

	it('defaults to "default" workflow when no active workflow is configured', () => {
		const defaultWorkflow = {
			name: 'default',
			plugins: [],
			promptTemplate: '{input}',
		};
		readGlobalConfigMock.mockReturnValue(emptyConfig);
		readConfigMock.mockReturnValue(emptyConfig);
		resolveWorkflowMock.mockReturnValue(defaultWorkflow);
		installWorkflowPluginsMock.mockReturnValue([]);

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(resolveWorkflowMock).toHaveBeenCalledWith('default');
		expect(result.workflowRef).toBe('default');
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

	it('uses harnessOverride when provided, ignoring config', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			harness: 'openai-codex',
		});
		readConfigMock.mockReturnValue(emptyConfig);
		registerPluginsMock.mockReturnValue({
			mcpConfig: undefined,
			workflows: [],
		});

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
			harnessOverride: 'claude-code',
		});

		expect(result.harness).toBe('claude-code');
	});

	it('keeps workflow plugin MCP merging for Claude harnesses', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			activeWorkflow: 'claude-workflow',
		});
		readConfigMock.mockReturnValue(emptyConfig);
		resolveWorkflowMock.mockReturnValue({
			name: 'claude-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});
		installWorkflowPluginsMock.mockReturnValue(['/workflow-plugin']);
		resolveWorkflowPluginsMock.mockReturnValue({
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			codexPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
		});
		registerPluginsMock.mockReturnValue({
			mcpConfig: '/tmp/workflow-mcp.json',
			workflows: [],
		});

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			isolationPreset: 'strict',
		});

		expect(buildPluginMcpConfigMock).not.toHaveBeenCalled();
		expect(result.pluginMcpConfig).toBe('/tmp/workflow-mcp.json');
		expect(result.workflowPlan).toEqual({
			workflow: result.workflow,
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			agentRoots: ['/workflow-plugin/agents'],
			codexPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			pluginMcpConfig: '/tmp/workflow-mcp.json',
		});
	});

	it('limits Codex MCP config to workflow plugin MCP only', () => {
		readGlobalConfigMock.mockReturnValue({
			...emptyConfig,
			harness: 'openai-codex',
			activeWorkflow: 'codex-workflow',
			plugins: ['/global-plugin'],
		});
		readConfigMock.mockReturnValue({
			...emptyConfig,
			plugins: ['/project-plugin'],
		});
		resolveWorkflowMock.mockReturnValue({
			name: 'codex-workflow',
			plugins: [],
			promptTemplate: '{input}',
		});
		resolveWorkflowPluginsMock.mockReturnValue({
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			codexPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
		});
		registerPluginsMock.mockReturnValue({
			mcpConfig: '/tmp/all-plugin-mcp.json',
			workflows: [],
		});
		buildPluginMcpConfigMock.mockReturnValue('/tmp/workflow-only-mcp.json');

		const result = bootstrapRuntimeConfig({
			projectDir: '/project',
			showSetup: false,
			pluginFlags: ['/cli-plugin'],
			isolationPreset: 'strict',
		});

		expect(registerPluginsMock).toHaveBeenCalledWith(
			['/global-plugin', '/project-plugin', '/cli-plugin'],
			undefined,
			false,
		);
		expect(buildPluginMcpConfigMock).toHaveBeenCalledWith(
			['/workflow-plugin'],
			undefined,
		);
		expect(result.pluginMcpConfig).toBeUndefined();
		expect(result.workflowPlan).toEqual({
			workflow: result.workflow,
			resolvedPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplaceName: 'marketplace',
					pluginDir: '/workflow-plugin',
					claudeArtifactDir: '/workflow-plugin',
					codexPluginDir: '/workflow-plugin',
					codexMarketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			localPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginDir: '/workflow-plugin',
				},
			],
			agentRoots: ['/workflow-plugin/agents'],
			codexPlugins: [
				{
					ref: 'plugin@marketplace',
					pluginName: 'plugin',
					marketplacePath: '/marketplace/.agents/plugins/marketplace.json',
				},
			],
			pluginMcpConfig: '/tmp/workflow-only-mcp.json',
		});
	});
});
