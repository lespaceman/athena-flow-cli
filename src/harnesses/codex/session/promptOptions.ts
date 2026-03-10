import type {
	HarnessProcessConfig,
	HarnessProcessOverride,
} from '../../../core/runtime/process';
import type {WorkflowPlan} from '../../../core/workflows';
import {
	resolveCodexWorkflowConfig,
	resolveCodexWorkflowSkillRoots,
} from './workflowArtifacts';

export type CodexPromptOptions = {
	threadIdToResume?: string;
	model?: string;
	developerInstructions?: string;
	skillRoots?: string[];
	config?: Record<string, unknown>;
	ephemeral?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === 'object' && value !== null) {
		return value as Record<string, unknown>;
	}
	return null;
}

export function buildCodexPromptOptions(input: {
	processConfig?: HarnessProcessConfig;
	sessionId?: string;
	configOverride?: HarnessProcessOverride;
	workflowPlan?: WorkflowPlan;
	ephemeral?: boolean;
}): CodexPromptOptions {
	const override = asRecord(input.configOverride);
	const modelFromOverride =
		typeof override?.['model'] === 'string' ? override['model'] : undefined;
	const developerInstructions =
		typeof override?.['developerInstructions'] === 'string'
			? override['developerInstructions']
			: undefined;
	const modelFromProcess =
		typeof input.processConfig?.model === 'string'
			? input.processConfig.model
			: undefined;
	const skillRoots = resolveCodexWorkflowSkillRoots(input.workflowPlan);

	return {
		threadIdToResume: input.sessionId,
		model: modelFromOverride ?? modelFromProcess,
		developerInstructions,
		skillRoots: skillRoots.length > 0 ? skillRoots : undefined,
		config: resolveCodexWorkflowConfig(input.workflowPlan),
		ephemeral: input.ephemeral,
	};
}
