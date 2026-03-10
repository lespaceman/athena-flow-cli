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

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('useWorkflowSessionController', () => {
	it('applies workflow prompt/system instructions and continues loop turns', async () => {
		const projectDir = makeTempDir();
		const promptPath = path.join(projectDir, 'workflow-prompt.md');
		const trackerPath = path.join(projectDir, 'tracker.md');
		fs.writeFileSync(promptPath, 'Always read the tracker.', 'utf-8');

		const spawn = vi
			.fn<HarnessProcess<HarnessProcessOverride>['spawn']>()
			.mockImplementation(async (_prompt, _continuation, _configOverride) => {
				const call = spawn.mock.calls.length;
				if (call === 1) {
					fs.writeFileSync(trackerPath, 'still running', 'utf-8');
					return {
						exitCode: 0,
						error: null,
						tokens: {
							input: null,
							output: null,
							cacheRead: null,
							cacheWrite: null,
							total: null,
							contextSize: null,
							contextWindowSize: null,
						},
						streamMessage: null,
					};
				}

				fs.writeFileSync(trackerPath, '<!-- DONE -->', 'utf-8');
				return {
					exitCode: 0,
					error: null,
					tokens: {
						input: null,
						output: null,
						cacheRead: null,
						cacheWrite: null,
						total: null,
						contextSize: null,
						contextWindowSize: null,
					},
					streamMessage: null,
				};
			});

		const {result} = renderHook(() =>
			useWorkflowSessionController(
				{
					spawn,
					isRunning: false,
					interrupt: vi.fn(),
					kill: vi.fn().mockResolvedValue(undefined),
					usage: {
						input: null,
						output: null,
						cacheRead: null,
						cacheWrite: null,
						total: null,
						contextSize: null,
					},
				},
				{
					projectDir,
					workflow: {
						name: 'wf',
						plugins: [],
						promptTemplate: 'Execute: {input}',
						systemPromptFile: 'workflow-prompt.md',
						loop: {
							enabled: true,
							completionMarker: '<!-- DONE -->',
							maxIterations: 5,
							trackerPath: 'tracker.md',
							continuePrompt: 'Continue with {trackerPath}',
						},
					},
				},
			),
		);

		await act(async () => {
			await result.current.spawn('ship it', {
				mode: 'resume',
				handle: 'session-1',
			});
		});

		expect(spawn).toHaveBeenNthCalledWith(
			1,
			'Execute: ship it',
			{mode: 'resume', handle: 'session-1'},
			{
				appendSystemPromptFile: promptPath,
				developerInstructions: 'Always read the tracker.',
			},
		);
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			'Continue with tracker.md',
			{mode: 'fresh'},
			{
				appendSystemPromptFile: promptPath,
				developerInstructions: 'Always read the tracker.',
			},
		);
		expect(result.current.isRunning).toBe(false);
		expect(fs.existsSync(trackerPath)).toBe(false);
	});

	it('kills an in-flight run before starting a new spawn', async () => {
		let releaseFirstSpawn: (() => void) | null = null;
		const kill = vi.fn().mockImplementation(async () => {
			releaseFirstSpawn?.();
		});
		const spawn = vi
			.fn<HarnessProcess<HarnessProcessOverride>['spawn']>()
			.mockImplementationOnce(
				() =>
					new Promise<TurnExecutionResult>(resolve => {
						releaseFirstSpawn = resolve;
					}),
			)
			.mockResolvedValueOnce({
				exitCode: 0,
				error: null,
				tokens: {
					input: null,
					output: null,
					cacheRead: null,
					cacheWrite: null,
					total: null,
					contextSize: null,
					contextWindowSize: null,
				},
				streamMessage: null,
			});

		const {result} = renderHook(() =>
			useWorkflowSessionController(
				{
					spawn,
					isRunning: false,
					interrupt: vi.fn(),
					kill,
					usage: {
						input: null,
						output: null,
						cacheRead: null,
						cacheWrite: null,
						total: null,
						contextSize: null,
					},
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
			firstSpawnPromise = result.current.spawn('first');
		});

		await act(async () => {
			await result.current.spawn('second');
		});

		await act(async () => {
			await firstSpawnPromise!;
		});

		expect(kill).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenNthCalledWith(1, 'first', undefined, undefined);
		expect(spawn).toHaveBeenNthCalledWith(2, 'second', undefined, undefined);
	});

	it('stops workflow continuation after a failed turn', async () => {
		const trackerPath = path.join(makeTempDir(), 'tracker.md');
		const spawn = vi
			.fn<HarnessProcess<HarnessProcessOverride>['spawn']>()
			.mockImplementation(async () => {
				fs.writeFileSync(trackerPath, 'still running', 'utf-8');
				return {
					exitCode: 1,
					error: null,
					tokens: {
						input: null,
						output: null,
						cacheRead: null,
						cacheWrite: null,
						total: null,
						contextSize: null,
						contextWindowSize: null,
					},
					streamMessage: null,
				};
			});

		const {result} = renderHook(() =>
			useWorkflowSessionController(
				{
					spawn,
					isRunning: false,
					interrupt: vi.fn(),
					kill: vi.fn().mockResolvedValue(undefined),
					usage: {
						input: null,
						output: null,
						cacheRead: null,
						cacheWrite: null,
						total: null,
						contextSize: null,
						contextWindowSize: null,
					},
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
			return await result.current.spawn('ship it');
		});

		expect(turnResult.exitCode).toBe(1);
		expect(spawn).toHaveBeenCalledTimes(1);
	});
});
