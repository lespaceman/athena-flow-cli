import {
	registerPlugins,
	readConfig,
	readGlobalConfig,
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
	installWorkflowPlugins,
	resolveWorkflow,
} from '../../core/workflows/index';
import type {WorkflowConfig, WorkflowPlan} from '../../core/workflows';
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
}: RuntimeBootstrapInput): RuntimeBootstrapOutput {
	const globalConfig = providedGlobalConfig ?? readGlobalConfig();
	const projectConfig = providedProjectConfig ?? readConfig(projectDir);
	const warnings: string[] = [];
	const harness =
		projectConfig.harness ?? globalConfig.harness ?? DEFAULT_HARNESS;
	const configuredActiveWorkflow = globalConfig.activeWorkflow;

	if (!showSetup && !configuredActiveWorkflow) {
		throw new Error(
			'No active workflow selected. Run `athena-flow workflow use <name>` or `athena-flow setup`.',
		);
	}

	let workflowPluginDirs: string[] = [];
	let resolvedWorkflow: WorkflowConfig | undefined;

	const workflowToResolve = shouldResolveWorkflow({
		showSetup,
		workflowName: configuredActiveWorkflow,
	})
		? configuredActiveWorkflow
		: undefined;

	if (workflowToResolve) {
		resolvedWorkflow = resolveWorkflow(workflowToResolve);
		workflowPluginDirs = installWorkflowPlugins(resolvedWorkflow);
	}

	const pluginDirs = mergePluginDirs({
		workflowPluginDirs,
		globalPlugins: globalConfig.plugins,
		projectPlugins: projectConfig.plugins,
		pluginFlags,
	});
	const pluginResult =
		pluginDirs.length > 0
			? registerPlugins(
					pluginDirs,
					workflowToResolve
						? globalConfig.workflowSelections?.[workflowToResolve]
								?.mcpServerOptions
						: undefined,
				)
			: {mcpConfig: undefined, workflows: [] as WorkflowConfig[]};
	const pluginMcpConfig = pluginResult.mcpConfig;
	const workflows = pluginResult.workflows;

	let activeWorkflow: WorkflowConfig | undefined = resolvedWorkflow;
	if (!activeWorkflow && workflows.length === 1) {
		activeWorkflow = workflows[0];
	} else if (!activeWorkflow && workflows.length > 1) {
		warnings.push(
			`Multiple workflows found: ${workflows.map(w => w.name).join(', ')}. Set one with \`athena-flow workflow use <name>\`.`,
		);
	}

	const additionalDirectories = [
		...globalConfig.additionalDirectories,
		...projectConfig.additionalDirectories,
	];
	const harnessConfigProfile = resolveHarnessConfigProfile(harness);
	const workflowPlan = compileWorkflowPlan({
		workflow: activeWorkflow,
		pluginDirs:
			activeWorkflow && resolvedWorkflow?.name === activeWorkflow.name
				? workflowPluginDirs
				: undefined,
		pluginMcpConfig,
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
