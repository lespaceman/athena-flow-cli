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
});
