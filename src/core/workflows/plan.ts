import {installWorkflowPlugins} from './installer';
import type {WorkflowConfig} from './types';

export type WorkflowPlan = {
	workflow: WorkflowConfig;
	pluginDirs: string[];
	pluginMcpConfig?: string;
};

export function compileWorkflowPlan(input: {
	workflow?: WorkflowConfig;
	pluginDirs?: string[];
	pluginMcpConfig?: string;
}): WorkflowPlan | undefined {
	if (!input.workflow) {
		return undefined;
	}

	const pluginDirs = input.pluginDirs ?? installWorkflowPlugins(input.workflow);

	return {
		workflow: input.workflow,
		pluginDirs: [...new Set(pluginDirs)],
		pluginMcpConfig: input.pluginMcpConfig,
	};
}
