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
			await result.current.startTurn(
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
			approvalPolicy: 'on-request',
			sandbox: 'workspace-write',
		});
		expect(result.current.isRunning).toBe(false);
	});

	it('uses delta.contextSize for context occupancy instead of cumulative usage', async () => {
		let eventHandler: (event: Record<string, unknown>) => void = () => {};
		const onEventSpy = vi.fn(
			(handler: (event: Record<string, unknown>) => void) => {
				eventHandler = handler;
				return vi.fn(); // unsub
			},
		);

		const runtime = {
			sendPrompt,
			sendInterrupt,
			onEvent: onEventSpy,
		} as unknown as Runtime;

		const {result} = renderHook(() =>
			useCodexSessionController(runtime, {model: 'gpt-5.3-codex'}),
		);

		// Simulate a usage.update event where cumulative totals differ from per-turn delta
		act(() => {
			eventHandler({
				kind: 'usage.update',
				data: {
					usage: {
						input: 500_000,
						output: 20_000,
						cacheRead: 100_000,
						cacheWrite: null,
						total: 620_000,
						contextSize: 600_000, // cumulative — wrong for context bar
						contextWindowSize: 200_000,
					},
					delta: {
						input: 50_000,
						output: 5_000,
						cacheRead: 30_000,
						cacheWrite: null,
						total: 85_000,
						contextSize: 80_000, // actual per-turn occupancy
						contextWindowSize: 200_000,
					},
				},
			});
		});

		// contextSize should come from delta (80k), not cumulative usage (600k)
		expect(result.current.tokenUsage.contextSize).toBe(80_000);
		// billing totals should still come from usage
		expect(result.current.tokenUsage.input).toBe(500_000);
		expect(result.current.tokenUsage.output).toBe(20_000);
		expect(result.current.tokenUsage.total).toBe(620_000);
		expect(result.current.tokenUsage.contextWindowSize).toBe(200_000);
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
			await result.current.startTurn('ephemeral task');
		});

		expect(sendPrompt).toHaveBeenCalledWith(
			'ephemeral task',
			expect.objectContaining({
				ephemeral: true,
			}),
		);
	});
});
