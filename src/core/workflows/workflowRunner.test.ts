import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createWorkflowRunner} from './workflowRunner';
import type {TurnExecutionResult} from '../runtime/process';
import {TRACKER_SKELETON_MARKER} from './loopManager';

const NULL_TOKENS = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	total: null,
	contextSize: null,
	contextWindowSize: null,
};

const OK_RESULT: TurnExecutionResult = {
	exitCode: 0,
	error: null,
	tokens: NULL_TOKENS,
	streamMessage: null,
};

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-runner-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('createWorkflowRunner', () => {
	it('runs a single non-looped turn and resolves', async () => {
		const startTurn = vi.fn().mockResolvedValue(OK_RESULT);
		const persistRunState = vi.fn();

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir: makeTempDir(),
			prompt: 'do it',
			startTurn,
			persistRunState,
		});

		expect(handle.runId).toBeDefined();
		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(result.iterations).toBe(1);
		expect(startTurn).toHaveBeenCalledTimes(1);
		expect(persistRunState).toHaveBeenCalled();
	});

	it('loops until completion marker is found', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		const startTurn = vi
			.fn()
			.mockImplementationOnce(async () => {
				fs.writeFileSync(trackerPath, '## Plan\n- task 1\n- task 2', 'utf-8');
				return OK_RESULT;
			})
			.mockImplementationOnce(async () => {
				fs.writeFileSync(
					trackerPath,
					'## Plan\n- [x] task 1\n- [x] task 2\n<!-- WORKFLOW_COMPLETE -->',
					'utf-8',
				);
				return OK_RESULT;
			});

		const persistRunState = vi.fn();
		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState,
		});

		const result = await handle.result;
		expect(result.status).toBe('completed');
		expect(result.iterations).toBe(2);
		expect(startTurn).toHaveBeenCalledTimes(2);
	});

	it('creates tracker skeleton before first turn when loop enabled', async () => {
		const projectDir = makeTempDir();
		const trackerPath = path.join(projectDir, '.athena', 's1', 'tracker.md');
		let trackerExistsBeforeFirstTurn = false;
		let trackerContent = '';

		const startTurn = vi.fn().mockImplementationOnce(async () => {
			trackerExistsBeforeFirstTurn = fs.existsSync(trackerPath);
			trackerContent = fs.readFileSync(trackerPath, 'utf-8');
			fs.writeFileSync(trackerPath, '<!-- WORKFLOW_COMPLETE -->', 'utf-8');
			return OK_RESULT;
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 5},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		await handle.result;
		expect(trackerExistsBeforeFirstTurn).toBe(true);
		expect(trackerContent).toContain(TRACKER_SKELETON_MARKER);
		expect(trackerContent).toContain('s1');
	});

	it('cancel stops the loop after current turn', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');

		let turnCount = 0;
		// handleRef is declared here and assigned after createWorkflowRunner returns.
		// The mock captures it via closure. This is safe because startTurn runs async —
		// by the time the mock executes, handleRef has already been assigned.
		const handleRef: {current?: ReturnType<typeof createWorkflowRunner>} = {};

		const startTurn = vi.fn().mockImplementation(async () => {
			turnCount++;
			fs.writeFileSync(trackerPath, 'still running', 'utf-8');
			if (turnCount === 1) {
				handleRef.current!.cancel();
			}
			return OK_RESULT;
		});

		handleRef.current = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 10},
			},
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handleRef.current!.result;
		expect(result.status).toBe('cancelled');
		expect(startTurn).toHaveBeenCalledTimes(1);
	});

	it('kill aborts the current turn', async () => {
		const projectDir = makeTempDir();
		const trackerDir = path.join(projectDir, '.athena', 's1');
		fs.mkdirSync(trackerDir, {recursive: true});
		const trackerPath = path.join(trackerDir, 'tracker.md');
		fs.writeFileSync(trackerPath, 'running', 'utf-8');

		const abortCurrentTurn = vi.fn();
		let resolveFirstTurn: ((r: TurnExecutionResult) => void) | null = null;

		const startTurn = vi.fn().mockImplementation(() => {
			return new Promise<TurnExecutionResult>(resolve => {
				resolveFirstTurn = resolve;
			});
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir,
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 10},
			},
			startTurn,
			persistRunState: vi.fn(),
			abortCurrentTurn,
		});

		await new Promise(r => setTimeout(r, 10));
		expect(startTurn).toHaveBeenCalledTimes(1);

		handle.kill();
		expect(abortCurrentTurn).toHaveBeenCalledTimes(1);

		resolveFirstTurn!({...OK_RESULT, error: new Error('killed')});

		const result = await handle.result;
		expect(result.status).toBe('cancelled');
	});

	it('reports failed when turn exits non-zero', async () => {
		const startTurn = vi.fn().mockResolvedValue({
			...OK_RESULT,
			exitCode: 1,
		});

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir: makeTempDir(),
			prompt: 'do it',
			startTurn,
			persistRunState: vi.fn(),
		});

		const result = await handle.result;
		expect(result.status).toBe('failed');
	});

	it('uses injected createTracker instead of fs', async () => {
		const createTracker = vi.fn();
		const startTurn = vi.fn().mockResolvedValue(OK_RESULT);

		const handle = createWorkflowRunner({
			sessionId: 's1',
			projectDir: '/fake',
			prompt: 'do it',
			workflow: {
				name: 'wf',
				plugins: [],
				promptTemplate: '{input}',
				loop: {enabled: true, maxIterations: 1},
			},
			startTurn,
			persistRunState: vi.fn(),
			createTracker,
		});

		await handle.result;
		expect(createTracker).toHaveBeenCalledTimes(1);
		expect(createTracker.mock.calls[0][0]).toContain('.athena/s1/tracker.md');
		expect(createTracker.mock.calls[0][1]).toContain(TRACKER_SKELETON_MARKER);
	});
});
