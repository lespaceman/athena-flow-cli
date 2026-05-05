import {describe, expect, it, vi} from 'vitest';
import {ConsoleAdapter} from './adapter';
import type {
	AthenaConsoleFrame,
	AthenaConsoleReadyFrame,
	NormalizedInbound,
} from '../../../shared/gateway-protocol';
import type {ConsoleBrokerClient} from './client';
import type {ConsoleAdapterOptions} from './types';

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

class FakeBrokerClient implements ConsoleBrokerClient {
	connected = false;
	closed = false;
	sent: AthenaConsoleFrame[] = [];
	private frameHandlers: Array<(f: AthenaConsoleFrame) => void> = [];
	private closeHandlers: Array<(reason: string) => void> = [];
	private readyHandlers: Array<
		(addr: AthenaConsoleReadyFrame['address']) => void
	> = [];
	private ready = false;

	async connect(): Promise<void> {
		this.connected = true;
		this.ready = true;
		for (const h of this.readyHandlers) h({runnerId: 'r1'});
	}
	close(reason: string): void {
		this.closed = true;
		this.connected = false;
		this.ready = false;
		for (const h of this.closeHandlers) h(reason);
	}
	sendFrame(frame: AthenaConsoleFrame): void {
		this.sent.push(frame);
	}
	onFrame(handler: (f: AthenaConsoleFrame) => void): void {
		this.frameHandlers.push(handler);
	}
	onReady(handler: (addr: AthenaConsoleReadyFrame['address']) => void): void {
		this.readyHandlers.push(handler);
	}
	onClose(handler: (reason: string) => void): void {
		this.closeHandlers.push(handler);
	}
	getReadyAddress() {
		return this.ready ? {runnerId: 'r1'} : null;
	}
	isReady(): boolean {
		return this.ready;
	}

	deliver(frame: AthenaConsoleFrame): void {
		for (const h of this.frameHandlers) h(frame);
	}

	/** Simulates a connection blip: close → open → ready. */
	simulateReconnect(): void {
		for (const h of this.closeHandlers) h('blip');
		this.ready = true;
		for (const h of this.readyHandlers) h({runnerId: 'r1'});
	}
}

function makeAdapter(overrides: Partial<ConsoleAdapterOptions> = {}) {
	const fake = new FakeBrokerClient();
	const adapter = new ConsoleAdapter({
		brokerUrl: 'wss://broker.test/adapter',
		runnerId: 'r1',
		workspaceId: 'ws1',
		pairingToken: 'tok',
		brokerClientFactory: () => fake,
		...overrides,
	});
	return {adapter, fake};
}

async function startAdapter(adapter: ConsoleAdapter, log: LogFn = () => {}) {
	const abort = new AbortController();
	const inbound: NormalizedInbound[] = [];
	const health: unknown[] = [];
	await adapter.start({
		log,
		signal: abort.signal,
		emitInbound: msg => inbound.push(msg),
		emitHealth: sample => health.push(sample),
	});
	return {abort, inbound, health};
}

