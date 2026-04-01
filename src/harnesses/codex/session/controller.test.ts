import {describe, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {createCodexSessionController} from './controller';

function makeRuntime() {
	const emitter = new EventEmitter();
	const onEvent = vi.fn((handler: (event: Record<string, unknown>) => void) => {
		emitter.on('event', handler);
		return () => emitter.off('event', handler);
	});
	const sendPrompt = vi.fn(async () => {
		emitter.emit('event', {
			kind: 'turn.complete',
			hookName: 'turn/completed',
			data: {status: 'completed'},
		});
	});
	return {
		runtime: {
			sendPrompt,
			sendInterrupt: vi.fn(),
			onEvent,
		},
		emitter,
		sendPrompt,
	};
}

describe('createCodexSessionController', () => {
	it('returns success for completed turns', async () => {
		const {runtime, sendPrompt} = makeRuntime();
		const controller = createCodexSessionController({
			projectDir: '/tmp',
			instanceId: 1,
			runtime: runtime as never,
		});

		const result = await controller.startTurn({prompt: 'hello'});

		expect(sendPrompt).toHaveBeenCalled();
		expect(result).toEqual(
			expect.objectContaining({
				exitCode: 0,
				error: null,
			}),
		);
	});

	it('returns a failed turn as an execution error', async () => {
		const emitter = new EventEmitter();
		const sendPrompt = vi.fn(async () => {
			emitter.emit('event', {
				kind: 'unknown',
				hookName: 'error',
				data: {
					payload: {
						error: {
							message: 'unexpected status 401 Unauthorized',
						},
					},
				},
			});
			emitter.emit('event', {
				kind: 'turn.complete',
				hookName: 'turn/completed',
				data: {status: 'failed'},
			});
		});
		const controller = createCodexSessionController({
			projectDir: '/tmp',
			instanceId: 1,
			runtime: {
				sendPrompt,
				sendInterrupt: vi.fn(),
				onEvent: (handler: (event: Record<string, unknown>) => void) => {
					emitter.on('event', handler);
					return () => emitter.off('event', handler);
				},
			} as never,
		});

		const result = await controller.startTurn({prompt: 'hello'});

		expect(result.exitCode).toBe(1);
		expect(result.error?.message).toBe('unexpected status 401 Unauthorized');
	});
});
