import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
	createWorkflowRunState,
	prepareWorkflowTurn,
	shouldContinueWorkflowRun,
} from './sessionPlan';
import {STATE_MACHINE_CONTENT} from './stateMachine';

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-workflow-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('workflow session planning', () => {
	it('applies prompt template and resolves shared workflow overrides', () => {
		const projectDir = makeTempDir();
		const promptPath = path.join(projectDir, 'workflow-prompt.md');
		fs.writeFileSync(promptPath, 'Follow the tracker strictly.', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: 'Execute: {input}',
				workflowFile: 'workflow-prompt.md',
			},
		});
		const prepared = prepareWorkflowTurn(state, {
			prompt: 'ship it',
			configOverride: {model: 'gpt-5'},
		});

		const composedPath = path.join(projectDir, '.composed-system-prompt.md');
		expect(prepared.prompt).toBe('Execute: ship it');
		expect(prepared.configOverride).toEqual({
			model: 'gpt-5',
			appendSystemPromptFile: composedPath,
			developerInstructions: 'Follow the tracker strictly.',
		});
	});

	it('prepends state machine protocol for looped workflows', () => {
		const projectDir = makeTempDir();
		const workflowPath = path.join(projectDir, 'workflow.md');
		fs.writeFileSync(workflowPath, '# Workflow Steps', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			sessionId: 'sess-1',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'workflow.md',
				loop: {enabled: true, maxIterations: 5},
			},
		});

		expect(state.workflowOverride).toBeDefined();
		const instructions = (state.workflowOverride as Record<string, unknown>)[
			'developerInstructions'
		] as string;
		expect(instructions).toContain('# Stateless Session Protocol');
		expect(instructions).toContain('# Workflow Steps');
		expect(instructions.indexOf('Stateless Session Protocol')).toBeLessThan(
			instructions.indexOf('Workflow Steps'),
		);
	});

	it('uses harness-specific task tool instructions in composed state machine content', () => {
		const projectDir = makeTempDir();
		const workflowPath = path.join(projectDir, 'workflow.md');
		fs.writeFileSync(workflowPath, '# Workflow Steps', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			sessionId: 'sess-1',
			harness: 'openai-codex',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'workflow.md',
				loop: {enabled: true, maxIterations: 5},
			},
		});

		const instructions = (state.workflowOverride as Record<string, unknown>)[
			'developerInstructions'
		] as string;
		expect(instructions).toContain('Use the `update_plan` tool');
		expect(instructions).toContain(
			'Do not carry forward prior session task IDs',
		);
	});

	it('omits state machine protocol for non-looped workflows', () => {
		const projectDir = makeTempDir();
		const workflowPath = path.join(projectDir, 'workflow.md');
		fs.writeFileSync(workflowPath, '# Workflow Steps', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				workflowFile: 'workflow.md',
			},
		});

		const instructions = (state.workflowOverride as Record<string, unknown>)?.[
			'developerInstructions'
		] as string;
		expect(instructions).not.toContain(STATE_MACHINE_CONTENT);
		expect(instructions).toBe('# Workflow Steps');
	});

	it('switches to continue prompts and preserves loop trackers at terminal state', () => {
		const projectDir = makeTempDir();
		const trackerPath = path.join(projectDir, '.athena', 'session-1.md');
		fs.mkdirSync(path.dirname(trackerPath), {recursive: true});
		fs.writeFileSync(trackerPath, 'iteration 1', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			sessionId: 'session-1',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: 'Execute: {input}',
				loop: {
					enabled: true,
					completionMarker: '<!-- DONE -->',
					maxIterations: 5,
					trackerPath: '.athena/{sessionId}.md',
					continuePrompt: 'Continue with {trackerPath}',
				},
			},
		});

		expect(shouldContinueWorkflowRun(state)).toBeNull();
		expect(
			prepareWorkflowTurn(state, {
				prompt: 'ignored after first turn',
			}).prompt,
		).toBe('Continue with .athena/session-1.md');

		fs.writeFileSync(trackerPath, '<!-- DONE -->', 'utf-8');
		const stopInfo = shouldContinueWorkflowRun(state);
		expect(stopInfo).not.toBeNull();
		expect(stopInfo!.reason).toBe('completed');
		expect(fs.existsSync(trackerPath)).toBe(true);
		expect(state.loopManager).toBeNull();
	});

	it('stops before scheduling a turn beyond maxIterations', () => {
		const projectDir = makeTempDir();
		const trackerPath = path.join(projectDir, 'tracker.md');
		fs.writeFileSync(trackerPath, 'still running', 'utf-8');

		const state = createWorkflowRunState({
			projectDir,
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: 'Execute: {input}',
				loop: {
					enabled: true,
					completionMarker: '<!-- DONE -->',
					maxIterations: 1,
					trackerPath: 'tracker.md',
				},
			},
		});

		const stopInfo = shouldContinueWorkflowRun(state);
		expect(stopInfo).not.toBeNull();
		expect(stopInfo!.reason).toBe('max_iterations');
		expect(fs.existsSync(trackerPath)).toBe(true);
	});

	it('records missing tracker as a loop stop reason', () => {
		const projectDir = makeTempDir();
		const state = createWorkflowRunState({
			projectDir,
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: 'Execute: {input}',
				loop: {
					enabled: true,
					completionMarker: '<!-- DONE -->',
					maxIterations: 5,
					trackerPath: 'tracker.md',
				},
			},
		});

		const stopInfo = shouldContinueWorkflowRun(state);
		expect(stopInfo).not.toBeNull();
		expect(stopInfo!.reason).toBe('missing_tracker');
	});
});
