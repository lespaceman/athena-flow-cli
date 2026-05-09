import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {runDashboardCommand} from './dashboardCommand';
import type {executeRemoteAssignment} from '../dashboard/remoteRunExecutor';
import type {DashboardClientConfig} from '../../infra/config/dashboardClient';

function captureLogs() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		logOut: (m: string) => out.push(m),
		logError: (m: string) => err.push(m),
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

const STATIC_FINGERPRINT = 'fp-static';

function makeDeps(overrides: {
	fetchMock?: ReturnType<typeof vi.fn>;
	stored?: DashboardClientConfig | null;
	written?: DashboardClientConfig[];
	removed?: {count: number};
	now?: number;
}) {
	const writes = overrides.written ?? [];
	const stored = {value: overrides.stored ?? null};
	const removed = overrides.removed ?? {count: 0};
	const cap = captureLogs();
	return {
		cap,
		writes,
		stored,
		removed,
		deps: {
			fetch: overrides.fetchMock as unknown as typeof fetch,
			now: () => overrides.now ?? 1_700_000_000_000,
			fingerprint: () => STATIC_FINGERPRINT,
			hostInfo: () => ({
				hostname: 'test-host',
				user: 'tester',
				name: 'test-host',
			}),
			packageVersion: '9.9.9-test',
			readConfig: () => stored.value,
			writeConfig: (c: DashboardClientConfig) => {
				stored.value = c;
				writes.push(c);
			},
			removeConfig: () => {
				stored.value = null;
				removed.count += 1;
			},
			startRuntimeDaemon: vi.fn(async () => ({
				ok: true,
				connected: true,
				message: 'connected',
			})),
			configPath: () => '/tmp/athena/dashboard.json',
			logOut: cap.logOut,
			logError: cap.logError,
		},
	};
}

describe('runDashboardCommand: usage', () => {
	it('prints usage on no subcommand', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runDashboardCommand(
			{subcommand: '', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('Usage: athena dashboard');
	});

	it('prints usage on help', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runDashboardCommand(
			{subcommand: 'help', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('Usage: athena dashboard');
	});

	it('rejects unknown subcommand', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runDashboardCommand(
			{subcommand: 'wat', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('Unknown dashboard subcommand');
	});
});

describe('runDashboardCommand: pair', () => {
	it('requires a pairing token', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runDashboardCommand(
			{
				subcommand: 'pair',
				subcommandArgs: [],
				flags: {url: 'http://localhost:5173'},
			},
			deps,
		);
		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('missing pairing token');
	});

	it('requires --url', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runDashboardCommand(
			{subcommand: 'pair', subcommandArgs: ['tok_1'], flags: {}},
			deps,
		);
		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('--url');
	});

	it('rejects malformed --url', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runDashboardCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'ws://nope'},
			},
			deps,
		);
		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('http:// or https://');
	});

	it('posts to /api/instances/pair with fingerprint, hostInfo, capabilities', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
				jti: 'jti_1',
			}),
		);
		const {deps, writes} = makeDeps({fetchMock});

		const code = await runDashboardCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173/app/instances'},
			},
			deps,
		);

		expect(code).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('http://localhost:5173/api/instances/pair');
		const reqBody = JSON.parse((init as RequestInit).body as string);
		expect(reqBody).toMatchObject({
			token: 'tok_1',
			fingerprint: STATIC_FINGERPRINT,
			hostInfo: {hostname: 'test-host'},
			capabilities: {
				instanceSocket: true,
				consoleAdapter: true,
				runtimeDaemon: true,
				version: '9.9.9-test',
			},
		});
		expect(writes).toHaveLength(1);
		expect(writes[0]).toEqual({
			dashboardUrl: 'http://localhost:5173',
			instanceId: 'inst_1',
			refreshToken: 'refresh_1',
			fingerprint: STATIC_FINGERPRINT,
			pairedAt: 1_700_000_000_000,
		});
	});

	it('starts the runtime daemon after pairing and reports bound runners', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
				runners: [
					{
						runnerId: 'runner_1',
						name: 'Nightly QA',
						executionTarget: 'remote',
						remoteInstanceId: 'inst_1',
					},
				],
			}),
		);
		const startRuntimeDaemon = vi.fn(async () => ({
			ok: true,
			alreadyRunning: false,
			connected: true,
			message: 'connected',
		}));
		const {deps, cap} = makeDeps({fetchMock});

		const code = await runDashboardCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			{...deps, startRuntimeDaemon},
		);

		expect(code).toBe(0);
		expect(startRuntimeDaemon).toHaveBeenCalledTimes(1);
		expect(cap.out.join('\n')).toContain('runtime daemon connected');
		expect(cap.out.join('\n')).toContain('bound runner Nightly QA (runner_1)');
	});

	it('does not log refresh token in human output', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'super-secret-refresh',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock});

		await runDashboardCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			deps,
		);

		const everything = [...cap.out, ...cap.err].join('\n');
		expect(everything).not.toContain('super-secret-refresh');
		expect(cap.out.join('\n')).toContain(
			'paired to http://localhost:5173 as inst_1',
		);
	});

	it('reports HTTP error and exits 1 without writing config', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(401, {error: 'invalid token'}));
		const {deps, cap, writes} = makeDeps({fetchMock});

		const code = await runDashboardCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['bad_token'],
				flags: {url: 'http://localhost:5173'},
			},
			deps,
		);

		expect(code).toBe(1);
		expect(writes).toHaveLength(0);
		expect(cap.err.join('\n')).toContain('401');
		expect(cap.err.join('\n')).toContain('invalid token');
	});

	it('rejects malformed pair response', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, {instanceId: 'i_1'}));
		const {deps, cap, writes} = makeDeps({fetchMock});

		const code = await runDashboardCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			deps,
		);

		expect(code).toBe(1);
		expect(writes).toHaveLength(0);
		expect(cap.err.join('\n')).toContain('invalid response');
	});

	it('emits structured JSON when --json is set', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock});

		await runDashboardCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173', json: true},
			},
			deps,
		);

		const parsed = JSON.parse(cap.out.join('\n'));
		expect(parsed).toMatchObject({
			ok: true,
			instanceId: 'inst_1',
			dashboardUrl: 'http://localhost:5173',
		});
		// JSON pair output must not contain the refresh token.
		expect(cap.out.join('\n')).not.toContain('refresh_1');
	});
});

