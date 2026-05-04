import {describe, expect, it, vi} from 'vitest';
import type {
	ChannelAdapter,
	ChannelCapabilities,
	PermissionRelayRequest,
	PermissionRelayResult,
	ProbeResult,
	QuestionRelayRequest,
	QuestionRelayResult,
	SendResult,
} from '../../shared/gateway-protocol';
import {RelayCoordinator} from './coordinator';

function makeAdapter(
	id: string,
	overrides: {
		caps?: Partial<ChannelCapabilities>;
		permission?: (
			req: PermissionRelayRequest,
			signal: AbortSignal,
		) => Promise<PermissionRelayResult>;
		question?: (
			req: QuestionRelayRequest,
			signal: AbortSignal,
		) => Promise<QuestionRelayResult>;
	} = {},
): ChannelAdapter {
	return {
		id,
		capabilities: {
			chat: true,
			threads: false,
			relayPermission: true,
			relayQuestion: true,
			...overrides.caps,
		},
		start: async () => {},
		stop: async () => {},
		send: async (): Promise<SendResult> => ({
			providerMessageId: 'm',
			deliveredAt: 0,
		}),
		probe: async (): Promise<ProbeResult> => ({ok: true, checkedAt: 0}),
		on: () => {},
		off: () => {},
		...(overrides.permission
			? {requestPermissionVerdict: overrides.permission}
			: {}),
		...(overrides.question ? {requestQuestionAnswer: overrides.question} : {}),
	};
}

