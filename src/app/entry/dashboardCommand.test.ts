import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
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
const tmpDirs: string[] = [];
const originalXdgStateHome = process.env['XDG_STATE_HOME'];

afterEach(() => {
	if (originalXdgStateHome === undefined) {
		delete process.env['XDG_STATE_HOME'];
	} else {
		process.env['XDG_STATE_HOME'] = originalXdgStateHome;
	}
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

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
	// Per-test isolated channel dir so reconciler runs don't touch the
	// user's ~/.config/athena/channels. Mocked reloadGatewayChannels keeps
	// pair tests off the real UDS socket.
	const channelDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
	const stateDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-state-'));
	tmpDirs.push(channelDirPath, stateDirPath);
	process.env['XDG_STATE_HOME'] = stateDirPath;
	return {
		cap,
		writes,
		stored,
		removed,
		channelDirPath,
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
			removeMirror: vi.fn(),
			startRuntimeDaemon: vi.fn(async () => ({
				ok: true,
				connected: true,
				message: 'connected',
			})),
			configPath: () => '/tmp/athena/dashboard.json',
			channelDir: () => channelDirPath,
			reloadGatewayChannels: vi.fn(async () => ({
				ok: true,
				message: 'reloaded (test mock)',
			})),
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

	it('reconciles per-runner console sidecars and reloads the gateway after pairing', async () => {
		const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-side-'));
		try {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse(200, {
					instanceId: 'inst_1',
					refreshToken: 'refresh_1',
					runners: [
						{runnerId: 'r1', name: 'one'},
						{runnerId: 'r2', name: 'two'},
					],
				}),
			);
			// Stale dashboard-managed sidecar for a runner no longer attached.
			fs.writeFileSync(
				path.join(channelDir, 'console-rOld.json'),
				JSON.stringify({
					kind: 'console',
					instance_id: 'console:rOld',
					broker_url: 'wss://old',
					runner_id: 'rOld',
					dashboard_config: true,
				}),
			);
			const reloadGatewayChannels = vi.fn(async () => ({
				ok: true,
				message: 'reloaded',
			}));
			const {deps} = makeDeps({fetchMock});

			const code = await runDashboardCommand(
				{
					subcommand: 'pair',
					subcommandArgs: ['tok_1'],
					flags: {url: 'http://localhost:5173'},
				},
				{...deps, channelDir: () => channelDir, reloadGatewayChannels},
			);

			expect(code).toBe(0);
			expect(fs.existsSync(path.join(channelDir, 'console-r1.json'))).toBe(
				true,
			);
			expect(fs.existsSync(path.join(channelDir, 'console-r2.json'))).toBe(
				true,
			);
			expect(fs.existsSync(path.join(channelDir, 'console-rOld.json'))).toBe(
				false,
			);
			expect(reloadGatewayChannels).toHaveBeenCalledTimes(1);
		} finally {
			fs.rmSync(channelDir, {recursive: true, force: true});
		}
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

	it('exits 0 with a warning when daemon spawn fails', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
			}),
		);
		const {deps, cap, writes} = makeDeps({fetchMock});
		const startRuntimeDaemon = vi.fn(async () => ({
			ok: false,
			message: 'spawn ENOENT',
		}));

		const code = await runDashboardCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			{...deps, startRuntimeDaemon},
		);

		// Daemon failure is a warning, not a pair failure — pairing on disk is
		// the source of truth.
		expect(code).toBe(0);
		expect(writes).toHaveLength(1);
		expect(cap.err.join('\n')).toContain('runtime daemon did not start');
		expect(cap.out.join('\n')).toContain('pairing succeeded; start the daemon');
	});

	it('exits 1 when the dashboard requires a newer cli', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
				requiredCliVersion: '99.0.0',
			}),
		);
		const {deps, cap, writes} = makeDeps({fetchMock});
		const startRuntimeDaemon = vi.fn();

		const code = await runDashboardCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			{...deps, startRuntimeDaemon},
		);

		expect(code).toBe(1);
		// Refusing the pair before writing config or starting the daemon avoids
		// leaving the user with a half-broken setup.
		expect(writes).toHaveLength(0);
		expect(startRuntimeDaemon).not.toHaveBeenCalled();
		expect(cap.err.join('\n')).toContain("older than the dashboard's required");
	});

	it('reports verified socket from defaultStartRuntimeDaemon probe result', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
			}),
		);
		const {deps, cap} = makeDeps({fetchMock});
		const startRuntimeDaemon = vi.fn(
			async (opts: {log: (msg: string) => void}) => {
				opts.log('daemon: socket verified (pid 4123)');
				return {
					ok: true,
					connected: true,
					pid: 4123,
					message: 'started, socket verified',
				};
			},
		);

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
		expect(cap.out.join('\n')).toContain(
			'runtime daemon connected (verified socket open)',
		);
		expect(cap.out.join('\n')).toContain('socket verified (pid 4123)');
	});

	it('sends both cliVersion and legacy version capability fields', async () => {
		let capturedBody: unknown = null;
		const fetchMock = vi.fn(async (_url: string, init?: {body?: string}) => {
			if (init?.body) capturedBody = JSON.parse(init.body);
			return jsonResponse(200, {
				instanceId: 'inst_1',
				refreshToken: 'refresh_1',
			});
		});
		const {deps} = makeDeps({
			fetchMock: fetchMock as unknown as ReturnType<typeof vi.fn>,
		});

		await runDashboardCommand(
			{
				subcommand: 'pair',
				subcommandArgs: ['tok_1'],
				flags: {url: 'http://localhost:5173'},
			},
			deps,
		);

		expect(capturedBody).toMatchObject({
			capabilities: {
				cliVersion: '9.9.9-test',
				version: '9.9.9-test',
				runtimeDaemon: true,
			},
		});
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

	it('prints pairing, daemon-down, and exits non-zero', async () => {
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
			{
				...deps,
				queryRuntimeDaemon: async () => ({
					ok: false,
					error: 'daemon not running',
				}),
			},
		);
		// Paired but daemon down → unhealthy axis → exit 1.
		expect(code).toBe(1);
		expect(cap.out.join('\n')).toContain(
			'paired to https://example.com as inst_1',
		);
		expect(cap.out.join('\n')).toContain('NOT running');
		expect(cap.out.join('\n')).not.toContain('do-not-print');
	});

	it('reports a healthy daemon and exits 0', async () => {
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
			{
				...deps,
				queryRuntimeDaemon: async () => ({
					ok: true,
					cmd: 'status',
					pid: 4123,
					startedAt: Date.now() - 2_000,
					socketConnected: true,
					activeRuns: 0,
					completedRuns: 2,
					instanceId: 'inst_1',
					dashboardUrl: 'https://example.com',
				}),
			},
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toMatch(/daemon:\s+running \(pid 4123/);
		expect(cap.out.join('\n')).toContain('socket:    connected');
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
			{
				...deps,
				queryRuntimeDaemon: async () => ({
					ok: true,
					cmd: 'status',
					pid: 1,
					startedAt: 0,
					socketConnected: true,
					activeRuns: 0,
					completedRuns: 0,
				}),
			},
		);
		const parsed = JSON.parse(cap.out.join('\n'));
		expect(parsed).toMatchObject({
			ok: true,
			paired: true,
			instanceId: 'inst_1',
			dashboardUrl: 'https://example.com',
			lastRefreshAt: 2,
			daemon: {running: true, pid: 1, socketConnected: true},
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
			sendFeedEvent: () => {},
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

describe('runDashboardCommand: connect (deprecation alias)', () => {
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

	it('prints a deprecation warning and routes to daemon foreground', async () => {
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
		expect(cap.err.join('\n')).toContain(
			'connect: deprecated; use `dashboard daemon foreground`',
		);
		expect(cap.out.join('\n')).toContain('foreground runtime connected');
		expect(cap.out.join('\n')).toContain('stopped (SIGINT)');
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
					sendFeedEvent: () => {},
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

	it('aborts in-flight assignments on stop', async () => {
		const fake = makeFakeSocket();
		let signalStarted: () => void = () => {};
		const startedPromise = new Promise<void>(r => {
			signalStarted = r;
		});
		let seenSignal: AbortSignal | undefined;
		const executor = vi.fn(async (input: {abortSignal?: AbortSignal}) => {
			seenSignal = input.abortSignal;
			signalStarted();
			await new Promise<void>(resolve => {
				input.abortSignal?.addEventListener('abort', () => resolve());
			});
		});

		const {deps} = makeDeps({stored});
		const pending = runDashboardCommand(
			{subcommand: 'connect', subcommandArgs: [], flags: {}},
			{
				...deps,
				performRefresh: happyRefresh,
				makeInstanceSocketClient: fake.factory,
				executeRemoteAssignment:
					executor as unknown as typeof executeRemoteAssignment,
				waitForShutdown: () => startedPromise.then(() => 'SIGINT'),
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
		expect(seenSignal?.aborted).toBe(true);
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

	it('writes a per-runner sidecar with kind/instance_id and ws broker_url for http dashboard', async () => {
		const dir = makeChannelDir();
		const {deps, cap} = makeDeps({stored});
		const reload = vi.fn().mockResolvedValue({ok: true, message: 'reloaded'});
		const code = await runDashboardCommand(
			{subcommand: 'console', subcommandArgs: ['link', 'r1'], flags: {}},
			{...deps, channelDir: () => dir, reloadGatewayChannels: reload},
		);
		expect(reload).toHaveBeenCalledTimes(1);
		expect(code).toBe(0);
		const target = path.join(dir, 'console-r1.json');
		const content = JSON.parse(fs.readFileSync(target, 'utf-8'));
		expect(content).toEqual({
			kind: 'console',
			instance_id: 'console:r1',
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
		const target = path.join(dir, 'console-r1.json');
		const content = JSON.parse(fs.readFileSync(target, 'utf-8'));
		expect(content.broker_url).toBe(
			'wss://app.drisp.dev/api/runners/r1/console/adapter',
		);
	});

	it('replaces an existing per-runner sidecar and reports the previous broker_url', async () => {
		const dir = makeChannelDir();
		fs.writeFileSync(
			path.join(dir, 'console-r1.json'),
			JSON.stringify({
				kind: 'console',
				instance_id: 'console:r1',
				broker_url: 'ws://old.example/runners/r1/console/adapter',
				runner_id: 'r1',
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

	it('migrates legacy console.json pointing at the same runner', async () => {
		const dir = makeChannelDir();
		const legacy = path.join(dir, 'console.json');
		fs.writeFileSync(
			legacy,
			JSON.stringify({
				broker_url: 'ws://legacy.example/runners/r1/console/adapter',
				runner_id: 'r1',
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
		expect(fs.existsSync(legacy)).toBe(false);
		expect(fs.existsSync(path.join(dir, 'console-r1.json'))).toBe(true);
		expect(cap.out.join('\n')).toContain('replaced existing config');
		expect(cap.out.join('\n')).toContain('legacy.example');
	});

	it('preserves legacy console.json bound to a different runner', async () => {
		const dir = makeChannelDir();
		const legacy = path.join(dir, 'console.json');
		fs.writeFileSync(
			legacy,
			JSON.stringify({
				broker_url: 'ws://other.example/runners/other/console/adapter',
				runner_id: 'other',
				dashboard_config: true,
			}),
			{mode: 0o600},
		);
		const {deps} = makeDeps({stored});
		const code = await runDashboardCommand(
			{subcommand: 'console', subcommandArgs: ['link', 'r1'], flags: {}},
			{
				...deps,
				channelDir: () => dir,
				reloadGatewayChannels: async () => ({ok: true, message: 'reloaded'}),
			},
		);
		expect(code).toBe(0);
		expect(fs.existsSync(legacy)).toBe(true);
		expect(fs.existsSync(path.join(dir, 'console-r1.json'))).toBe(true);
	});
});

describe('runDashboardCommand: unpair', () => {
	const storedConfig: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'tok',
		fingerprint: 'fp',
		pairedAt: 1,
	};

	it('reports nothing-to-do when not paired', async () => {
		const {deps, cap, removed} = makeDeps({});
		const code = await runDashboardCommand(
			{subcommand: 'unpair', subcommandArgs: [], flags: {}},
			deps,
		);
		expect(code).toBe(0);
		expect(removed.count).toBe(0);
		expect(cap.out.join('\n')).toContain('not paired');
	});

	it('stops the daemon, revokes server-side, and removes config', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({}),
			text: async () => '',
		});
		const {deps, cap, removed} = makeDeps({
			stored: storedConfig,
			fetchMock: fetchMock as unknown as ReturnType<typeof vi.fn>,
		});
		const stopRuntimeDaemon = vi.fn(async () => ({
			ok: true,
			wasRunning: true,
		}));
		const performRefresh = vi.fn(async () => ({
			instanceId: 'inst_1',
			accessToken: 'tok-access',
			expiresInSec: 900,
		}));

		const code = await runDashboardCommand(
			{subcommand: 'unpair', subcommandArgs: [], flags: {}},
			{...deps, stopRuntimeDaemon, performRefresh},
		);
		expect(code).toBe(0);
		expect(stopRuntimeDaemon).toHaveBeenCalledTimes(1);
		expect(removed.count).toBe(1);
		// Revoke endpoint hit with the correct instance id.
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/instances/inst_1/revoke'),
			expect.objectContaining({method: 'POST'}),
		);
		expect(cap.out.join('\n')).toContain('runtime daemon stopped');
		expect(cap.out.join('\n')).toContain('refresh token revoked');
		expect(cap.out.join('\n')).toContain('credentials removed');
	});

	it('warns and still removes config when revoke fails', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
		const {deps, cap, removed} = makeDeps({
			stored: storedConfig,
			fetchMock: fetchMock as unknown as ReturnType<typeof vi.fn>,
		});
		const stopRuntimeDaemon = vi.fn(async () => ({
			ok: true,
			wasRunning: false,
		}));
		const performRefresh = vi.fn(async () => ({
			instanceId: 'inst_1',
			accessToken: 'tok-access',
			expiresInSec: 900,
		}));

		const code = await runDashboardCommand(
			{subcommand: 'unpair', subcommandArgs: [], flags: {}},
			{...deps, stopRuntimeDaemon, performRefresh},
		);
		// Local removal still succeeds — leaving paired-on-disk-but-unreachable
		// is worse UX than a brief server-side residue.
		expect(code).toBe(0);
		expect(removed.count).toBe(1);
		expect(cap.err.join('\n')).toContain('revoke failed');
		expect(cap.out.join('\n')).toContain('credentials removed');
	});
});

describe('runDashboardCommand: runs', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'r',
		fingerprint: 'fp',
		pairedAt: 1,
	};

	it('lists runs returned by the daemon UDS', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runDashboardCommand(
			{subcommand: 'runs', subcommandArgs: [], flags: {}},
			{
				...deps,
				queryRuntimeDaemon: async () => ({
					ok: true,
					cmd: 'runs',
					runs: [
						{
							runId: 'run_1',
							startedAt: Date.now() - 30_000,
							endedAt: Date.now() - 10_000,
							status: 'completed',
						},
						{
							runId: 'run_2',
							startedAt: Date.now() - 5_000,
							status: 'running',
						},
					],
				}),
			},
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('run_1');
		expect(cap.out.join('\n')).toContain('run_2');
		expect(cap.out.join('\n')).toContain('running');
		expect(cap.out.join('\n')).toContain('completed');
	});

	it('exits 1 when the daemon is not running', async () => {
		const {deps, cap} = makeDeps({stored});
		const code = await runDashboardCommand(
			{subcommand: 'runs', subcommandArgs: [], flags: {}},
			{
				...deps,
				queryRuntimeDaemon: async () => ({
					ok: false,
					error: 'daemon not running',
				}),
			},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('daemon not running');
	});
});

describe('runDashboardCommand: daemon start/stop/restart/reload', () => {
	const stored: DashboardClientConfig = {
		dashboardUrl: 'https://example.com',
		instanceId: 'inst_1',
		refreshToken: 'r',
		fingerprint: 'fp',
		pairedAt: 1,
	};

	it('start spawns the daemon and reports verified connection', async () => {
		const {deps, cap} = makeDeps({stored});
		const startRuntimeDaemon = vi.fn(async () => ({
			ok: true,
			connected: true,
			pid: 4123,
		}));
		const code = await runDashboardCommand(
			{subcommand: 'daemon', subcommandArgs: ['start'], flags: {}},
			{...deps, startRuntimeDaemon},
		);
		expect(code).toBe(0);
		expect(startRuntimeDaemon).toHaveBeenCalledTimes(1);
		expect(cap.out.join('\n')).toContain('daemon started and connected');
	});

	it('stop reports daemon-not-running when not held', async () => {
		const {deps, cap} = makeDeps({stored});
		const stopRuntimeDaemon = vi.fn(async () => ({
			ok: true,
			wasRunning: false,
			message: 'daemon not running',
		}));
		const code = await runDashboardCommand(
			{subcommand: 'daemon', subcommandArgs: ['stop'], flags: {}},
			{...deps, stopRuntimeDaemon},
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('daemon not running');
	});

	it('restart calls stop then start', async () => {
		const {deps} = makeDeps({stored});
		const stopRuntimeDaemon = vi.fn(async () => ({
			ok: true,
			wasRunning: true,
		}));
		const startRuntimeDaemon = vi.fn(async () => ({
			ok: true,
			connected: true,
		}));
		const code = await runDashboardCommand(
			{subcommand: 'daemon', subcommandArgs: ['restart'], flags: {}},
			{...deps, stopRuntimeDaemon, startRuntimeDaemon},
		);
		expect(code).toBe(0);
		expect(stopRuntimeDaemon).toHaveBeenCalledTimes(1);
		expect(startRuntimeDaemon).toHaveBeenCalledTimes(1);
	});

	it('reload routes a reload UDS command to the daemon', async () => {
		const {deps} = makeDeps({stored});
		const queryRuntimeDaemon = vi.fn(async () => ({
			ok: true as const,
			cmd: 'reload' as const,
		}));
		const code = await runDashboardCommand(
			{subcommand: 'daemon', subcommandArgs: ['reload'], flags: {}},
			{...deps, queryRuntimeDaemon},
		);
		expect(code).toBe(0);
		expect(queryRuntimeDaemon).toHaveBeenCalledWith({cmd: 'reload'});
	});
});