describe('runDashboardCommand: refresh', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'old-refresh',
		fingerprint: 'fp-stored',
		pairedAt: 1,
	};

	it('errors when not paired', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runDashboardCommand(
			{subcommand: 'refresh', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('not paired');
	});

	it('delegates to refreshDashboardAccessToken and rotates stored refresh token', async () => {
		const performRefresh = vi.fn().mockImplementation(async () => {
			// The shared helper rotates the on-disk refresh token before
			// returning. Mirror that here so the JSON output sees the new value.
			return {
				instanceId: 'inst_1',
				accessToken: 'access-1',
				expiresInSec: 900,
			};
		});
		const {deps, writes, stored: storedRef} = makeDeps({stored, now: 5_000});
		// Pretend the helper rotated the on-disk value.
		const rotateStored = () => {
			storedRef.value = {...storedRef.value!, refreshToken: 'new-refresh'};
			writes.push(storedRef.value!);
		};
		const code = await runDashboardCommand(
			{subcommand: 'refresh', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: async label => {
					rotateStored();
					return performRefresh(label);
				},
			},
		);
		expect(code).toBe(0);
		expect(performRefresh).toHaveBeenCalledTimes(1);
		expect(performRefresh.mock.calls[0]![0]).toBe('refresh');
		expect(writes).toHaveLength(1);
		expect(writes[0]?.refreshToken).toBe('new-refresh');
	});

	it('does not print tokens in human output', async () => {
		const {deps, cap} = makeDeps({stored});
		await runDashboardCommand(
			{subcommand: 'refresh', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: async () => ({
					instanceId: 'inst_1',
					accessToken: 'super-access',
					expiresInSec: 900,
				}),
			},
		);
		const out = cap.out.join('\n');
		expect(out).not.toContain('super-access');
		expect(out).toContain('refreshed access token for instance inst_1');
	});

	it('emits access token and rotated refresh token only when --json is set', async () => {
		const {deps, cap, stored: storedRef} = makeDeps({stored});
		await runDashboardCommand(
			{subcommand: 'refresh', subcommandArgs: [], flags: {json: true}},
			{
				...deps,
				performRefresh: async () => {
					storedRef.value = {
						...storedRef.value!,
						refreshToken: 'new-refresh',
					};
					return {
						instanceId: 'inst_1',
						accessToken: 'access-1',
						expiresInSec: 900,
					};
				},
			},
		);
		const parsed = JSON.parse(cap.out.join('\n'));
		expect(parsed).toMatchObject({
			ok: true,
			instanceId: 'inst_1',
			accessToken: 'access-1',
			refreshToken: 'new-refresh',
			expiresInSec: 900,
		});
	});

	it('reports refresh errors and exits 1', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runDashboardCommand(
			{subcommand: 'refresh', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: async () => {
					throw new Error(
						'dashboard refresh: https://example.com returned 503',
					);
				},
			},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('503');
	});
});