describe('RelayCoordinator', () => {
	it('returns no_relay when no adapter advertises permission relay', async () => {
		const adapter = makeAdapter('a', {caps: {relayPermission: false}});
		const coord = new RelayCoordinator({adapters: () => [adapter]});
		const {result} = coord.requestPermission({
			toolName: 'Bash',
			description: 'ls',
			inputPreview: '',
		});
		await expect(result).resolves.toEqual({kind: 'no_relay'});
	});

	it('returns the first verdict and aborts losers', async () => {
		const aborts: boolean[] = [];
		const slowAdapter = makeAdapter('slow', {
			permission: (_req, signal) =>
				new Promise(resolve => {
					signal.addEventListener('abort', () => {
						aborts.push(true);
						resolve({kind: 'cancelled', reason: 'resolved_by_other_channel'});
					});
				}),
		});
		const fastAdapter = makeAdapter('fast', {
			permission: async () => ({
				kind: 'verdict',
				behavior: 'allow',
				channelId: 'placeholder',
			}),
		});
		const coord = new RelayCoordinator({
			adapters: () => [slowAdapter, fastAdapter],
		});
		const {result} = coord.requestPermission({
			toolName: 'Bash',
			description: 'ls',
			inputPreview: '',
		});
		await expect(result).resolves.toEqual({
			kind: 'verdict',
			behavior: 'allow',
			channelId: 'fast',
		});
		expect(aborts).toEqual([true]);
	});

	it('cancel() resolves pending request as cancelled', async () => {
		const adapter = makeAdapter('a', {
			permission: (_req, signal) =>
				new Promise(resolve => {
					signal.addEventListener('abort', () =>
						resolve({kind: 'cancelled', reason: 'resolved_locally'}),
					);
				}),
		});
		const coord = new RelayCoordinator({adapters: () => [adapter]});
		const {channelRequestId, result} = coord.requestPermission({
			toolName: 'Bash',
			description: 'ls',
			inputPreview: '',
		});
		expect(coord.cancel(channelRequestId, 'resolved_locally')).toBe(true);
		await expect(result).resolves.toEqual({
			kind: 'cancelled',
			reason: 'resolved_locally',
		});
	});

	it('TTL elapses → cancelled with reason=timeout', async () => {
		vi.useFakeTimers();
		try {
			const adapter = makeAdapter('a', {
				permission: () => new Promise(() => {}),
			});
			const coord = new RelayCoordinator({
				adapters: () => [adapter],
				defaultTtlMs: 100,
			});
			const {result} = coord.requestPermission({
				toolName: 'Bash',
				description: 'ls',
				inputPreview: '',
			});
			vi.advanceTimersByTime(101);
			await expect(result).resolves.toEqual({
				kind: 'cancelled',
				reason: 'timeout',
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('question relay honours the same race semantics', async () => {
		const adapter = makeAdapter('a', {
			question: async () => ({
				kind: 'answer',
				answers: {q: 'yes'},
				channelId: 'placeholder',
			}),
		});
		const coord = new RelayCoordinator({adapters: () => [adapter]});
		const {result} = coord.requestQuestion({
			title: 'pick',
			questions: [
				{
					key: 'q',
					header: 'h',
					question: 'q?',
					multi_select: false,
					options: [],
				},
			],
		});
		await expect(result).resolves.toEqual({
			kind: 'answer',
			answers: {q: 'yes'},
			channelId: 'a',
		});
	});

	it('duplicate channelRequestId with matching payload attaches and does not rebroadcast', async () => {
		let calls = 0;
		const adapter = makeAdapter('a', {
			permission: (_req, signal) => {
				calls += 1;
				return new Promise(resolve => {
					signal.addEventListener('abort', () =>
						resolve({kind: 'cancelled', reason: 'resolved_locally'}),
					);
				});
			},
		});
		const coord = new RelayCoordinator({adapters: () => [adapter]});
		const first = coord.requestPermission({
			channelRequestId: 'abcde',
			toolName: 'Bash',
			description: 'ls',
			inputPreview: 'ls',
		});
		// Allow the first broadcast to dispatch to the adapter before the
		// duplicate attaches; the adapter callback is invoked via a
		// Promise.resolve().then(...) hop.
		await Promise.resolve();
		const second = coord.requestPermission({
			channelRequestId: 'abcde',
			toolName: 'Bash',
			description: 'ls',
			inputPreview: 'ls',
		});
		expect(second.channelRequestId).toBe('abcde');
		expect(second.result).toBe(first.result);
		expect(calls).toBe(1);
		expect(coord.pendingCount()).toBe(1);
	});

	it('duplicate channelRequestId with different payload throws collision', async () => {
		const adapter = makeAdapter('a', {
			permission: (_req, _signal) => new Promise(() => {}),
		});
		const coord = new RelayCoordinator({adapters: () => [adapter]});
		coord.requestPermission({
			channelRequestId: 'abcde',
			toolName: 'Bash',
			description: 'ls',
			inputPreview: 'ls',
		});
		expect(() =>
			coord.requestPermission({
				channelRequestId: 'abcde',
				toolName: 'Bash',
				description: 'rm',
				inputPreview: 'rm -rf /',
			}),
		).toThrow(/channel_request_id_collision/);
	});

	it('duplicate channelRequestId across kinds rejects', async () => {
		const dualAdapter = makeAdapter('a', {
			permission: (_req, _signal) => new Promise(() => {}),
			question: (_req, _signal) => new Promise(() => {}),
		});
		const coord = new RelayCoordinator({adapters: () => [dualAdapter]});
		coord.requestPermission({
			channelRequestId: 'abcde',
			toolName: 'Bash',
			description: 'ls',
			inputPreview: 'ls',
		});
		expect(() =>
			coord.requestQuestion({
				channelRequestId: 'abcde',
				title: 'pick',
				questions: [
					{
						key: 'q',
						header: 'h',
						question: 'q?',
						multi_select: false,
						options: [],
					},
				],
			}),
		).toThrow(/channel_request_id_collision/);
	});

	it('disposeAll cancels every pending entry', async () => {
		const adapter = makeAdapter('a', {
			permission: (_req, signal) =>
				new Promise(resolve =>
					signal.addEventListener('abort', () =>
						resolve({kind: 'cancelled', reason: 'auto_resolved'}),
					),
				),
		});
		const coord = new RelayCoordinator({adapters: () => [adapter]});
		const {result: r1} = coord.requestPermission({
			toolName: 'a',
			description: '',
			inputPreview: '',
		});
		const {result: r2} = coord.requestPermission({
			toolName: 'b',
			description: '',
			inputPreview: '',
		});
		coord.disposeAll('auto_resolved');
		await expect(r1).resolves.toMatchObject({kind: 'cancelled'});
		await expect(r2).resolves.toMatchObject({kind: 'cancelled'});
		expect(coord.pendingCount()).toBe(0);
	});
});
