import {describe, expect, it, vi} from 'vitest';

import type {ExecRunOptions} from '../exec/types';
import {createRunnerSession} from './runnerSession';

type Captured = {
	runEvents: Array<{
		runId: string;
		seq: number;
		ts: number;
		kind: string;
		payload?: unknown;
	}>;
	completes: Array<{
		dispatchId: string;
		envelope: Record<string, unknown>;
	}>;
};

function makeBridge(captured: Captured) {
	return {
		sendRunEvent: vi.fn(async input => {
			captured.runEvents.push(input);
		}),
		completeTurn: vi.fn(async input => {
			captured.completes.push({
				dispatchId: input.dispatchId,
				envelope: JSON.parse(input.text) as Record<string, unknown>,
			});
			return {delivered: true};
		}),
	};
}

const baseRuntimeConfig = () => ({
	globalConfig: {
		plugins: [],
		additionalDirectories: [],
		workflowMarketplaceSources: [],
		workflowSelections: {},
	},
	projectConfig: {
		plugins: [],
		additionalDirectories: [],
		workflowMarketplaceSources: [],
		workflowSelections: {},
	},
	harness: 'openai-codex' as const,
	isolationConfig: {preset: 'minimal' as const, additionalDirectories: []},
	workflowRef: undefined,
	workflow: undefined,
	workflowPlan: undefined,
	modelName: null,
	warnings: [],
});

const baseLocation = {channelId: 'runner:r1', accountId: 'runner:r1'};

describe('createRunnerSession', () => {
	it('routes a cancel envelope to abort the in-flight assignment', async () => {
		const captured: Captured = {runEvents: [], completes: []};
		const bridge = makeBridge(captured);

		let resolveSignal: (signal: AbortSignal) => void;
		const signalSeen = new Promise<AbortSignal>(r => {
			resolveSignal = r;
		});
		const runExecFn = vi.fn(async (options: ExecRunOptions) => {
			const signal = options.signal!;
			resolveSignal(signal);
			await new Promise<never>((_r, reject) => {
				signal.addEventListener('abort', () =>
					reject(new Error('aborted by signal')),
				);
			});
			throw new Error('unreachable');
		});

		const session = createRunnerSession({
			bridge,
			projectDir: '/tmp/project',
			runExecFn,
			bootstrapRuntimeConfigFn: baseRuntimeConfig,
			now: () => 1000,
		});

		const assignment = session.handleDispatch({
			text: JSON.stringify({
				kind: 'job_assignment',
				runId: 'run_cancel',
				runSpec: {prompt: 'block until cancelled'},
			}),
			dispatchId: 'd-1',
			location: baseLocation,
		});

		await signalSeen;

		session.handleDispatch({
			text: JSON.stringify({kind: 'cancel', runId: 'run_cancel'}),
			dispatchId: 'd-2',
			location: baseLocation,
		});

		await assignment.completed;

		expect(captured.completes).toHaveLength(1);
		expect(captured.completes[0]!.envelope).toMatchObject({
			eventKind: 'error',
			payload: {message: expect.stringMatching(/abort/i)},
		});
	});

	it('returns true on a recognised envelope and false on plain chat text', async () => {
		const captured: Captured = {runEvents: [], completes: []};
		const bridge = makeBridge(captured);
		const session = createRunnerSession({
			bridge,
			runExecFn: vi.fn(),
			bootstrapRuntimeConfigFn: baseRuntimeConfig,
		});

		const chat = session.handleDispatch({
			text: 'hello there',
			dispatchId: 'd-chat',
			location: baseLocation,
		});
		expect(chat.recognised).toBe(false);

		const cancelUnknown = session.handleDispatch({
			text: JSON.stringify({kind: 'cancel', runId: 'never-existed'}),
			dispatchId: 'd-cx',
			location: baseLocation,
		});
		expect(cancelUnknown.recognised).toBe(true);
		await cancelUnknown.completed;
	});
});
