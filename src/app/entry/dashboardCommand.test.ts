import {describe, expect, it, vi} from 'vitest';
import {runDashboardCommand} from './dashboardCommand';
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

	function makeFakeSocket() {
		const calls = {
			connect: 0,
			closed: [] as string[],
		};
		const closeHandlers: Array<(reason: string) => void> = [];
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
				},
				close: (reason?: string) => {
					calls.closed.push(reason ?? '');
				},
				onFrame: () => {},
				onClose: (handler: (reason: string) => void) => {
					closeHandlers.push(handler);
				},
			};
		};
		return {
			factory,
			calls,
			lastOpts: () => lastOpts,
			emitClose: (reason: string) => {
				for (const h of closeHandlers) h(reason);
			},
		};
	}

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
				}),
				waitForShutdown: async () => 'SIGINT',
			},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('refused');
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