describe('runDashboardCommand: status', () => {
	it('reports not paired', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runDashboardCommand(
			{subcommand: 'status', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(1);
		expect(cap.out.join('\n')).toContain('not paired');
	});

	it('prints instance id and origin without tokens', async () => {
		const stored: DashboardClientConfig = {
			dashboardUrl: 'https://example.com',
			instanceId: 'inst_1',
			refreshToken: 'do-not-print',
			fingerprint: 'fp-stored',
			pairedAt: 1,
		};
		const {deps, cap} = makeDeps({stored});

		const code = await runDashboardCommand(
			{subcommand: 'status', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain(
			'paired to https://example.com as inst_1',
		);
		expect(cap.out.join('\n')).not.toContain('do-not-print');
	});

	it('emits JSON without tokens', async () => {
		const stored: DashboardClientConfig = {
			dashboardUrl: 'https://example.com',
			instanceId: 'inst_1',
			refreshToken: 'do-not-print',
			fingerprint: 'fp-stored',
			pairedAt: 1,
			lastRefreshAt: 2,
		};
		const {deps, cap} = makeDeps({stored});

		await runDashboardCommand(
			{subcommand: 'status', subcommandArgs: [], flags: {json: true}},
			deps,
		);
		const parsed = JSON.parse(cap.out.join('\n'));
		expect(parsed).toMatchObject({
			ok: true,
			paired: true,
			instanceId: 'inst_1',
			dashboardUrl: 'https://example.com',
			lastRefreshAt: 2,
		});
		expect(cap.out.join('\n')).not.toContain('do-not-print');
	});
});

type FakeFrame =
	import('../dashboard/instanceSocketClient').InstanceSocketFrame;
type FakeRunEvent = {
	runId: string;
	seq: number;
	ts: number;
	kind: string;
	payload?: unknown;
};

function makeFakeSocket(connectFn?: () => Promise<void>) {
	const calls = {connect: 0, closed: [] as string[]};
	const closeHandlers: Array<(reason: string) => void> = [];
	const frameHandlers: Array<(frame: FakeFrame) => void> = [];
	const runEvents: FakeRunEvent[] = [];
	let lastOpts: {
		dashboardUrl: string;
		instanceId: string;
		accessToken: string;
	} | null = null;
	const factory = (o: {
		dashboardUrl: string;
		instanceId: string;
		accessToken: string;
	}) => {
		lastOpts = o;
		return {
			connect: async () => {
				calls.connect += 1;
				if (connectFn) await connectFn();
			},
			close: (reason?: string) => calls.closed.push(reason ?? ''),
			onFrame: (h: (f: FakeFrame) => void) => {
				frameHandlers.push(h);
			},
			onClose: (h: (reason: string) => void) => {
				closeHandlers.push(h);
			},
			sendRunEvent: (event: FakeRunEvent) => runEvents.push(event),
		};
	};
	return {
		factory,
		calls,
		runEvents,
		lastOpts: () => lastOpts,
		emitClose: (reason: string) => {
			for (const h of closeHandlers) h(reason);
		},
		emitFrame: (frame: FakeFrame) => {
			for (const h of frameHandlers) h(frame);
		},
	};
}

describe('runDashboardCommand: connect', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'old-refresh',
		fingerprint: 'fp-stored',
		pairedAt: 1,
	};

	const happyRefresh = async () => ({
		instanceId: 'inst_1',
		accessToken: 'fresh-access',
		expiresInSec: 900,
	});

	it('errors when not paired', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runDashboardCommand(
			{subcommand: 'connect', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('not paired');
	});

	it('refreshes an access token before opening the socket', async () => {
		const fakeSocket = makeFakeSocket();
		const {deps, cap} = makeDeps({stored});
		const code = await runDashboardCommand(
			{subcommand: 'connect', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: fakeSocket.factory,
				waitForShutdown: async () => 'SIGINT',
			},
		);

		expect(code).toBe(0);
		expect(fakeSocket.calls.connect).toBe(1);
		expect(fakeSocket.lastOpts()).toEqual({
			dashboardUrl: 'https://example.com',
			instanceId: 'inst_1',
			accessToken: 'fresh-access',
			log: expect.any(Function),
		});
		expect(cap.out.join('\n')).toContain('connected instance inst_1');
		expect(cap.out.join('\n')).toContain('disconnected (SIGINT)');
	});

	it('exits 1 when refresh fails and never opens socket', async () => {
		const fakeSocket = makeFakeSocket();
		const {deps} = makeDeps({stored});
		const code = await runDashboardCommand(
			{subcommand: 'connect', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: async () => {
					throw new Error('expired');
				},
				makeInstanceSocketClient: fakeSocket.factory,
				waitForShutdown: async () => 'SIGINT',
			},
		);
		expect(code).toBe(1);
		expect(fakeSocket.calls.connect).toBe(0);
	});

	it('exits 1 when the socket closes before the shutdown signal', async () => {
		const fakeSocket = makeFakeSocket();
		const {deps, cap} = makeDeps({stored});

		const pending = runDashboardCommand(
			{subcommand: 'connect', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: fakeSocket.factory,
				waitForShutdown: () => new Promise<string>(() => {}),
			},
		);
		// Yield until runDashboardCommand has subscribed to onClose.
		await new Promise(r => setTimeout(r, 0));
		await new Promise(r => setTimeout(r, 0));
		fakeSocket.emitClose('server gone');

		const code = await pending;
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('socket closed unexpectedly');
		expect(cap.err.join('\n')).toContain('server gone');
	});

	it('reports socket connect failure and exits 1', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runDashboardCommand(
			{subcommand: 'connect', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: () => ({
					connect: async () => {
						throw new Error('refused');
					},
					close: () => {},
					onFrame: () => {},
					onClose: () => {},
					sendRunEvent: () => {},
				}),
				waitForShutdown: async () => 'SIGINT',
			},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('refused');
	});
});

describe('runDashboardCommand: connect → executeRemoteAssignment', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'old-refresh',
		fingerprint: 'fp-stored',
		pairedAt: 1,
	};

	const happyRefresh = async () => ({
		instanceId: 'inst_1',
		accessToken: 'a',
		expiresInSec: 900,
	});

	it('routes job_assignment frames to the executor and de-dups runIds in flight', async () => {
		const fake = makeFakeSocket();
		const executor = vi.fn(async () => {});

		const {deps} = makeDeps({stored});
		const pending = runDashboardCommand(
			{subcommand: 'connect', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: fake.factory,
				executeRemoteAssignment:
					executor as unknown as typeof executeRemoteAssignment,
				waitForShutdown: async () => 'SIGINT',
			},
		);

		await new Promise(r => setTimeout(r, 0));
		const frame: FakeFrame = {
			type: 'job_assignment',
			runId: 'run_1',
			runSpec: {prompt: 'hi'},
		};
		fake.emitFrame(frame);
		fake.emitFrame(frame);

		await pending;
		expect(executor).toHaveBeenCalledTimes(1);
		expect(executor.mock.calls[0]![0]).toMatchObject({frame});
	});

	it('drains in-flight assignments before disconnecting', async () => {
		const fake = makeFakeSocket();
		let resolveExecutor: () => void = () => {};
		let signalStarted: () => void = () => {};
		const startedPromise = new Promise<void>(r => {
			signalStarted = r;
		});
		const executor = vi.fn(async () => {
			signalStarted();
			await new Promise<void>(r => {
				resolveExecutor = r;
			});
		});

		const {deps, cap} = makeDeps({stored});
		const pending = runDashboardCommand(
			{subcommand: 'connect', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: fake.factory,
				executeRemoteAssignment:
					executor as unknown as typeof executeRemoteAssignment,
				waitForShutdown: () =>
					startedPromise.then(() => {
						setTimeout(() => resolveExecutor(), 5);
						return 'SIGINT';
					}),
			},
		);

		await new Promise(r => setTimeout(r, 0));
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_drain',
			runSpec: {prompt: 'x'},
		});

		const code = await pending;
		expect(code).toBe(0);
		expect(executor).toHaveBeenCalledTimes(1);
		expect(cap.out.join('\n')).toContain('draining 1 in-flight run');
		expect(fake.calls.closed.length).toBe(1);
	});

	it('ignores non-assignment frames', async () => {
		const fake = makeFakeSocket();
		const executor = vi.fn(async () => {});
		const {deps} = makeDeps({stored});
		const pending = runDashboardCommand(
			{subcommand: 'connect', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: fake.factory,
				executeRemoteAssignment:
					executor as unknown as typeof executeRemoteAssignment,
				waitForShutdown: async () => 'SIGINT',
			},
		);
		await new Promise(r => setTimeout(r, 0));
		fake.emitFrame({type: 'ping', ts: 1});
		fake.emitFrame({type: 'cancel', runId: 'x'});
		await pending;
		expect(executor).not.toHaveBeenCalled();
	});
});

