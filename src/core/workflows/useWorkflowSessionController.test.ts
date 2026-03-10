/**
 * @vitest-environment jsdom
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import {useWorkflowSessionController} from './useWorkflowSessionController';
import type {UseSessionControllerResult} from '../../harnesses/contracts/session';

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
			.fn<UseSessionControllerResult['spawn']>()
			.mockImplementation(async (_prompt, _sessionId, _configOverride) => {
				const call = spawn.mock.calls.length;
				if (call === 1) {
					fs.writeFileSync(trackerPath, 'still running', 'utf-8');
					return;
				}

				fs.writeFileSync(trackerPath, '<!-- DONE -->', 'utf-8');
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
			await result.current.spawn('ship it', 'session-1');
		});

		expect(spawn).toHaveBeenNthCalledWith(
			1,
			'Execute: ship it',
			'session-1',
			{
				appendSystemPromptFile: promptPath,
				developerInstructions: 'Always read the tracker.',
			},
		);
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			'Continue with tracker.md',
			undefined,
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
			.fn<UseSessionControllerResult['spawn']>()
			.mockImplementationOnce(
				() =>
					new Promise<void>(resolve => {
						releaseFirstSpawn = resolve;
					}),
			)
			.mockResolvedValueOnce(undefined);

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

		let firstSpawnPromise: Promise<void>;
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
});
