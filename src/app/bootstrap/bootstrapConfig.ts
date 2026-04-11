import {
	registerPlugins,
	buildPluginMcpConfig,
	readConfig,
	readGlobalConfig,
	resolveActiveWorkflow,
	type AthenaConfig,
	type AthenaHarness,
} from '../../infra/plugins/index';
import {shouldResolveWorkflow} from '../../setup/shouldResolveWorkflow';
import type {
	HarnessProcessConfig,
	HarnessProcessPreset,
} from '../../core/runtime/process';
import {
	compileWorkflowPlan,
	resolveWorkflowPlugins,
	resolveWorkflow,
} from '../../core/workflows/index';
import type {
	ResolvedWorkflowPlugin,
	WorkflowConfig,
	WorkflowPlan,
} from '../../core/workflows';
import {DEFAULT_HARNESS} from '../runtime/createRuntime';
import {resolveHarnessConfigProfile} from '../../harnesses/configProfiles';

export type RuntimeBootstrapInput = {
	projectDir: string;
	showSetup: boolean;
	pluginFlags?: string[];
	isolationPreset: HarnessProcessPreset;
	verbose?: boolean;
	globalConfig?: AthenaConfig;
	projectConfig?: AthenaConfig;
	/** CLI --harness override (highest priority). */
	harnessOverride?: AthenaHarness;
	/** CLI --workflow override (highest priority for workflow selection). */
	workflowOverride?: string;
};

export type RuntimeBootstrapOutput = {
	globalConfig: AthenaConfig;
	projectConfig: AthenaConfig;
	harness: AthenaHarness;
	isolationConfig: HarnessProcessConfig;
	pluginMcpConfig?: string;
	workflowRef?: string;
	workflow?: WorkflowConfig;
	workflowPlan?: WorkflowPlan;
	modelName: string | null;
	warnings: string[];
};

function mergePluginDirs({
	workflowPluginDirs,
	globalPlugins,
	projectPlugins,
	pluginFlags,
}: {
	workflowPluginDirs: string[];
	globalPlugins: string[];
	projectPlugins: string[];
	pluginFlags: string[];
}): string[] {
	return [
		...new Set([
			...workflowPluginDirs,
			...globalPlugins,
			...projectPlugins,
			...pluginFlags,
		]),
	];
}

export function bootstrapRuntimeConfig({
	projectDir,
	showSetup,
	pluginFlags = [],
	isolationPreset: initialIsolationPreset,
	verbose = false,
	globalConfig: providedGlobalConfig,
	projectConfig: providedProjectConfig,
	harnessOverride,
	workflowOverride,
}: RuntimeBootstrapInput): RuntimeBootstrapOutput {
	const globalConfig = providedGlobalConfig ?? readGlobalConfig();
	const projectConfig = providedProjectConfig ?? readConfig(projectDir);
	const warnings: string[] = [];
	const harness =
		harnessOverride ??
		projectConfig.harness ??
		globalConfig.harness ??
		DEFAULT_HARNESS;
	const activeWorkflowSelection = resolveActiveWorkflow({
		globalConfig,
		projectConfig,
		override: workflowOverride,
	});
	const configuredActiveWorkflow = activeWorkflowSelection.name;
	const activeWorkflowConfig = activeWorkflowSelection.selectionsLayer;

	let workflowPluginDirs: string[] = [];
	let workflowResolvedPlugins: ResolvedWorkflowPlugin[] = [];
	let resolvedWorkflow: WorkflowConfig | undefined;

	const workflowToResolve = shouldResolveWorkflow({
		showSetup,
		workflowName: configuredActiveWorkflow,
	})
		? configuredActiveWorkflow
		: undefined;

	if (workflowToResolve) {
		resolvedWorkflow = resolveWorkflow(workflowToResolve);
		const plugins = resolveWorkflowPlugins(resolvedWorkflow);
		workflowResolvedPlugins = plugins.resolvedPlugins;
		workflowPluginDirs = workflowResolvedPlugins.map(
			plugin => plugin.claudeArtifactDir,
		);
	}

	const pluginDirs = mergePluginDirs({
		workflowPluginDirs: harness === 'openai-codex' ? [] : workflowPluginDirs,
		globalPlugins: globalConfig.plugins,
		projectPlugins: projectConfig.plugins,
		pluginFlags,
	});
	const pluginResult =
		pluginDirs.length > 0
			? registerPlugins(
					pluginDirs,
					workflowToResolve
						? activeWorkflowConfig.workflowSelections?.[workflowToResolve]
								?.mcpServerOptions
						: undefined,
					harness !== 'openai-codex',
				)
			: {mcpConfig: undefined};
	const workflowPluginMcpConfig =
		harness === 'openai-codex'
			? buildPluginMcpConfig(
					workflowPluginDirs,
					workflowToResolve
						? activeWorkflowConfig.workflowSelections?.[workflowToResolve]
								?.mcpServerOptions
						: undefined,
				)
			: undefined;
	const pluginMcpConfig =
		harness === 'openai-codex' ? undefined : pluginResult.mcpConfig;

	const activeWorkflow: WorkflowConfig | undefined = resolvedWorkflow;

	const additionalDirectories = [
		...globalConfig.additionalDirectories,
		...projectConfig.additionalDirectories,
	];
	const harnessConfigProfile = resolveHarnessConfigProfile(harness);
	const workflowPlan = compileWorkflowPlan({
		workflow: activeWorkflow,
		resolvedPlugins:
			activeWorkflow && resolvedWorkflow?.name === activeWorkflow.name
				? workflowResolvedPlugins
				: undefined,
		pluginMcpConfig:
			harness === 'openai-codex' &&
			activeWorkflow &&
			resolvedWorkflow?.name === activeWorkflow.name
				? workflowPluginMcpConfig
				: pluginResult.mcpConfig,
	});

	const configModel =
		projectConfig.model || globalConfig.model || activeWorkflow?.model;

	let isolationPreset = initialIsolationPreset;
	if (activeWorkflow?.isolation) {
		const presetOrder = ['strict', 'minimal', 'permissive'];
		const workflowIdx = presetOrder.indexOf(activeWorkflow.isolation);
		const userIdx = presetOrder.indexOf(isolationPreset);
		if (workflowIdx > userIdx) {
			warnings.push(
				`Workflow '${activeWorkflow.name}' requires '${activeWorkflow.isolation}' isolation (upgrading from '${isolationPreset}')`,
			);
			isolationPreset = activeWorkflow.isolation as HarnessProcessPreset;
		}
	}

	const isolationConfig: HarnessProcessConfig =
		harnessConfigProfile.buildIsolationConfig({
			projectDir,
			isolationPreset,
			additionalDirectories,
			pluginDirs,
			verbose,
			configuredModel: configModel,
		});
	const modelName = harnessConfigProfile.resolveModelName({
		projectDir,
		configuredModel: isolationConfig.model,
	});

	return {
		globalConfig,
		projectConfig,
		harness,
		isolationConfig,
		pluginMcpConfig,
		workflowRef: activeWorkflow?.name,
		workflow: activeWorkflow,
		workflowPlan,
		modelName,
		warnings,
	};
}
