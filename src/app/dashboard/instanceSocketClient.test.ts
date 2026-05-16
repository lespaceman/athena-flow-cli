import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	WebSocketServer,
	type WebSocket as ServerWebSocket,
	type WebSocket as WS,
} from 'ws';
import {
	createInstanceSocketClient,
	instanceSocketUrl,
} from './instanceSocketClient';

describe('instanceSocketUrl', () => {
	it('upgrades https to wss', () => {
		expect(instanceSocketUrl('https://example.com', 'inst_1')).toBe(
			'wss://example.com/api/instances/inst_1/socket',
		);
	});

	it('upgrades http to ws and preserves port', () => {
		expect(instanceSocketUrl('http://localhost:5173', 'inst_1')).toBe(
			'ws://localhost:5173/api/instances/inst_1/socket',
		);
	});

	it('drops trailing path, query, and hash from dashboard url', () => {
		expect(
			instanceSocketUrl('https://example.com/app?x=1#frag', 'inst_2'),
		).toBe('wss://example.com/api/instances/inst_2/socket');
	});

	it('encodes instance ids with special chars', () => {
		expect(instanceSocketUrl('https://example.com', 'inst/1')).toBe(
			'wss://example.com/api/instances/inst%2F1/socket',
		);
	});
});

describe('createInstanceSocketClient', () => {
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

	it('connects and sends ping frames on the heartbeat interval', async () => {
		const received: unknown[] = [];
		server.once('connection', ws => {
			ws.on('message', data => {
				received.push(JSON.parse(String(data)));
			});
		});

		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 10,
			now: () => 42,
		});
		await client.connect();

		await vi.waitFor(
			() => {
				expect(received.length).toBeGreaterThanOrEqual(2);
			},
			{timeout: 1_000},
		);

		client.close('done');
		expect(received[0]).toEqual({type: 'ping', ts: 42});
		expect(received[1]).toEqual({type: 'ping', ts: 42});
	});

	it('sends the access token via Sec-WebSocket-Protocol (browser-compatible auth)', async () => {
		let proto: string | string[] | undefined;
		let auth: string | string[] | undefined;
		// Echo the requested subprotocol so the handshake completes (the dashboard
		// instance-socket extractor enforces this contract too).
		server.options.handleProtocols = (
			protocols: Set<string>,
		): string | false => {
			const first = [...protocols][0];
			return first ?? false;
		};
		server.once('connection', (_ws, req) => {
			proto = req.headers['sec-websocket-protocol'];
			auth = req.headers['authorization'];
		});

		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'super-access-token',
			heartbeatIntervalMs: 60_000,
		});
		await client.connect();
		await vi.waitFor(() => expect(proto).toBeDefined(), {timeout: 1_000});
		expect(proto).toBe('super-access-token');
		expect(auth).toBeUndefined();
		client.close('done');
	});

	it('rejects connect when neither open nor error fires within connectTimeoutMs', async () => {
		const {EventEmitter} = await import('node:events');
		// Fake WebSocket that never emits open or error and tolerates terminate().
		const fakeWs = new EventEmitter() as EventEmitter & {
			terminate: () => void;
			readyState: number;
			OPEN: number;
		};
		fakeWs.terminate = () => {};
		fakeWs.readyState = 0;
		fakeWs.OPEN = 1;

		const client = createInstanceSocketClient({
			dashboardUrl: 'http://127.0.0.1:1',
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
			connectTimeoutMs: 80,
			makeWebSocket: () => fakeWs as unknown as WS,
		});
		await expect(client.connect()).rejects.toThrow(/timed out after 80ms/);
	});

	it('acks job_assignment with assignment_accepted', async () => {
		const received: unknown[] = [];
		server.once('connection', ws => {
			ws.on('message', data => {
				received.push(JSON.parse(String(data)));
			});
			setTimeout(() => {
				ws.send(
					JSON.stringify({
						type: 'job_assignment',
						runId: 'run_42',
						runSpec: {goal: 'noop'},
					}),
				);
			}, 5);
		});

		const seenFrames: unknown[] = [];
		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
		});
		client.onFrame(frame => seenFrames.push(frame));
		await client.connect();

		await vi.waitFor(
			() => {
				expect(
					received.some(
						r =>
							typeof r === 'object' &&
							r !== null &&
							(r as {type?: string}).type === 'assignment_accepted',
					),
				).toBe(true);
			},
			{timeout: 1_000},
		);

		const ack = received.find(
			r =>
				typeof r === 'object' &&
				r !== null &&
				(r as {type?: string}).type === 'assignment_accepted',
		) as {runId: string};
		expect(ack.runId).toBe('run_42');
		expect(seenFrames).toContainEqual(
			expect.objectContaining({type: 'job_assignment', runId: 'run_42'}),
		);
		client.close('done');
	});

	it('emits close handler when the server terminates the socket', async () => {
		server.once('connection', ws => {
			setTimeout(() => ws.close(1011, 'server gone'), 5);
		});

		const closes: string[] = [];
		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
		});
		client.onClose(reason => closes.push(reason));
		await client.connect();

		await vi.waitFor(
			() => {
				expect(closes.length).toBeGreaterThan(0);
			},
			{timeout: 1_000},
		);
		expect(closes[0]).toContain('server gone');
	});

	it('sendRunEvent writes a run_event frame to the wire', async () => {
		const received: unknown[] = [];
		server.once('connection', ws => {
			ws.on('message', data => {
				received.push(JSON.parse(String(data)));
			});
		});

		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
		});
		await client.connect();
		client.sendRunEvent({
			runId: 'run_42',
			seq: 1,
			ts: 1234,
			kind: 'progress',
			payload: {message: 'hi'},
		});
		await vi.waitFor(
			() => {
				expect(
					received.some(
						r =>
							typeof r === 'object' &&
							r !== null &&
							(r as {type?: string}).type === 'run_event',
					),
				).toBe(true);
			},
			{timeout: 1_000},
		);
		const frame = received.find(
			r =>
				typeof r === 'object' &&
				r !== null &&
				(r as {type?: string}).type === 'run_event',
		);
		expect(frame).toEqual({
			type: 'run_event',
			runId: 'run_42',
			seq: 1,
			ts: 1234,
			kind: 'progress',
			payload: {message: 'hi'},
		});
		client.close('done');
	});

	it('sendDecisionAck writes a decision_ack frame to the wire', async () => {
		const received: unknown[] = [];
		server.once('connection', ws => {
			ws.on('message', data => {
				received.push(JSON.parse(String(data)));
			});
		});
		const client = createInstanceSocketClient({
			dashboardUrl: `http://127.0.0.1:${port}`,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
		});
		await client.connect();

		client.sendDecisionAck({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
		});

		await vi.waitFor(
			() => {
				expect(
					received.some(
						r =>
							typeof r === 'object' &&
							r !== null &&
							(r as {type?: string}).type === 'decision_ack',
					),
				).toBe(true);
			},
			{timeout: 1_000},
		);
		expect(
			received.find(
				r =>
					typeof r === 'object' &&
					r !== null &&
					(r as {type?: string}).type === 'decision_ack',
			),
		).toEqual({
			type: 'decision_ack',
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
		});
		client.close('done');
	});

	it('rejects connect when ws emits error before open', async () => {
		const client = createInstanceSocketClient({
			dashboardUrl: 'http://127.0.0.1:1', // unused port
			instanceId: 'inst_1',
			accessToken: 'access-1',
			heartbeatIntervalMs: 60_000,
		});
		await expect(client.connect()).rejects.toThrow(
			/instance socket connect failed/,
		);
	});
});
