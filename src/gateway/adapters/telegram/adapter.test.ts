import {describe, expect, it, vi} from 'vitest';
import type {TelegramUpdate} from '../../../shared/telegram/bot';
import {TelegramAdapter} from './adapter';

type LogFn = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

class FakeBot {
	private stopped = false;
	private updates: TelegramUpdate[] = [];
	private resolveNext: (() => void) | null = null;
	sentMessages: Array<{
		chatId: number | string;
		text: string;
		thread?: number;
	}> = [];
	sendResult: {message_id: number} | null = {message_id: 42};

	queue(update: TelegramUpdate): void {
		this.updates.push(update);
		this.resolveNext?.();
		this.resolveNext = null;
	}

	stop(): void {
		this.stopped = true;
		this.resolveNext?.();
		this.resolveNext = null;
	}

	isStopped(): boolean {
		return this.stopped;
	}

	getOffset(): number {
		return 0;
	}

	setOffset(_n: number): void {
		// noop
	}

	async *poll(): AsyncIterable<TelegramUpdate> {
		while (!this.stopped) {
			while (this.updates.length > 0 && !this.stopped) {
				const u = this.updates.shift()!;
				yield u;
			}
			if (this.stopped) return;
			await new Promise<void>(resolve => {
				this.resolveNext = resolve;
			});
		}
	}

	async sendMessage(
		chatId: number | string,
		text: string,
		options: {message_thread_id?: number} = {},
	) {
		this.sentMessages.push({
			chatId,
			text,
			...(options.message_thread_id !== undefined
				? {thread: options.message_thread_id}
				: {}),
		});
		return this.sendResult;
	}
}

function makeAdapter(allow: string[] = []) {
	const fake = new FakeBot();
	const adapter = new TelegramAdapter({
		token: 'tok',
		allowedUserIds: allow,
		botFactory: () => fake as unknown as never,
	});
	return {adapter, fake};
}

async function start(adapter: TelegramAdapter, log: LogFn = () => {}) {
	const ac = new AbortController();
	await adapter.start({log, signal: ac.signal});
	return ac;
}

const dmUpdate: TelegramUpdate = {
	update_id: 100,
	message: {
		message_id: 5,
		date: 0,
		chat: {id: 12345, type: 'private'},
		from: {id: 99, username: 'alice'},
		text: 'hello bot',
	},
};

describe('TelegramAdapter', () => {
	it('normalizes inbound DM into a NormalizedInbound', async () => {
		const {adapter, fake} = makeAdapter();
		const seen: unknown[] = [];
		adapter.on('inbound', m => seen.push(m));
		await start(adapter);

		fake.queue(dmUpdate);
		await waitUntil(() => seen.length === 1);
		await adapter.stop('shutdown');

		expect(seen).toHaveLength(1);
		const msg = seen[0] as {
			text: string;
			idempotencyKey: string;
			location: {peer?: {id: string}};
			providerMessageId: string;
		};
		expect(msg.text).toBe('hello bot');
		expect(msg.idempotencyKey).toBe('tg:100');
		expect(msg.location.peer?.id).toBe('12345');
		expect(msg.providerMessageId).toBe('5');
	});

	it('drops messages from non-allowlisted senders when allow list is non-empty', async () => {
		const {adapter, fake} = makeAdapter(['9999']);
		const seen: unknown[] = [];
		adapter.on('inbound', m => seen.push(m));
		await start(adapter);
		fake.queue(dmUpdate); // sender id 99 — not allowed
		// Give the loop a tick.
		await new Promise(r => setTimeout(r, 10));
		await adapter.stop('shutdown');
		expect(seen).toEqual([]);
	});

	it('sends outbound to peer chat and surfaces provider_message_id', async () => {
		const {adapter, fake} = makeAdapter();
		await start(adapter);
		const result = await adapter.send({
			location: {
				channelId: 'telegram',
				accountId: 'a',
				peer: {id: '12345', kind: 'user'},
			},
			text: 'hi',
			idempotencyKey: 'k1',
		});
		await adapter.stop('shutdown');
		expect(fake.sentMessages).toEqual([{chatId: '12345', text: 'hi'}]);
		expect(result.providerMessageId).toBe('42');
	});

	it('routes outbound to thread when location.thread is set', async () => {
		const {adapter, fake} = makeAdapter();
		await start(adapter);
		await adapter.send({
			location: {
				channelId: 'telegram',
				accountId: 'a',
				room: {id: '500', kind: 'group'},
				thread: {id: '7'},
			},
			text: 'topic msg',
			idempotencyKey: 'k2',
		});
		await adapter.stop('shutdown');
		expect(fake.sentMessages).toEqual([
			{chatId: '500', text: 'topic msg', thread: 7},
		]);
	});

	it('throws if send is called before start', async () => {
		const {adapter} = makeAdapter();
		await expect(
			adapter.send({
				location: {
					channelId: 'telegram',
					accountId: 'a',
					peer: {id: '1', kind: 'user'},
				},
				text: 't',
				idempotencyKey: 'k',
			}),
		).rejects.toThrow('before start');
	});

	it('refuses double-start', async () => {
		const {adapter} = makeAdapter();
		await start(adapter);
		await expect(start(adapter)).rejects.toThrow('already started');
		await adapter.stop('shutdown');
	});

	it('emits warn-level log when inbound listener throws', async () => {
		const {adapter, fake} = makeAdapter();
		const log = vi.fn<LogFn>();
		adapter.on('inbound', () => {
			throw new Error('listener boom');
		});
		await start(adapter, log);
		fake.queue(dmUpdate);
		await waitUntil(() =>
			log.mock.calls.some(c => c[0] === 'warn' && /listener threw/.test(c[1])),
		);
		await adapter.stop('shutdown');
	});
});

async function waitUntil(cond: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (cond()) return;
		await new Promise(r => setTimeout(r, 5));
	}
	throw new Error('timeout waiting for condition');
}