describe('runDashboardCommand: doctor', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'old-refresh',
		fingerprint: 'fp-stored',
		pairedAt: 100,
		lastRefreshAt: 200,
	};

	const happyRefresh = async () => ({
		instanceId: 'inst_1',
		accessToken: 'access-token',
		expiresInSec: 900,
	});

	it('errors when not paired', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runDashboardCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(1);
		expect(cap.out.join('\n')).toContain('not paired');
	});

	it('returns 0 when paired and no --runner is given', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runDashboardCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {}},
			{...deps, performRefresh: happyRefresh},
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('paired to https://example.com');
	});

	it('passes when runner reports executionTarget=remote and remoteInstanceId matches', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				id: 'r1',
				executionTarget: 'remote',
				remoteInstanceId: 'inst_1',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock, stored});
		const code = await runDashboardCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {runner: 'r1'}},
			{...deps, performRefresh: happyRefresh},
		);
		expect(code).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://example.com/api/runners/r1');
		expect((init as RequestInit).headers).toMatchObject({
			authorization: 'Bearer access-token',
		});
		expect(cap.out.join('\n')).toContain('runner r1 bound to this instance');
	});

	it('fails with a specific reason when remoteInstanceId mismatches', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				id: 'r1',
				executionTarget: 'remote',
				remoteInstanceId: 'inst_other',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock, stored});
		const code = await runDashboardCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {runner: 'r1'}},
			{...deps, performRefresh: happyRefresh},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('remoteInstanceId is "inst_other"');
	});

	it('fails with a specific reason when executionTarget is not remote', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				id: 'r1',
				executionTarget: 'local',
				remoteInstanceId: 'inst_1',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock, stored});
		const code = await runDashboardCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {runner: 'r1'}},
			{...deps, performRefresh: happyRefresh},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('executionTarget is "local"');
	});

	it('reports endpoint-missing on 404 from runner GET', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(404, {error: 'not found'}));
		const {deps, cap} = makeDeps({fetchMock, stored});
		const code = await runDashboardCommand(
			{subcommand: 'doctor', subcommandArgs: [], flags: {runner: 'r1'}},
			{...deps, performRefresh: happyRefresh},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('runner not found');
	});

	it('emits structured JSON when --json is set', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				executionTarget: 'remote',
				remoteInstanceId: 'inst_1',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock, stored});
		await runDashboardCommand(
			{
				subcommand: 'doctor',
				subcommandArgs: [],
				flags: {runner: 'r1', json: true},
			},
			{...deps, performRefresh: happyRefresh},
		);
		const parsed = JSON.parse(cap.out.join('\n'));
		expect(parsed).toMatchObject({
			ok: true,
			paired: true,
			instanceId: 'inst_1',
			dashboardUrl: 'https://example.com',
			runner: {id: 'r1', matches: true},
		});
	});
});

