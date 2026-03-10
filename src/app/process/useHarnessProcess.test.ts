/** @vitest-environment jsdom */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {renderHook} from '@testing-library/react';

const useSessionControllerMock = vi.fn();
const resolveHarnessAdapterMock = vi.fn(() => ({
	useSessionController: useSessionControllerMock,
}));

vi.mock('../../harnesses/registry', () => ({
	resolveHarnessAdapter: (harness: string) =>
		resolveHarnessAdapterMock(harness),
}));

const {useHarnessProcess} = await import('./useHarnessProcess');

describe('useHarnessProcess', () => {
	beforeEach(() => {
		useSessionControllerMock.mockReset();
		resolveHarnessAdapterMock.mockClear();
		useSessionControllerMock.mockReturnValue({
			spawn: vi.fn(),
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
		});
	});

	it('exposes the neutral process contract', () => {
		const {result} = renderHook(() =>
			useHarnessProcess({
				harness: 'claude-code',
				projectDir: '/tmp/project',
				instanceId: 1,
			}),
		);

		expect(typeof result.current.spawn).toBe('function');
		expect(typeof result.current.interrupt).toBe('function');
		expect(typeof result.current.kill).toBe('function');
		expect(typeof result.current.isRunning).toBe('boolean');
		expect(result.current.usage).toEqual(result.current.tokenUsage);
	});

	it('delegates controller creation to the resolved harness adapter', () => {
		useSessionControllerMock.mockReturnValue({
			spawn: vi.fn(),
			isRunning: true,
			interrupt: vi.fn(),
			kill: vi.fn().mockResolvedValue(undefined),
			usage: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				total: 10,
				contextSize: 8,
			},
		});

		renderHook(() =>
			useHarnessProcess({
				harness: 'claude-code',
				projectDir: '/tmp/project',
				instanceId: 99,
				options: {tokenUpdateMs: 250},
			}),
		);

		expect(resolveHarnessAdapterMock).toHaveBeenCalledWith('claude-code');
		expect(useSessionControllerMock).toHaveBeenCalledWith({
			projectDir: '/tmp/project',
			instanceId: 99,
			processConfig: undefined,
			pluginMcpConfig: undefined,
			verbose: undefined,
			workflow: undefined,
			workflowPlan: undefined,
			options: {tokenUpdateMs: 250},
			runtime: null,
		});
	});
});