describe('ConsoleAdapter — inbound', () => {
	it('normalizes console.message.in into a NormalizedInbound and emits it', async () => {
		const {adapter, fake} = makeAdapter();
		const handle = await startAdapter(adapter);

		fake.deliver({
			kind: 'console.message.in',
			frameId: 'f1',
			sentAt: 1_700_000_000_000,
			address: {
				runnerId: 'r1',
				workspaceId: 'ws1',
				userId: 'u42',
				threadId: 't1',
			},
			messageId: 'm-1',
			idempotencyKey: 'broker-key-1',
			text: 'hello athena',
		});

		await vi.waitFor(() => expect(handle.inbound).toHaveLength(1));
		const msg = handle.inbound[0]!;
		expect(msg.text).toBe('hello athena');
		expect(msg.location.channelId).toBe('console');
		expect(msg.location.peer?.id).toBe('u42');
		expect(msg.location.thread?.id).toBe('t1');
		expect(msg.location.accountId).toBe('ws1');
		expect(msg.idempotencyKey).toBe('broker-key-1');
		expect(msg.providerMessageId).toBe('m-1');
		expect(msg.sender.id).toBe('u42');

		await adapter.stop('shutdown');
	});

	it('falls back to derived idempotency key when frame omits one', async () => {
		const {adapter, fake} = makeAdapter();
		const handle = await startAdapter(adapter);
		fake.deliver({
			kind: 'console.message.in',
			frameId: 'f1',
			sentAt: 0,
			address: {runnerId: 'r1', userId: 'u42'},
			messageId: 'm-2',
			idempotencyKey: '',
			text: 'hi',
		});
		await vi.waitFor(() => expect(handle.inbound).toHaveLength(1));
		expect(handle.inbound[0]!.idempotencyKey).toBe('console:r1:m-2');
		await adapter.stop('shutdown');
	});

	it('drops console.message.in with empty text', async () => {
		const {adapter, fake} = makeAdapter();
		const handle = await startAdapter(adapter);
		fake.deliver({
			kind: 'console.message.in',
			frameId: 'f',
			sentAt: 0,
			address: {runnerId: 'r1'},
			messageId: 'm',
			idempotencyKey: 'k',
			text: '',
		});
		await new Promise(r => setTimeout(r, 10));
		await adapter.stop('shutdown');
		expect(handle.inbound).toEqual([]);
	});

	it('refuses double-start', async () => {
		const {adapter} = makeAdapter();
		await startAdapter(adapter);
		await expect(startAdapter(adapter)).rejects.toThrow(/already started/);
		await adapter.stop('shutdown');
	});

	it('throws if pairing token cannot be loaded from token_path', async () => {
		const adapter = new ConsoleAdapter({
			brokerUrl: 'wss://broker.test/adapter',
			runnerId: 'r1',
			tokenPath: '/path/that/does/not/exist',
			brokerClientFactory: () => new FakeBrokerClient(),
		});
		await expect(startAdapter(adapter)).rejects.toThrow(/token_path/);
	});
});

describe('ConsoleAdapter — outbound', () => {
	it('sends console.message.out with idempotency key and address derived from location', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);

		const result = await adapter.send({
			location: {
				channelId: 'console',
				accountId: 'ws1',
				peer: {id: 'u42', kind: 'user'},
				thread: {id: 't1'},
			},
			text: 'reply text',
			idempotencyKey: 'turn-abc',
		});

		expect(fake.sent).toHaveLength(1);
		const frame = fake.sent[0]!;
		expect(frame.kind).toBe('console.message.out');
		if (frame.kind !== 'console.message.out') return;
		expect(frame.text).toBe('reply text');
		expect(frame.idempotencyKey).toBe('turn-abc');
		expect(frame.address.runnerId).toBe('r1');
		expect(frame.address.workspaceId).toBe('ws1');
		expect(frame.address.userId).toBe('u42');
		expect(frame.address.threadId).toBe('t1');
		expect(result.providerMessageId).toBe(frame.messageId);

		await adapter.stop('shutdown');
	});

	it('throws if send is called before start', async () => {
		const {adapter} = makeAdapter();
		await expect(
			adapter.send({
				location: {channelId: 'console', accountId: 'ws1'},
				text: 't',
				idempotencyKey: 'k',
			}),
		).rejects.toThrow(/before start|not connected|before broker/);
	});

	it('falls back to location.accountId for workspaceId when config omits it', async () => {
		const {adapter, fake} = makeAdapter({workspaceId: undefined});
		await startAdapter(adapter);
		await adapter.send({
			location: {
				channelId: 'console',
				accountId: 'ws-from-inbound',
				peer: {id: 'u1', kind: 'user'},
			},
			text: 'reply',
			idempotencyKey: 'k',
		});
		const frame = fake.sent[0]!;
		expect(frame.kind).toBe('console.message.out');
		if (frame.kind !== 'console.message.out') return;
		expect(frame.address.workspaceId).toBe('ws-from-inbound');
		await adapter.stop('shutdown');
	});

	it('preserves conversation routing on outbound replies', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);

		await adapter.send({
			location: {
				channelId: 'console',
				accountId: 'ws1',
				peer: {id: 'u42', kind: 'user'},
				thread: {id: 'conversation-1'},
			},
			text: 'reply text',
			idempotencyKey: 'turn-abc',
		});

		const frame = fake.sent[0]!;
		expect(frame.kind).toBe('console.message.out');
		if (frame.kind !== 'console.message.out') return;
		expect(frame.address.conversationId).toBe('conversation-1');
		expect(frame.address.threadId).toBe('conversation-1');
		await adapter.stop('shutdown');
	});
});

