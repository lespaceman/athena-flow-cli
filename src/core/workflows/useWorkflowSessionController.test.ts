/**
 * @vitest-environment jsdom
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import {useWorkflowSessionController} from './useWorkflowSessionController';
import type {
	HarnessProcess,
	HarnessProcessOverride,
	TurnExecutionResult,
} from '../runtime/process';

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-workflow-hook-'));
	tempDirs.push(dir);
	return dir;
}

const NULL_USAGE = {
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
	tokens: NULL_USAGE,
	streamMessage: null,
};

const KILLED_RESULT: TurnExecutionResult = {
	exitCode: null,
	error: new Error('killed'),
	tokens: NULL_USAGE,
	streamMessage: null,
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('useWorkflowSessionController', () => {
	it('applies workflow prompt/system instructions and continues loop turns', async () => {
		const projectDir = makeTempDir();
		const promptPath = path.join(projectDir, 'workflow-prompt.md');
		const trackerPath = path.join(projectDir, '.athena', 'session-1.md');
		fs.mkdirSync(path.dirname(trackerPath), {recursive: true});
		fs.writeFileSync(promptPath, 'Always read the tracker.', 'utf-8');

		const spawn = vi
			.fn<HarnessProcess<HarnessProcessOverride>['startTurn']>()
			.mockImplementation(async (_prompt, _continuation, _configOverride) => {
				const call = spawn.mock.calls.length;
				if (call === 1) {
					fs.writeFileSync(trackerPath, 'still running', 'utf-8');
					return OK_RESULT;
				}

				fs.writeFileSync(trackerPath, '<!-- DONE -->', 'utf-8');
				return OK_RESULT;
			});

		const {result} = renderHook(() =>
			useWorkflowSessionController(
				{
					startTurn: spawn,
					isRunning: false,
					interrupt: vi.fn(),
					kill: vi.fn().mockResolvedValue(undefined),
					usage: NULL_USAGE,
				},
				{
					projectDir,
					sessionId: 'session-1',
					harness: 'openai-codex',
					workflow: {
						name: 'wf',
						plugins: [],
						promptTemplate: 'Execute: {input}',
						workflowFile: 'workflow-prompt.md',
						loop: {
							enabled: true,
							completionMarker: '<!-- DONE -->',
							maxIterations: 5,
							trackerPath: '.athena/{sessionId}.md',
							continuePrompt: 'Continue with {trackerPath}',
						},
					},
				},
			),
		);

		await act(async () => {
			await result.current.startTurn('ship it', {
				mode: 'resume',
				handle: 'session-1',
			});
		});

		const composedPath = path.join(projectDir, '.composed-system-prompt.md');
		expect(spawn).toHaveBeenNthCalledWith(
			1,
			'Execute: ship it',
			{mode: 'resume', handle: 'session-1'},
			{
				appendSystemPromptFile: composedPath,
				developerInstructions: expect.stringContaining(
					'Use the `update_plan` tool',
				),
			},
		);
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			'Continue with .athena/session-1.md',
			{mode: 'fresh'},
			{
				appendSystemPromptFile: composedPath,
				developerInstructions: expect.stringContaining(
					'Do not carry forward prior session task IDs',
				),
			},
		);
		expect(result.current.isRunning).toBe(false);
		expect(fs.existsSync(trackerPath)).toBe(true);
	});

	it('kills an in-flight run before starting a new spawn', async () => {
		let releaseFirstSpawn: ((result: TurnExecutionResult) => void) | null =
			null;
		const kill = vi.fn().mockImplementation(async () => {
			releaseFirstSpawn?.(KILLED_RESULT);
		});
		const spawn = vi
			.fn<HarnessProcess<HarnessProcessOverride>['startTurn']>()
			.mockImplementationOnce(
				() =>
					new Promise<TurnExecutionResult>(resolve => {
						releaseFirstSpawn = resolve;
					}),
			)
			.mockResolvedValueOnce(OK_RESULT);

		const {result} = renderHook(() =>
			useWorkflowSessionController(
				{
					startTurn: spawn,
					isRunning: false,
					interrupt: vi.fn(),
					kill,
					usage: NULL_USAGE,
				},
				{
					projectDir: makeTempDir(),
					workflow: {
						name: 'wf',
						plugins: [],
						promptTemplate: '{input}',
					},
				},
			),
		);

		let firstSpawnPromise: Promise<TurnExecutionResult>;
		await act(async () => {
			firstSpawnPromise = result.current.startTurn('first');
			// Yield so the runner's initial await Promise.resolve() runs and
			// the turn actually starts (making the first spawn block).
			await Promise.resolve();
		});

		await act(async () => {
			await result.current.startTurn('second');
		});

		await act(async () => {
			await firstSpawnPromise!;
		});

		// base.kill() should have been called to abort the first turn
		expect(kill).toHaveBeenCalledTimes(1);
		// The runner defaults continuation to {mode: 'fresh'} when not provided
		expect(spawn).toHaveBeenNthCalledWith(
			1,
			'first',
			{mode: 'fresh'},
			undefined,
		);
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			'second',
			{mode: 'fresh'},
			undefined,
		);
	});

	it('interrupt immediately ends the session via kill', async () => {
		let releaseTurn: ((result: TurnExecutionResult) => void) | null = null;
		const baseInterrupt = vi.fn();
		const baseKill = vi.fn().mockImplementation(async () => {
			releaseTurn?.(KILLED_RESULT);
		});
		const spawn = vi
			.fn<HarnessProcess<HarnessProcessOverride>['startTurn']>()
			.mockImplementation(
				() =>
					new Promise<TurnExecutionResult>(resolve => {
						releaseTurn = resolve;
					}),
			);

		const {result} = renderHook(() =>
			useWorkflowSessionController(
				{
					startTurn: spawn,
					isRunning: false,
					interrupt: baseInterrupt,
					kill: baseKill,
					usage: NULL_USAGE,
				},
				{
					projectDir: makeTempDir(),
				},
			),
		);

		// Start a turn and let it begin executing inside the runner
		let turnPromise: Promise<TurnExecutionResult>;
		await act(async () => {
			turnPromise = result.current.startTurn('test prompt');
			// Yield so the runner's initial await Promise.resolve() runs
			await Promise.resolve();
		});

		expect(result.current.isRunning).toBe(true);

		// Interrupt (simulates double-ESC)
		act(() => {
			result.current.interrupt();
		});

		// isRunning should be false immediately after interrupt
		expect(result.current.isRunning).toBe(false);
		// base.kill() should have been called to forcefully stop the process
		expect(baseKill).toHaveBeenCalledTimes(1);
		// base.interrupt() should NOT be called — interrupt escalates to kill
		expect(baseInterrupt).not.toHaveBeenCalled();

		await act(async () => {
			await turnPromise!;
		});
	});

	it('stops workflow continuation after a failed turn', async () => {
		const trackerPath = path.join(makeTempDir(), 'tracker.md');
		const spawn = vi
			.fn<HarnessProcess<HarnessProcessOverride>['startTurn']>()
			.mockImplementation(async () => {
				fs.writeFileSync(trackerPath, 'still running', 'utf-8');
				return {
					exitCode: 1,
					error: null,
					tokens: NULL_USAGE,
					streamMessage: null,
				};
			});

		const {result} = renderHook(() =>
			useWorkflowSessionController(
				{
					startTurn: spawn,
					isRunning: false,
					interrupt: vi.fn(),
					kill: vi.fn().mockResolvedValue(undefined),
					usage: NULL_USAGE,
				},
				{
					projectDir: path.dirname(trackerPath),
					workflow: {
						name: 'wf',
						plugins: [],
						promptTemplate: '{input}',
						loop: {
							enabled: true,
							completionMarker: '<!-- DONE -->',
							maxIterations: 5,
							trackerPath: path.basename(trackerPath),
						},
					},
				},
			),
		);

		const turnResult = await act(async () => {
			return await result.current.startTurn('ship it');
		});

		// The runner returns exitCode 1 for failed status
		expect(turnResult.exitCode).toBe(1);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it('exposes activeRunId while a run is active', async () => {
		let releaseTurn: ((result: TurnExecutionResult) => void) | null = null;
		const spawn = vi
			.fn<HarnessProcess<HarnessProcessOverride>['startTurn']>()
			.mockImplementation(
				() =>
					new Promise<TurnExecutionResult>(resolve => {
						releaseTurn = resolve;
					}),
			);

		const {result} = renderHook(() =>
			useWorkflowSessionController(
				{
					startTurn: spawn,
					isRunning: false,
					interrupt: vi.fn(),
					kill: vi.fn().mockResolvedValue(undefined),
					usage: NULL_USAGE,
				},
				{
					projectDir: makeTempDir(),
				},
			),
		);

		expect(result.current.activeRunId).toBeNull();

		let turnPromise: Promise<TurnExecutionResult>;
		await act(async () => {
			turnPromise = result.current.startTurn('test');
			await Promise.resolve();
		});

		expect(result.current.activeRunId).not.toBeNull();
		expect(typeof result.current.activeRunId).toBe('string');

		// Complete the turn
		act(() => {
			releaseTurn?.(OK_RESULT);
		});

		await act(async () => {
			await turnPromise!;
		});

		expect(result.current.activeRunId).toBeNull();
	});
});
