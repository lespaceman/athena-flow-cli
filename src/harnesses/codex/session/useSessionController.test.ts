/**
 * @vitest-environment jsdom
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import type {Runtime} from '../../../core/runtime/types';
import {useCodexSessionController} from './useSessionController';

describe('useCodexSessionController', () => {
	const sendPrompt = vi.fn<(...args: unknown[]) => Promise<void>>();
	const sendInterrupt = vi.fn();
	const onEvent = vi.fn(() => vi.fn());

	beforeEach(() => {
		sendPrompt.mockReset();
		sendPrompt.mockResolvedValue(undefined);
		sendInterrupt.mockReset();
		onEvent.mockClear();
	});

	it('forwards session resume ids to the Codex runtime', async () => {
		const runtime = {
			sendPrompt,
			sendInterrupt,
			onEvent,
		} as unknown as Runtime;

		const {result} = renderHook(() =>
			useCodexSessionController(runtime, {model: 'gpt-5.3-codex'}),
		);

		await act(async () => {
			await result.current.spawn(
				'continue the task',
				{mode: 'resume', handle: 'thread-123'},
				{
					model: 'gpt-5.3-codex',
				},
			);
		});

		expect(sendPrompt).toHaveBeenCalledWith('continue the task', {
			continuation: {mode: 'resume', handle: 'thread-123'},
			model: 'gpt-5.3-codex',
			developerInstructions: undefined,
			skillRoots: undefined,
			config: undefined,
			ephemeral: undefined,
		});
		expect(result.current.isRunning).toBe(false);
	});

	it('forwards ephemeral execution to the Codex runtime', async () => {
		const runtime = {
			sendPrompt,
			sendInterrupt,
			onEvent,
		} as unknown as Runtime;

		const {result} = renderHook(() =>
			useCodexSessionController(
				runtime,
				{model: 'gpt-5.3-codex'},
				undefined,
				true,
			),
		);

		await act(async () => {
			await result.current.spawn('ephemeral task');
		});

		expect(sendPrompt).toHaveBeenCalledWith(
			'ephemeral task',
			expect.objectContaining({
				ephemeral: true,
			}),
		);
	});
});