describe('ConsoleAdapter — permission relay', () => {
	it('round-trips an allow verdict through the broker', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);

		const abort = new AbortController();
		const verdictPromise = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'abcde',
				toolName: 'shell',
				description: 'run ls',
				inputPreview: 'ls -la',
			},
			abort.signal,
		);

		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		const sent = fake.sent[0]!;
		expect(sent.kind).toBe('console.permission.request');
		if (sent.kind !== 'console.permission.request') {
			throw new Error('wrong kind');
		}
		expect(sent.channelRequestId).toBe('abcde');

		fake.deliver({
			kind: 'console.permission.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'abcde',
			decision: 'allow',
		});

		const result = await verdictPromise;
		expect(result).toEqual({
			kind: 'verdict',
			behavior: 'allow',
			channelId: 'console',
		});

		await adapter.stop('shutdown');
	});

	it('round-trips a deny verdict', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'aaaaa',
				toolName: 't',
				description: 'd',
				inputPreview: 'i',
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		fake.deliver({
			kind: 'console.permission.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'aaaaa',
			decision: 'deny',
		});
		expect((await p).kind).toBe('verdict');
		await adapter.stop('shutdown');
	});

	it('sends console.permission.cancel on signal abort', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'bbbbb',
				toolName: 't',
				description: 'd',
				inputPreview: 'i',
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		abort.abort();
		const result = await p;
		expect(result.kind).toBe('cancelled');
		expect(fake.sent.length).toBe(2);
		const cancelFrame = fake.sent[1]!;
		expect(cancelFrame.kind).toBe('console.permission.cancel');
		if (cancelFrame.kind !== 'console.permission.cancel') {
			throw new Error('wrong kind');
		}
		expect(cancelFrame.channelRequestId).toBe('bbbbb');
		await adapter.stop('shutdown');
	});

	it('ignores late responses after cancellation', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'ccccc',
				toolName: 't',
				description: 'd',
				inputPreview: 'i',
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		abort.abort();
		await p;
		// late response — should be silently dropped
		fake.deliver({
			kind: 'console.permission.response',
			frameId: 'late',
			sentAt: 0,
			channelRequestId: 'ccccc',
			decision: 'allow',
		});
		await new Promise(r => setTimeout(r, 10));
		await adapter.stop('shutdown');
		// no throw means we ignored the late frame correctly
	});

	it('cancels pending relays on stop with kind=cancelled', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'ddddd',
				toolName: 't',
				description: 'd',
				inputPreview: 'i',
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		await adapter.stop('shutdown');
		const result = await p;
		expect(result.kind).toBe('cancelled');
	});
});

