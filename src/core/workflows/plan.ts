import {resolveWorkflowPlugins} from './installer';
import type {
	CodexWorkflowPluginRef,
	ResolvedLocalWorkflowPlugin,
	ResolvedWorkflowPlugin,
	WorkflowConfig,
} from './types';

export type WorkflowPlan = {
	workflow: WorkflowConfig;
	resolvedPlugins: ResolvedWorkflowPlugin[];
	localPlugins: ResolvedLocalWorkflowPlugin[];
	agentRoots: string[];
	codexPlugins: CodexWorkflowPluginRef[];
	pluginMcpConfig?: string;
};

export function compileWorkflowPlan(input: {
	workflow?: WorkflowConfig;
	resolvedPlugins?: ResolvedWorkflowPlugin[];
	localPlugins?: ResolvedLocalWorkflowPlugin[];
	codexPlugins?: CodexWorkflowPluginRef[];
	pluginMcpConfig?: string;
}): WorkflowPlan | undefined {
	if (!input.workflow) {
		return undefined;
	}

	const resolved =
		!input.resolvedPlugins && (!input.localPlugins || !input.codexPlugins)
			? resolveWorkflowPlugins(input.workflow)
			: undefined;
	const resolvedPlugins =
		input.resolvedPlugins ?? resolved?.resolvedPlugins ?? [];
	const localPlugins = input.localPlugins ?? resolved?.localPlugins ?? [];
	const codexPlugins = input.codexPlugins ?? resolved?.codexPlugins ?? [];

	return {
		workflow: input.workflow,
		resolvedPlugins: resolvedPlugins.filter(
			(plugin, index, array) =>
				array.findIndex(candidate => candidate.ref === plugin.ref) === index,
		),
		localPlugins: localPlugins.filter(
			(plugin, index, array) =>
				array.findIndex(candidate => candidate.ref === plugin.ref) === index,
		),
		agentRoots: resolvedPlugins
			.map(plugin => `${plugin.claudeArtifactDir}/agents`)
			.filter((root, index, array) => array.indexOf(root) === index),
		codexPlugins: codexPlugins.filter(
			(target, index, array) =>
				array.findIndex(candidate => candidate.ref === target.ref) === index,
		),
		pluginMcpConfig: input.pluginMcpConfig,
	};
}
