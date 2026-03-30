import {
	installWorkflowPlugins,
	resolveWorkflowPluginTargets,
} from './installer';
import type {WorkflowConfig, WorkflowPluginTarget} from './types';

export type WorkflowPlan = {
	workflow: WorkflowConfig;
	pluginDirs: string[];
	pluginTargets: WorkflowPluginTarget[];
	pluginMcpConfig?: string;
};

export function compileWorkflowPlan(input: {
	workflow?: WorkflowConfig;
	pluginDirs?: string[];
	pluginTargets?: WorkflowPluginTarget[];
	pluginMcpConfig?: string;
}): WorkflowPlan | undefined {
	if (!input.workflow) {
		return undefined;
	}

	const pluginDirs = input.pluginDirs ?? installWorkflowPlugins(input.workflow);
	const pluginTargets =
		input.pluginTargets ?? resolveWorkflowPluginTargets(input.workflow);

	return {
		workflow: input.workflow,
		pluginDirs: [...new Set(pluginDirs)],
		pluginTargets: pluginTargets.filter(
			(target, index, array) =>
				array.findIndex(candidate => candidate.ref === target.ref) === index,
		),
		pluginMcpConfig: input.pluginMcpConfig,
	};
}