describe('ConsoleAdapter — frame validation', () => {
	it('drops console.message.in claiming a different runnerId', async () => {
		const {adapter, fake} = makeAdapter();
		const logs: Array<[string, string]> = [];
		const handle = await startAdapter(adapter, (lvl, msg) =>
			logs.push([lvl, msg]),
		);
		fake.deliver({
			kind: 'console.message.in',
			frameId: 'f',
			sentAt: 0,
			address: {runnerId: 'someone-else', userId: 'u1'},
			messageId: 'm-1',
			idempotencyKey: 'k',
			text: 'hi',
		});
		await new Promise(r => setTimeout(r, 10));
		expect(handle.inbound).toEqual([]);
		expect(
			logs.some(([lvl, msg]) => lvl === 'warn' && /runner mismatch/.test(msg)),
		).toBe(true);
		await adapter.stop('shutdown');
	});

	it('drops console.message.in with malformed address', async () => {
		const {adapter, fake} = makeAdapter();
		const handle = await startAdapter(adapter);
		fake.deliver({
			kind: 'console.message.in',
			frameId: 'f',
			sentAt: 0,
			// runnerId missing — pretend a buggy broker sent this
			address: {runnerId: ''} as unknown as {runnerId: string},
			messageId: 'm-1',
			idempotencyKey: 'k',
			text: 'hi',
		});
		await new Promise(r => setTimeout(r, 10));
		expect(handle.inbound).toEqual([]);
		await adapter.stop('shutdown');
	});

	it('drops console.permission.response with invalid decision', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'pvalid',
				toolName: 't',
				description: 'd',
				inputPreview: 'i',
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		// Buggy broker — decision is neither 'allow' nor 'deny'
		fake.deliver({
			kind: 'console.permission.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'pvalid',
			decision: 'maybe' as unknown as 'allow',
		});
		// Pending entry must remain — invalid response is dropped
		await new Promise(r => setTimeout(r, 10));
		// Now resolve cleanly via cancellation.
		abort.abort();
		const result = await p;
		expect(result.kind).toBe('cancelled');
		await adapter.stop('shutdown');
	});

	it('strips non-string answer values from question.response', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestQuestionAnswer(
			{
				channelRequestId: 'qbad',
				title: 't',
				questions: [
					{
						key: 'k',
						header: 'h',
						question: 'q',
						multi_select: false,
						options: [{label: 'a', description: ''}],
					},
				],
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		fake.deliver({
			kind: 'console.question.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'qbad',
			// k=42 is not a string — must be dropped
			answers: {k: 42 as unknown as string, other: 'ignored'},
		});
		const result = await p;
		// k was dropped, other doesn't match question keys, so cancelled
		expect(result.kind).toBe('cancelled');
		await adapter.stop('shutdown');
	});
});

