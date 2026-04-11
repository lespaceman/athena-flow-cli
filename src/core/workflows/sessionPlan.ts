import fs from 'node:fs';
import path from 'node:path';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {HarnessProcessOverride} from '../runtime/process';
import {applyPromptTemplate} from './applyWorkflow';
import {substituteVariables} from './templateVars';
import {
	buildContinuePrompt,
	createLoopManager,
	DEFAULT_TRACKER_PATH,
	type LoopManager,
} from './loopManager';
import {buildStateMachineContent} from './stateMachine';
import type {LoopStopReason, WorkflowConfig} from './types';

export type WorkflowRunState = {
	workflow?: WorkflowConfig;
	loopManager: LoopManager | null;
	trackerPathForPrompt?: string;
	workflowOverride?: HarnessProcessOverride;
	warnings: string[];
};

export type LoopStopInfo = {
	reason: LoopStopReason;
	blockedReason?: string;
	maxIterations: number;
};

export type PreparedWorkflowTurn = {
	prompt: string;
	configOverride?: HarnessProcessOverride;
	warnings: string[];
};

function readWorkflowOverride(
	projectDir: string,
	workflow?: WorkflowConfig,
	sessionId?: string,
	trackerPath?: string,
	harness: AthenaHarness = 'claude-code',
): Pick<WorkflowRunState, 'workflowOverride' | 'warnings'> {
	if (!workflow?.workflowFile) {
		return {workflowOverride: undefined, warnings: []};
	}

	const resolvedPath = path.isAbsolute(workflow.workflowFile)
		? workflow.workflowFile
		: path.resolve(projectDir, workflow.workflowFile);

	let workflowContent: string;
	try {
		workflowContent = fs.readFileSync(resolvedPath, 'utf-8');
	} catch {
		return {
			workflowOverride: undefined,
			warnings: [
				`Workflow file not found: ${workflow.workflowFile}. Continuing without workflow system instructions.`,
			],
		};
	}

	let composed = workflow.loop?.enabled
		? buildStateMachineContent(harness) + '\n\n' + workflowContent
		: workflowContent;

	composed = substituteVariables(composed, {
		sessionId,
		trackerPath: trackerPath ?? undefined,
	});

	// Write composed prompt to a stable file so the harness can read it via
	// --append-system-prompt-file without a temp-file cleanup concern.
	const workflowDir = path.dirname(resolvedPath);
	const composedPath = path.join(workflowDir, '.composed-system-prompt.md');
	fs.writeFileSync(composedPath, composed, 'utf-8');

	return {
		workflowOverride: {
			appendSystemPromptFile: composedPath,
			developerInstructions: composed,
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

export function resolveTrackerPath(input: {
	projectDir: string;
	sessionId?: string;
	workflow?: WorkflowConfig;
}): {absolutePath: string; promptPath: string} | null {
	const loop = input.workflow?.loop;
	if (!loop?.enabled) {
		return null;
	}

	const rawPath = loop.trackerPath ?? DEFAULT_TRACKER_PATH;

	// The default tracker path requires a session ID for substitution.
	// If neither a session ID nor an explicit tracker path was provided, the
	// loop cannot operate.
	if (!input.sessionId && rawPath.includes('{sessionId}')) {
		return null;
	}

	const promptPath = input.sessionId
		? rawPath.replaceAll('{sessionId}', input.sessionId)
		: rawPath;
	const absolutePath = path.isAbsolute(promptPath)
		? promptPath
		: path.resolve(input.projectDir, promptPath);

	return {
		absolutePath,
		promptPath,
	};
}

export function createWorkflowRunState(input: {
	projectDir: string;
	sessionId?: string;
	workflow?: WorkflowConfig;
	harness?: AthenaHarness;
}): WorkflowRunState {
	const {projectDir, sessionId, workflow, harness} = input;
	const trackerResolved = resolveTrackerPath({projectDir, sessionId, workflow});
	const loopManager =
		workflow?.loop?.enabled === true && trackerResolved
			? createLoopManager(trackerResolved.absolutePath, workflow.loop)
			: null;
	const {workflowOverride, warnings} = readWorkflowOverride(
		projectDir,
		workflow,
		sessionId,
		trackerResolved?.promptPath,
		harness,
	);

	return {
		workflow,
		loopManager,
		trackerPathForPrompt: trackerResolved?.promptPath,
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
			? buildContinuePrompt({
					...workflow.loop!,
					trackerPath: state.trackerPathForPrompt ?? workflow.loop?.trackerPath,
				})
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

/**
 * Check whether the workflow loop should continue.
 *
 * Returns `null` when the loop should run another iteration (and increments
 * the iteration counter). Returns stop info when the loop is done (and
 * cleans up the loop manager).
 */
export function shouldContinueWorkflowRun(
	state: WorkflowRunState,
): LoopStopInfo | null {
	const {workflow, loopManager} = state;
	if (!workflow?.loop?.enabled || !loopManager) {
		return null;
	}

	const loopState = loopManager.getState();

	if (!fs.existsSync(loopManager.trackerPath)) {
		cleanupWorkflowRun(state);
		return {
			reason: 'missing_tracker',
			maxIterations: loopState.maxIterations,
		};
	}

	let reason: LoopStopReason | undefined;
	if (loopState.completed) {
		reason = 'completed';
	} else if (loopState.blocked) {
		reason = 'blocked';
	} else if (loopState.iteration + 1 >= loopState.maxIterations) {
		reason = 'max_iterations';
	}

	if (reason) {
		cleanupWorkflowRun(state);
		return {
			reason,
			blockedReason: loopState.blockedReason,
			maxIterations: loopState.maxIterations,
		};
	}

	loopManager.incrementIteration();
	return null;
}

export function cleanupWorkflowRun(state: WorkflowRunState): void {
	if (!state.loopManager) {
		return;
	}

	state.loopManager.deactivate();
	state.loopManager = null;
}
