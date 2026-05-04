import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {WebSocketServer, type WebSocket as ServerWebSocket} from 'ws';
import {createConsoleBrokerClient} from './client';
import type {AthenaConsoleFrame} from '../../../shared/gateway-protocol';

async function makeReadyServer(): Promise<{
	server: WebSocketServer;
	port: number;
	acceptCount: () => number;
	close: () => Promise<void>;
}> {
	const server = new WebSocketServer({port: 0, host: '127.0.0.1'});
	await new Promise<void>(resolve => server.once('listening', () => resolve()));
	let count = 0;
	server.on('connection', ws => {
		count++;
		ws.on('message', () => {
			ws.send(
				JSON.stringify({
					kind: 'console.ready',
					frameId: 'r',
					sentAt: 0,
					protocolVersion: 1,
					brokerName: 'b',
					address: {runnerId: 'r1'},
				}),
			);
		});
	});
	const port = (server.address() as {port: number}).port;
	return {
		server,
		port,
		acceptCount: () => count,
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	};
}

describe('ConsoleBrokerClient', () => {
	let server: WebSocketServer;
	let port: number;
	let serverSockets: ServerWebSocket[] = [];

	beforeEach(async () => {
		server = new WebSocketServer({port: 0, host: '127.0.0.1'});
		await new Promise<void>(resolve =>
			server.once('listening', () => resolve()),
		);
		const addr = server.address();
		if (typeof addr !== 'object' || addr === null) throw new Error('no addr');
		port = addr.port;
		serverSockets = [];
		server.on('connection', ws => {
			serverSockets.push(ws);
		});
	});

	afterEach(async () => {
		for (const ws of serverSockets) ws.terminate();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	const url = (): string => `ws://127.0.0.1:${port}/adapter`;

	function makeClient() {
		return createConsoleBrokerClient({
			brokerUrl: url(),
			pairingToken: 'tok-abc',
			log: () => {},
		});
	}

	it('completes hello/ready handshake and surfaces ready address', async () => {
		const client = makeClient();
		const helloFrames: AthenaConsoleFrame[] = [];
		server.once('connection', ws => {
			ws.on('message', data => {
				const frame = JSON.parse(String(data)) as AthenaConsoleFrame;
				helloFrames.push(frame);
				if (frame.kind === 'console.hello') {
					const ready: AthenaConsoleFrame = {
						kind: 'console.ready',
						frameId: 'ready-1',
						sentAt: Date.now(),
						protocolVersion: 1,
						brokerName: 'fake-broker',
						address: {runnerId: 'r1'},
					};
					ws.send(JSON.stringify(ready));
				}
			});
		});

		await client.connect({
			runnerId: 'r1',
			workspaceId: 'ws1',
			clientName: 'athena-cli',
			clientVersion: '0.0.0-test',
		});

		expect(helloFrames).toHaveLength(1);
		const helloFrame = helloFrames[0]!;
		expect(helloFrame.kind).toBe('console.hello');
		if (helloFrame.kind !== 'console.hello') throw new Error('wrong kind');
		expect(helloFrame.address.runnerId).toBe('r1');
		expect(helloFrame.address.workspaceId).toBe('ws1');
		expect(client.getReadyAddress()?.runnerId).toBe('r1');
		client.close('done');
	});

	it('rejects when ready.address.runnerId does not match the claimed runner', async () => {
		const client = makeClient();
		server.once('connection', ws => {
			ws.on('message', () => {
				ws.send(
					JSON.stringify({
						kind: 'console.ready',
						frameId: 'r',
						sentAt: 0,
						protocolVersion: 1,
						brokerName: 'b',
						address: {runnerId: 'wrong-runner'},
					}),
				);
			});
		});
		await expect(
			client.connect({
				runnerId: 'r1',
				clientName: 'athena-cli',
				clientVersion: 'x',
			}),
		).rejects.toThrow(/runnerId mismatch/);
	});

	it('sends pairing token via Authorization header (never URL)', async () => {
		const client = makeClient();
		const headerSeen: string[] = [];
		server.once('connection', (ws, req) => {
			const auth = req.headers['authorization'];
			if (typeof auth === 'string') headerSeen.push(auth);
			ws.on('message', () => {
				ws.send(
					JSON.stringify({
						kind: 'console.ready',
						frameId: 'r',
						sentAt: 0,
						protocolVersion: 1,
						brokerName: 'b',
						address: {runnerId: 'r1'},
					}),
				);
			});
		});

		await client.connect({
			runnerId: 'r1',
			clientName: 'athena-cli',
			clientVersion: 'x',
		});
		expect(headerSeen).toEqual(['Bearer tok-abc']);
		client.close('done');
	});

	it('rejects when broker sends console.error during handshake', async () => {
		const client = makeClient();
		server.once('connection', ws => {
			ws.on('message', () => {
				ws.send(
					JSON.stringify({
						kind: 'console.error',
						frameId: 'e',
						sentAt: 0,
						code: 'unauthorized',
						message: 'bad token',
					}),
				);
			});
		});

		await expect(
			client.connect({
				runnerId: 'r1',
				clientName: 'athena-cli',
				clientVersion: 'x',
			}),
		).rejects.toThrow(/unauthorized/);
	});

	it('rejects when broker closes before sending ready', async () => {
		const client = makeClient();
		server.once('connection', ws => {
			ws.on('message', () => ws.close());
		});

		await expect(
			client.connect({
				runnerId: 'r1',
				clientName: 'athena-cli',
				clientVersion: 'x',
			}),
		).rejects.toThrow(/closed/);
	});

	it('rejects when broker accepts the socket but never sends ready', async () => {
		const client = createConsoleBrokerClient({
			brokerUrl: url(),
			pairingToken: 'tok',
			log: () => {},
			connectTimeoutMs: 80,
		});
		// Server stays connected, swallows the hello, never replies.
		server.once('connection', ws => {
			ws.on('message', () => {});
		});

		await expect(
			client.connect({
				runnerId: 'r1',
				clientName: 'athena-cli',
				clientVersion: 'x',
			}),
		).rejects.toThrow(/timed out/);
	});

	it('redacts the pairing token from thrown errors', async () => {
		const client = createConsoleBrokerClient({
			brokerUrl: 'ws://127.0.0.1:1/adapter', // unreachable
			pairingToken: 'super-secret-token',
			log: () => {},
			connectTimeoutMs: 50,
		});
		try {
			await client.connect({
				runnerId: 'r1',
				clientName: 'athena-cli',
				clientVersion: 'x',
			});
			throw new Error('expected connect to fail');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).not.toContain('super-secret-token');
		}
	});

	it('emits onReady on initial handshake', async () => {
		const client = makeClient();
		const readyAddrs: Array<{runnerId: string}> = [];
		client.onReady(addr => readyAddrs.push(addr));
		server.once('connection', ws => {
			ws.on('message', () => {
				ws.send(
					JSON.stringify({
						kind: 'console.ready',
						frameId: 'r',
						sentAt: 0,
						protocolVersion: 1,
						brokerName: 'b',
						address: {runnerId: 'r1'},
					}),
				);
			});
		});
		await client.connect({
			runnerId: 'r1',
			clientName: 'athena-cli',
			clientVersion: 'x',
		});
		expect(readyAddrs).toHaveLength(1);
		expect(readyAddrs[0]!.runnerId).toBe('r1');
		client.close('done');
	});

	it('emits inbound frames to the registered handler', async () => {
		const client = makeClient();
		const received: AthenaConsoleFrame[] = [];
		client.onFrame(frame => received.push(frame));
		server.once('connection', ws => {
			ws.on('message', () => {
				ws.send(
					JSON.stringify({
						kind: 'console.ready',
						frameId: 'r',
						sentAt: 0,
						protocolVersion: 1,
						brokerName: 'b',
						address: {runnerId: 'r1'},
					}),
				);
				setTimeout(() => {
					ws.send(
						JSON.stringify({
							kind: 'console.message.in',
							frameId: 'm1',
							sentAt: Date.now(),
							address: {runnerId: 'r1'},
							messageId: 'm1',
							idempotencyKey: 'console:r1:m1',
							text: 'hi',
						}),
					);
				}, 5);
			});
		});

		await client.connect({
			runnerId: 'r1',
			clientName: 'athena-cli',
			clientVersion: 'x',
		});

		await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), {
			timeout: 500,
		});
		expect(received[0]!.kind).toBe('console.message.in');
		client.close('done');
	});
});