describe('ConsoleAdapter — reconnect health + relay disposal', () => {
	it('emits transportOk:false then transportOk:true on a broker reconnect', async () => {
		const {adapter, fake} = makeAdapter();
		const handle = await startAdapter(adapter);
		expect(handle.health.at(-1)).toMatchObject({transportOk: true});
		fake.simulateReconnect();
		const last = handle.health.at(-1) as {transportOk: boolean};
		const prev = handle.health.at(-2) as {transportOk: boolean};
		expect(prev.transportOk).toBe(false);
		expect(last.transportOk).toBe(true);
		await adapter.stop('shutdown');
	});

	it('disposes pending permission relays as cancelled when broker closes', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestPermissionVerdict(
			{
				channelRequestId: 'eeeee',
				toolName: 't',
				description: 'd',
				inputPreview: 'i',
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		fake.simulateReconnect();
		const result = await p;
		expect(result.kind).toBe('cancelled');
		await adapter.stop('shutdown');
	});

	it('disposes pending question relays as cancelled when broker closes', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestQuestionAnswer(
			{
				channelRequestId: 'qeee',
				title: 't',
				questions: [
					{
						key: 'k',
						header: 'h',
						question: 'q',
						multi_select: false,
						options: [{label: 'a', description: ''}],
					},
				],
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		fake.simulateReconnect();
		expect((await p).kind).toBe('cancelled');
		await adapter.stop('shutdown');
	});
});

describe('ConsoleAdapter — question relay', () => {
	const sampleQuestion = {
		key: 'priority',
		header: 'Priority',
		question: 'Which priority?',
		multi_select: false,
		options: [
			{label: 'high', description: 'P0'},
			{label: 'low', description: 'P3'},
		],
	};

	it('round-trips an answer through the broker', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestQuestionAnswer(
			{
				channelRequestId: 'qabcd',
				title: 'Pick one',
				questions: [sampleQuestion],
			},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		expect(fake.sent[0]!.kind).toBe('console.question.request');

		fake.deliver({
			kind: 'console.question.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'qabcd',
			answers: {priority: 'high'},
		});

		const result = await p;
		expect(result.kind).toBe('answer');
		if (result.kind !== 'answer') throw new Error('wrong kind');
		expect(result.answers).toEqual({priority: 'high'});
		expect(result.channelId).toBe('console');

		await adapter.stop('shutdown');
	});

	it('sends console.question.cancel on signal abort', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestQuestionAnswer(
			{channelRequestId: 'qaa', title: 't', questions: [sampleQuestion]},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		abort.abort();
		const result = await p;
		expect(result.kind).toBe('cancelled');
		expect(fake.sent.length).toBe(2);
		const cancelFrame = fake.sent[1]!;
		expect(cancelFrame.kind).toBe('console.question.cancel');
		if (cancelFrame.kind !== 'console.question.cancel') {
			throw new Error('wrong kind');
		}
		expect(cancelFrame.channelRequestId).toBe('qaa');
		await adapter.stop('shutdown');
	});

	it('drops answers for unknown keys but accepts the rest', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestQuestionAnswer(
			{channelRequestId: 'qbb', title: 't', questions: [sampleQuestion]},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		fake.deliver({
			kind: 'console.question.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'qbb',
			answers: {priority: 'high', unknown: 'ignored'},
		});
		const result = await p;
		expect(result.kind).toBe('answer');
		if (result.kind !== 'answer') throw new Error('wrong kind');
		expect(result.answers).toEqual({priority: 'high'});
		await adapter.stop('shutdown');
	});

	it('returns cancelled when no answers match question keys', async () => {
		const {adapter, fake} = makeAdapter();
		await startAdapter(adapter);
		const abort = new AbortController();
		const p = adapter.requestQuestionAnswer(
			{channelRequestId: 'qcc', title: 't', questions: [sampleQuestion]},
			abort.signal,
		);
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		fake.deliver({
			kind: 'console.question.response',
			frameId: 'r',
			sentAt: 0,
			channelRequestId: 'qcc',
			answers: {totally: 'wrong'},
		});
		const result = await p;
		expect(result.kind).toBe('cancelled');
		await adapter.stop('shutdown');
	});
});

describe('ConsoleAdapter: dashboard_config token source', () => {
	function makeAdapterWithDashboardConfig(provider?: () => Promise<string>) {
		const fake = new FakeBrokerClient();
		const factoryInputs: Array<{
			pairingToken?: string;
			pairingTokenProvider?: () => Promise<string>;
		}> = [];
		const adapter = new ConsoleAdapter({
			brokerUrl: 'wss://broker.test/adapter',
			runnerId: 'r1',
			dashboardConfig: true,
			...(provider !== undefined ? {pairingTokenProvider: provider} : {}),
			brokerClientFactory: input => {
				factoryInputs.push({
					pairingToken: input.pairingToken,
					pairingTokenProvider: input.pairingTokenProvider,
				});
				return fake;
			},
		});
		return {adapter, fake, factoryInputs};
	}

	it('forwards a pairingTokenProvider to the broker client and never a static token', async () => {
		const provider = vi.fn().mockResolvedValue('access-from-dashboard');
		const {adapter, factoryInputs} = makeAdapterWithDashboardConfig(provider);
		await startAdapter(adapter);
		expect(factoryInputs).toHaveLength(1);
		expect(factoryInputs[0]!.pairingToken).toBeUndefined();
		expect(factoryInputs[0]!.pairingTokenProvider).toBe(provider);
		await adapter.stop('shutdown');
	});

	it('rejects construction when neither pairing source is configured', async () => {
		const adapter = new ConsoleAdapter({
			brokerUrl: 'wss://broker.test/adapter',
			runnerId: 'r1',
			brokerClientFactory: () => new FakeBrokerClient(),
		});
		await expect(startAdapter(adapter)).rejects.toThrow(
			/no pairing_token, token_path, or dashboard_config/,
		);
	});
});
