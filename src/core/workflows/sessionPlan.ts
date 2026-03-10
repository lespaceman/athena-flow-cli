import fs from 'node:fs';
import path from 'node:path';
import type {HarnessProcessOverride} from '../runtime/process';
import {applyPromptTemplate} from './applyWorkflow';
import {
	buildContinuePrompt,
	cleanupTrackerFile,
	createLoopManager,
	type LoopManager,
} from './loopManager';
import type {WorkflowConfig} from './types';

export type WorkflowRunState = {
	workflow?: WorkflowConfig;
	loopManager: LoopManager | null;
	workflowOverride?: HarnessProcessOverride;
	warnings: string[];
};

export type PreparedWorkflowTurn = {
	prompt: string;
	configOverride?: HarnessProcessOverride;
	warnings: string[];
};

function readWorkflowOverride(
	projectDir: string,
	workflow?: WorkflowConfig,
): Pick<WorkflowRunState, 'workflowOverride' | 'warnings'> {
	if (!workflow?.systemPromptFile) {
		return {workflowOverride: undefined, warnings: []};
	}

	const resolvedPath = path.isAbsolute(workflow.systemPromptFile)
		? workflow.systemPromptFile
		: path.resolve(projectDir, workflow.systemPromptFile);
	if (!fs.existsSync(resolvedPath)) {
		return {
			workflowOverride: undefined,
			warnings: [
				`Workflow system prompt file not found: ${workflow.systemPromptFile}. Continuing without workflow system instructions.`,
			],
		};
	}

	return {
		workflowOverride: {
			appendSystemPromptFile: resolvedPath,
			developerInstructions: fs.readFileSync(resolvedPath, 'utf-8'),
		},
		warnings: [],
	};
}

function mergeOverrides(
	base?: HarnessProcessOverride,
	workflowOverride?: HarnessProcessOverride,
): HarnessProcessOverride | undefined {
	if (!base) return workflowOverride;
	if (!workflowOverride) return base;
	return {
		...base,
		...workflowOverride,
	};
}

export function createWorkflowRunState(input: {
	projectDir: string;
	workflow?: WorkflowConfig;
}): WorkflowRunState {
	const {projectDir, workflow} = input;
	const loopManager =
		workflow?.loop?.enabled === true
			? createLoopManager(
					path.resolve(projectDir, workflow.loop.trackerPath ?? 'tracker.md'),
					workflow.loop,
				)
			: null;
	const {workflowOverride, warnings} = readWorkflowOverride(
		projectDir,
		workflow,
	);

	return {
		workflow,
		loopManager,
		workflowOverride,
		warnings,
	};
}

export function prepareWorkflowTurn(
	state: WorkflowRunState,
	input: {
		prompt: string;
		configOverride?: HarnessProcessOverride;
	},
): PreparedWorkflowTurn {
	const {workflow, loopManager} = state;
	const prompt =
		workflow && loopManager && loopManager.getState().iteration > 0
			? buildContinuePrompt(workflow.loop!)
			: workflow
				? applyPromptTemplate(workflow.promptTemplate, input.prompt)
				: input.prompt;

	return {
		prompt,
		configOverride: mergeOverrides(
			input.configOverride,
			state.workflowOverride,
		),
		warnings: state.warnings,
	};
}

export function shouldContinueWorkflowRun(state: WorkflowRunState): boolean {
	const {workflow, loopManager} = state;
	if (!workflow?.loop?.enabled || !loopManager) {
		return false;
	}

	const shouldContinue =
		fs.existsSync(loopManager.trackerPath) && !loopManager.isTerminal();
	if (!shouldContinue) {
		cleanupWorkflowRun(state);
		return false;
	}

	loopManager.incrementIteration();
	return true;
}

export function cleanupWorkflowRun(state: WorkflowRunState): void {
	if (!state.loopManager) {
		return;
	}

	if (fs.existsSync(state.loopManager.trackerPath)) {
		cleanupTrackerFile(state.loopManager.trackerPath);
	}
	state.loopManager.deactivate();
	state.loopManager = null;
}