describe('ConsoleBrokerClient — reconnect', () => {
	let handle: Awaited<ReturnType<typeof makeReadyServer>>;

	beforeEach(async () => {
		handle = await makeReadyServer();
	});

	afterEach(async () => {
		await handle.close();
	});

	it('reconnects after server-initiated close (post-ready)', async () => {
		const client = createConsoleBrokerClient({
			brokerUrl: `ws://127.0.0.1:${handle.port}/adapter`,
			pairingToken: 'tok',
			log: () => {},
			reconnect: {initialDelayMs: 5, maxDelayMs: 50},
		});

		const closes: string[] = [];
		client.onClose(reason => closes.push(reason));

		await client.connect({
			runnerId: 'r1',
			clientName: 'athena-cli',
			clientVersion: 'x',
		});
		expect(handle.acceptCount()).toBe(1);

		// kill the only server-side socket; client should reconnect
		for (const ws of handle.server.clients) ws.terminate();

		await vi.waitFor(
			() => expect(handle.acceptCount()).toBeGreaterThanOrEqual(2),
			{
				timeout: 1000,
			},
		);
		await vi.waitFor(() => expect(client.isReady()).toBe(true), {
			timeout: 1000,
		});
		client.close('done');
	});

	it('emits onReady after each reconnect', async () => {
		const client = createConsoleBrokerClient({
			brokerUrl: `ws://127.0.0.1:${handle.port}/adapter`,
			pairingToken: 'tok',
			log: () => {},
			reconnect: {initialDelayMs: 5, maxDelayMs: 50},
		});
		const readyEvents: number[] = [];
		client.onReady(() => readyEvents.push(Date.now()));
		await client.connect({
			runnerId: 'r1',
			clientName: 'athena-cli',
			clientVersion: 'x',
		});
		expect(readyEvents).toHaveLength(1);
		for (const ws of handle.server.clients) ws.terminate();
		await vi.waitFor(
			() => expect(readyEvents.length).toBeGreaterThanOrEqual(2),
			{
				timeout: 1000,
			},
		);
		client.close('done');
	});

	it('stops reconnecting after explicit close()', async () => {
		const client = createConsoleBrokerClient({
			brokerUrl: `ws://127.0.0.1:${handle.port}/adapter`,
			pairingToken: 'tok',
			log: () => {},
			reconnect: {initialDelayMs: 5, maxDelayMs: 50},
		});
		await client.connect({
			runnerId: 'r1',
			clientName: 'athena-cli',
			clientVersion: 'x',
		});
		client.close('done');
		await new Promise(r => setTimeout(r, 100));
		expect(handle.acceptCount()).toBe(1);
	});
});
