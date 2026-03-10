import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
	cleanupWorkflowRun,
	createWorkflowRunState,
	prepareWorkflowTurn,
	shouldContinueWorkflowRun,
} from './sessionPlan';

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
				systemPromptFile: 'workflow-prompt.md',
			},
		});
		const prepared = prepareWorkflowTurn(state, {
			prompt: 'ship it',
			configOverride: {model: 'gpt-5'},
		});

		expect(prepared.prompt).toBe('Execute: ship it');
		expect(prepared.configOverride).toEqual({
			model: 'gpt-5',
			appendSystemPromptFile: promptPath,
			developerInstructions: 'Follow the tracker strictly.',
		});
	});

	it('switches to continue prompts and cleans up loop trackers at terminal state', () => {
		const projectDir = makeTempDir();
		const trackerPath = path.join(projectDir, 'tracker.md');
		fs.writeFileSync(trackerPath, 'iteration 1', 'utf-8');

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
					continuePrompt: 'Continue with {trackerPath}',
				},
			},
		});

		expect(shouldContinueWorkflowRun(state)).toBe(true);
		expect(
			prepareWorkflowTurn(state, {
				prompt: 'ignored after first turn',
			}).prompt,
		).toBe('Continue with tracker.md');

		fs.writeFileSync(trackerPath, '<!-- DONE -->', 'utf-8');
		expect(shouldContinueWorkflowRun(state)).toBe(false);
		expect(fs.existsSync(trackerPath)).toBe(false);

		cleanupWorkflowRun(state);
		expect(state.loopManager).toBeNull();
	});
});
