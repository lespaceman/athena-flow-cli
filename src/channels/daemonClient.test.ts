import {EventEmitter} from 'node:events';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {channelDaemonSocketPath} from './daemonPaths';
import {ChannelDaemonClient, clearChannelDaemonRegistry} from './daemonClient';
import type {ChannelDefinition, ChannelEventMessage} from './types';

class FakeSocket extends EventEmitter {
	writes: string[] = [];
	destroyed = false;
	write(chunk: string): void {
		this.writes.push(chunk);
	}
	end(): void {
		this.destroyed = true;
		this.emit('close');
	}
	destroy(): void {
		this.destroyed = true;
		this.emit('close');
	}
}

function makeDefinition(): ChannelDefinition {
	return {
		name: 'telegram',
		entryPath: '/dist/channel-telegram.js',
		daemonEntryPath: '/dist/channel-daemon.js',
		args: ['/dist/channel-telegram.js'],
		allowedUserIds: ['123'],
		options: {bot_token: 'secret', default_chat_id: '123'},
	};
}

describe('channelDaemonSocketPath', () => {
	it('uses the channel name under ~/.athena/run', () => {
		expect(channelDaemonSocketPath('telegram', '/home/user')).toBe(
			'/home/user/.athena/run/channel-telegram.sock',
		);
	});
});

describe('ChannelDaemonClient', () => {
	beforeEach(() => {
		clearChannelDaemonRegistry();
	});

	it('sends init with session_id after connecting', async () => {
		const socket = new FakeSocket();
		const client = new ChannelDaemonClient({
			definition: makeDefinition(),
			sessionId: 'session-a',
			handlers: {
				onEvent: vi.fn(),
				onExit: vi.fn(),
				onError: vi.fn(),
			},
			deps: {
				connect: vi.fn((_path, onConnect) => {
					queueMicrotask(onConnect);
					return socket;
				}),
				spawnDaemon: vi.fn(),
				socketPath: vi.fn(() => '/tmp/channel-telegram.sock'),
			},
		});

		await client.start();

		expect(JSON.parse(socket.writes[0]!)).toEqual({
			session_id: 'session-a',
			method: 'init',
			params: {
				allowed_user_ids: ['123'],
				options: {bot_token: 'secret', default_chat_id: '123'},
			},
		});
	});

	it('spawns the daemon and retries when initial attach fails', async () => {
		const first = new FakeSocket();
		const second = new FakeSocket();
		const spawnDaemon = vi.fn();
		let calls = 0;
		const client = new ChannelDaemonClient({
			definition: makeDefinition(),
			sessionId: 'session-a',
			handlers: {
				onEvent: vi.fn(),
				onExit: vi.fn(),
				onError: vi.fn(),
			},
			deps: {
				connect: vi.fn((_path, onConnect) => {
					calls++;
					if (calls === 1) {
						queueMicrotask(() =>
							first.emit(
								'error',
								Object.assign(new Error('missing'), {code: 'ENOENT'}),
							),
						);
						return first;
					}
					queueMicrotask(onConnect);
					return second;
				}),
				spawnDaemon,
				socketPath: vi.fn(() => '/tmp/channel-telegram.sock'),
			},
		});

		await client.start();

		expect(spawnDaemon).toHaveBeenCalledTimes(1);
		expect(second.writes).toHaveLength(1);
	});

	it('waits for a newly spawned daemon socket to start listening', async () => {
		const first = new FakeSocket();
		const second = new FakeSocket();
		const third = new FakeSocket();
		const spawnDaemon = vi.fn();
		let calls = 0;
		const client = new ChannelDaemonClient({
			definition: makeDefinition(),
			sessionId: 'session-a',
			handlers: {
				onEvent: vi.fn(),
				onExit: vi.fn(),
				onError: vi.fn(),
			},
			deps: {
				connect: vi.fn((_path, onConnect) => {
					calls++;
					if (calls === 1) {
						queueMicrotask(() =>
							first.emit(
								'error',
								Object.assign(new Error('missing'), {code: 'ENOENT'}),
							),
						);
						return first;
					}
					if (calls === 2) {
						queueMicrotask(() =>
							second.emit(
								'error',
								Object.assign(new Error('not ready'), {code: 'ECONNREFUSED'}),
							),
						);
						return second;
					}
					queueMicrotask(onConnect);
					return third;
				}),
				spawnDaemon,
				socketPath: vi.fn(() => '/tmp/channel-telegram.sock'),
				retryDelayMs: 0,
			},
		});

		await client.start();

		expect(spawnDaemon).toHaveBeenCalledTimes(1);
		expect(calls).toBe(3);
		expect(third.writes).toHaveLength(1);
	});

	it('routes parsed daemon events to handlers', async () => {
		const socket = new FakeSocket();
		const onEvent = vi.fn();
		const client = new ChannelDaemonClient({
			definition: makeDefinition(),
			sessionId: 'session-a',
			handlers: {
				onEvent,
				onExit: vi.fn(),
				onError: vi.fn(),
			},
			deps: {
				connect: vi.fn((_path, onConnect) => {
					queueMicrotask(onConnect);
					return socket;
				}),
				spawnDaemon: vi.fn(),
				socketPath: vi.fn(() => '/tmp/channel-telegram.sock'),
			},
		});
		await client.start();
		const event: ChannelEventMessage = {
			session_id: 'session-a',
			event: 'ready',
			params: {name: 'telegram', version: '1'},
		};

		socket.emit('data', JSON.stringify(event) + '\n');

		expect(onEvent).toHaveBeenCalledWith(event);
	});

	it('sends session-scoped shutdown on dispose', async () => {
		const socket = new FakeSocket();
		const client = new ChannelDaemonClient({
			definition: makeDefinition(),
			sessionId: 'session-a',
			handlers: {
				onEvent: vi.fn(),
				onExit: vi.fn(),
				onError: vi.fn(),
			},
			deps: {
				connect: vi.fn((_path, onConnect) => {
					queueMicrotask(onConnect);
					return socket;
				}),
				spawnDaemon: vi.fn(),
				socketPath: vi.fn(() => '/tmp/channel-telegram.sock'),
			},
		});
		await client.start();

		client.dispose();

		expect(JSON.parse(socket.writes.at(-1)!)).toEqual({
			session_id: 'session-a',
			method: 'shutdown',
			params: {},
		});
		expect(socket.destroyed).toBe(true);
	});
});

describe('clearChannelDaemonRegistry', () => {
	it('clears process-local daemon client bookkeeping', () => {
		expect(() => clearChannelDaemonRegistry()).not.toThrow();
	});
});