describe('runDashboardCommand: console link', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'http://localhost:3000',
		instanceId: 'inst_1',
		refreshToken: 'r',
		fingerprint: 'fp',
		pairedAt: 1,
	};

	function makeChannelDir() {
		return fs.mkdtempSync(path.join(os.tmpdir(), 'drisp-channels-'));
	}

	it('errors when not paired', async () => {
		const {deps, cap} = makeDeps({});
		const code = await runDashboardCommand(
			{subcommand: 'console', subcommandArgs: ['link', 'r1'], flags: {}},
			deps,
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('not paired');
	});

	it('rejects "console" without subcommand', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runDashboardCommand(
			{subcommand: 'console', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('unknown subcommand');
	});

	it('requires <runnerId>', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runDashboardCommand(
			{subcommand: 'console', subcommandArgs: ['link'], flags: {}},
			deps,
		);
		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('missing <runnerId>');
	});

	it('writes a console.json sidecar with ws broker_url for http dashboard', async () => {
		const dir = makeChannelDir();
		const {deps, cap} = makeDeps({stored});
		const reload = vi.fn().mockResolvedValue({ok: true, message: 'reloaded'});
		const code = await runDashboardCommand(
			{subcommand: 'console', subcommandArgs: ['link', 'r1'], flags: {}},
			{...deps, channelDir: () => dir, reloadGatewayChannels: reload},
		);
		expect(reload).toHaveBeenCalledTimes(1);
		expect(code).toBe(0);
		const target = path.join(dir, 'console.json');
		const content = JSON.parse(fs.readFileSync(target, 'utf-8'));
		expect(content).toEqual({
			broker_url: 'ws://localhost:3000/api/runners/r1/console/adapter',
			runner_id: 'r1',
			dashboard_config: true,
		});
		if (process.platform !== 'win32') {
			const mode = fs.statSync(target).mode & 0o777;
			expect(mode).toBe(0o600);
		}
		expect(cap.out.join('\n')).toContain('linked runner r1');
	});

	it('uses wss for https dashboard', async () => {
		const dir = makeChannelDir();
		const httpsStored = {...stored, dashboardUrl: 'https://app.drisp.dev'};
		const {deps} = makeDeps({stored: httpsStored});
		const code = await runDashboardCommand(
			{subcommand: 'console', subcommandArgs: ['link', 'r1'], flags: {}},
			{
				...deps,
				channelDir: () => dir,
				reloadGatewayChannels: async () => ({ok: true, message: 'reloaded'}),
			},
		);
		expect(code).toBe(0);
		const target = path.join(dir, 'console.json');
		const content = JSON.parse(fs.readFileSync(target, 'utf-8'));
		expect(content.broker_url).toBe(
			'wss://app.drisp.dev/api/runners/r1/console/adapter',
		);
	});

	it('replaces an existing sidecar and reports the previous broker_url', async () => {
		const dir = makeChannelDir();
		fs.writeFileSync(
			path.join(dir, 'console.json'),
			JSON.stringify({
				broker_url: 'ws://old.example/runners/old/console/adapter',
				runner_id: 'old',
				dashboard_config: true,
			}),
			{mode: 0o600},
		);
		const {deps, cap} = makeDeps({stored});
		const code = await runDashboardCommand(
			{subcommand: 'console', subcommandArgs: ['link', 'r1'], flags: {}},
			{
				...deps,
				channelDir: () => dir,
				reloadGatewayChannels: async () => ({ok: true, message: 'reloaded'}),
			},
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('replaced existing config');
		expect(cap.out.join('\n')).toContain('old.example');
	});
});

describe('runDashboardCommand: unpair', () => {
	it('removes config and is idempotent', async () => {
		const stored: DashboardClientConfig = {
			dashboardUrl: 'https://example.com',
			instanceId: 'inst_1',
			refreshToken: 'tok',
			fingerprint: 'fp',
			pairedAt: 1,
		};
		const {deps, cap, removed} = makeDeps({stored});

		const code = await runDashboardCommand(
			{subcommand: 'unpair', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(0);
		expect(removed.count).toBe(1);
		expect(cap.out.join('\n')).toContain('unpaired');
	});
});
