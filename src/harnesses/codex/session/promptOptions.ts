import type {
	HarnessProcessConfig,
	HarnessProcessOverride,
	HarnessProcessPreset,
	TurnContinuation,
} from '../../../core/runtime/process';
import type {WorkflowPlan} from '../../../core/workflows';
import {resolveCodexMcpConfig} from './sessionAssets';

export type CodexApprovalPolicy = 'on-request' | 'auto-edit' | 'full-auto';
export type CodexSandbox =
	| 'read-only'
	| 'workspace-write'
	| 'danger-full-access';

export type CodexPromptOptions = {
	continuation?: TurnContinuation;
	model?: string;
	developerInstructions?: string;
	agentRoots?: string[];
	config?: Record<string, unknown>;
	ephemeral?: boolean;
	approvalPolicy: CodexApprovalPolicy;
	sandbox: CodexSandbox;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === 'object' && value !== null) {
		return value as Record<string, unknown>;
	}
	return null;
}

function resolveIsolation(preset?: HarnessProcessPreset): {
	approvalPolicy: CodexApprovalPolicy;
	sandbox: CodexSandbox;
} {
	switch (preset) {
		case 'strict':
			return {approvalPolicy: 'on-request', sandbox: 'read-only'};
		case 'permissive':
			return {approvalPolicy: 'auto-edit', sandbox: 'danger-full-access'};
		case 'minimal':
		case undefined:
			return {approvalPolicy: 'on-request', sandbox: 'workspace-write'};
	}
}

export function buildCodexPromptOptions(input: {
	processConfig?: HarnessProcessConfig;
	continuation?: TurnContinuation;
	configOverride?: HarnessProcessOverride;
	workflowPlan?: WorkflowPlan;
	pluginMcpConfig?: string;
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
	const isolation = resolveIsolation(input.processConfig?.preset);

	return {
		continuation: input.continuation,
		model: modelFromOverride ?? modelFromProcess,
		developerInstructions,
		agentRoots:
			input.workflowPlan?.agentRoots && input.workflowPlan.agentRoots.length > 0
				? input.workflowPlan.agentRoots
				: undefined,
		config: resolveCodexMcpConfig(input.pluginMcpConfig, input.workflowPlan),
		ephemeral: input.ephemeral,
		approvalPolicy: isolation.approvalPolicy,
		sandbox: isolation.sandbox,
	};
}
