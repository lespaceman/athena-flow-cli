import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	type InstanceSocketClient,
	type InstanceSocketLogger,
} from '../dashboard/instanceSocketClient';
import {executeRemoteAssignment} from '../dashboard/remoteRunExecutor';
import {runDashboardRuntimeDaemon} from '../dashboard/runtimeDaemon';
import {runGatewayCommand} from './gatewayCommand';
import {
	refreshDashboardAccessToken,
	type DashboardAccessToken,
} from '../../infra/config/dashboardAuth';
import {channelSidecarDir} from '../../infra/config/channels';
import {
	type DashboardClientConfig,
	dashboardClientConfigPath,
	normalizeDashboardUrl,
	readDashboardClientConfig,
	removeDashboardClientConfig,
	writeDashboardClientConfig,
} from '../../infra/config/dashboardClient';
import {
	daemonStatePaths,
	type DaemonStatePaths,
} from '../../infra/daemon/stateDir';
import {readPidLock} from '../../infra/daemon/pidLock';
import {
	installServiceUnit,
	type ServiceInstallResult,
} from '../../infra/daemon/serviceUnit';
import {
	sendUdsRequest,
	type UdsRequest,
	type UdsResponse,
} from '../../infra/daemon/udsIpc';

const USAGE = `Usage: athena dashboard <subcommand> [options]

Subcommands:
  pair <token> --url <dashboard-origin> [--name <machine-name>]
            Pair this machine with the dashboard, install the runtime
            daemon, and verify it reaches the dashboard socket.
  status    Show pairing, runner binding, daemon process state, socket
            health, and token freshness. Non-zero on any unhealthy axis.
  logs [--tail N] [--follow]
            Tail the daemon log file at
            ~/.local/state/drisp/dashboard-daemon.log.
  runs [--active] [--limit N]
            List runs the daemon has handled (in-memory ring, last 100).
  refresh   Mint a short-lived access token (rotates the refresh token).
  daemon foreground
            Run the daemon in the foreground (process supervisors,
            debugging).
  daemon start|stop|restart|reload
            Local IPC against the daemon UDS.
  daemon install
            Generate a launchd plist (macOS) or systemd user unit (linux)
            so the daemon starts automatically on login.
  doctor    Verify pairing health. With --runner <id>, also confirms the
            runner is bound to this instance.
  console enable <runnerId>
            Configure the console channel for a runner (opinionated;
            writes the sidecar and reloads the gateway).
  console link <runnerId>
            Primitive: write ~/.config/athena/channels/console.json for
            the given runner. Prefer "console enable".
  connect   Deprecated alias for "daemon foreground".
  unpair    Stop the daemon, revoke the refresh token, and remove the
            local config.

Options:
  --url <origin>      Dashboard origin (required for pair)
  --runner <id>       Runner id (required for "console enable"/"console
                      link", optional for "doctor")
  --name <name>       Friendly machine name (optional, defaults to hostname)
  --tail N            Number of trailing log lines (default 20)
  --follow            Stream new log lines until interrupted
  --active            Show only active runs
  --limit N           Cap the number of runs returned
  --json              Emit machine-readable JSON output
`;

declare const __ATHENA_VERSION__: string;
const require_ = createRequire(import.meta.url);

let cachedVersion: string | null = null;
function readPackageVersion(): string {
	if (cachedVersion !== null) return cachedVersion;
	try {
		const injected: unknown = __ATHENA_VERSION__;
		if (typeof injected === 'string' && injected.length > 0) {
			cachedVersion = injected;
			return cachedVersion;
		}
	} catch {
		// fall through to require-based read
	}
	try {
		const pkg = require_('../../../package.json') as {version?: string};
		cachedVersion = pkg.version ?? '0.0.0';
	} catch {
		cachedVersion = '0.0.0';
	}
	return cachedVersion;
}

export type DashboardCommandFlags = {
	url?: string;
	name?: string;
	runner?: string;
	json?: boolean;
	tail?: number;
	follow?: boolean;
	active?: boolean;
	limit?: number;
};

export type DashboardCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
	flags: DashboardCommandFlags;
};

export type DashboardCommandDeps = {
	fetch?: typeof fetch;
	now?: () => number;
	fingerprint?: () => string;
	hostInfo?: () => Record<string, unknown>;
	packageVersion?: string;
	readConfig?: () => DashboardClientConfig | null;
	writeConfig?: (config: DashboardClientConfig) => void;
	removeConfig?: () => void;
	configPath?: () => string;
	logOut?: (message: string) => void;
	logError?: (message: string) => void;
	makeInstanceSocketClient?: (opts: {
		dashboardUrl: string;
		instanceId: string;
		accessToken: string;
		log: InstanceSocketLogger;
	}) => InstanceSocketClient;
	executeRemoteAssignment?: typeof executeRemoteAssignment;
	channelDir?: () => string;
	reloadGatewayChannels?: () => Promise<{ok: boolean; message: string}>;
	waitForShutdown?: () => Promise<string>;
	startRuntimeDaemon?: (opts: {
		log: (msg: string) => void;
	}) => Promise<RuntimeDaemonStartResult>;
	stopRuntimeDaemon?: (opts: {
		timeoutMs?: number;
	}) => Promise<RuntimeDaemonStopResult>;
	queryRuntimeDaemon?: (req: UdsRequest) => Promise<UdsResponse>;
	daemonStatePaths?: () => DaemonStatePaths;
	tailDaemonLog?: (opts: {tail: number; follow: boolean}) => Promise<number>;
	installServiceUnit?: () => ServiceInstallResult;
	/**
	 * Override the shared refresh helper. Production uses the lock-and-rotate
	 * implementation in `dashboardAuth.ts`; tests inject a fake.
	 */
	performRefresh?: (
		label: 'refresh' | 'connect',
	) => Promise<DashboardAccessToken>;
};

type RuntimeDaemonStartResult = {
	ok: boolean;
	alreadyRunning?: boolean;
	connected?: boolean;
	pid?: number;
	message?: string;
};

type RuntimeDaemonStopResult = {
	ok: boolean;
	wasRunning: boolean;
	message?: string;
};

type PairedRunner = {
	runnerId: string;
	name?: string;
	executionTarget?: string;
	remoteInstanceId?: string;
};

type CapabilityAck = {
	runtimeDaemon?: boolean;
	consoleAdapter?: boolean;
	instanceSocket?: boolean;
};

type PairResponse = {
	instanceId: string;
	refreshToken: string;
	jti?: string;
	accessToken?: string;
	expiresInSec?: number;
	runners?: PairedRunner[];
	requiredCliVersion?: string;
	capabilityAck?: CapabilityAck;
};

function defaultFingerprint(): string {
	const seed = [
		os.hostname(),
		os.userInfo().username,
		os.platform(),
		os.arch(),
	].join('\0');
	return crypto.createHash('sha256').update(seed).digest('hex');
}

function defaultHostInfo(name?: string): Record<string, unknown> {
	return {
		hostname: os.hostname(),
		user: os.userInfo().username,
		platform: os.platform(),
		arch: os.arch(),
		name: name ?? os.hostname(),
	};
}

export async function runDashboardCommand(
	input: DashboardCommandInput,
	deps: DashboardCommandDeps = {},
): Promise<number> {
	const logOut = deps.logOut ?? ((m: string) => process.stdout.write(m + '\n'));
	const logError =
		deps.logError ?? ((m: string) => process.stderr.write(m + '\n'));
	const fetchImpl = deps.fetch ?? fetch;
	const now = deps.now ?? (() => Date.now());
	const fingerprint = deps.fingerprint ?? defaultFingerprint;
	const readConfig = deps.readConfig ?? (() => readDashboardClientConfig());
	const writeConfig =
		deps.writeConfig ??
		((c: DashboardClientConfig) => writeDashboardClientConfig(c));
	const removeConfig =
		deps.removeConfig ?? (() => removeDashboardClientConfig());
	const configPath = deps.configPath ?? (() => dashboardClientConfigPath());
	const packageVersion = deps.packageVersion ?? readPackageVersion();

	const {subcommand, subcommandArgs, flags} = input;

	if (!subcommand || subcommand === 'help' || subcommand === '--help') {
		logOut(USAGE);
		return 0;
	}

	if (subcommand === 'pair') {
		const token = subcommandArgs[0];
		if (!token) {
			logError('dashboard pair: missing pairing token');
			logError(USAGE);
			return 2;
		}
		if (subcommandArgs.length > 1) {
			logError(`dashboard pair: unexpected argument ${subcommandArgs[1]}`);
			return 2;
		}
		if (!flags.url) {
			logError('dashboard pair: --url <dashboard-origin> is required');
			return 2;
		}
		let origin: string;
		try {
			origin = normalizeDashboardUrl(flags.url);
		} catch (err) {
			logError(
				`dashboard pair: ${err instanceof Error ? err.message : String(err)}`,
			);
			return 2;
		}

		const fp = fingerprint();
		const body = {
			token,
			fingerprint: fp,
			hostInfo: (deps.hostInfo ?? (() => defaultHostInfo(flags.name)))(),
			capabilities: {
				instanceSocket: true,
				consoleAdapter: true,
				runtimeDaemon: true,
				cliVersion: packageVersion,
				// Legacy field — older dashboards read `version`. Drop in a
				// follow-up release once the dashboard accepts only `cliVersion`.
				version: packageVersion,
			},
		};

		let response: Response;
		try {
			response = await fetchImpl(`${origin}/api/instances/pair`, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify(body),
			});
		} catch (err) {
			logError(
				`dashboard pair: failed to reach ${origin}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return 1;
		}
		if (!response.ok) {
			const message = await safeReadError(response);
			logError(
				`dashboard pair: ${origin} returned ${response.status}${
					message ? ` — ${message}` : ''
				}`,
			);
			return 1;
		}

		let parsed: PairResponse;
		try {
			parsed = parsePairResponse(await response.json());
		} catch (err) {
			logError(
				`dashboard pair: invalid response from ${origin}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return 1;
		}

		// Refuse to install the daemon if the dashboard signals our CLI is too
		// old. The pairing succeeded server-side already, so the user can still
		// re-run pair after upgrading and the persisted config is the source of
		// truth — we just don't spawn a daemon that the dashboard would refuse
		// to handshake with.
		if (
			parsed.requiredCliVersion &&
			compareSemver(packageVersion, parsed.requiredCliVersion) < 0
		) {
			logError(
				`dashboard pair: cli version ${packageVersion} is older than the dashboard's required >=${parsed.requiredCliVersion}.`,
			);
			logError(
				'dashboard pair: upgrade with `npm i -g @drisp/cli` then re-run pair.',
			);
			return 1;
		}

		const config: DashboardClientConfig = {
			dashboardUrl: origin,
			instanceId: parsed.instanceId,
			refreshToken: parsed.refreshToken,
			fingerprint: fp,
			pairedAt: now(),
		};
		writeConfig(config);

		const daemonStart = await (
			deps.startRuntimeDaemon ?? defaultStartRuntimeDaemon
		)({
			log: msg => logOut(msg),
		});

		if (flags.json) {
			logOut(
				JSON.stringify({
					ok: true,
					instanceId: parsed.instanceId,
					dashboardUrl: origin,
					configPath: configPath(),
					daemon: daemonStart,
					...(parsed.runners ? {runners: parsed.runners} : {}),
					...(parsed.capabilityAck
						? {capabilityAck: parsed.capabilityAck}
						: {}),
					...(parsed.requiredCliVersion
						? {requiredCliVersion: parsed.requiredCliVersion}
						: {}),
				}),
			);
		} else {
			logOut(`dashboard: paired to ${origin} as ${parsed.instanceId}`);
			if (parsed.runners && parsed.runners.length > 0) {
				for (const runner of parsed.runners) {
					logOut(
						`dashboard: bound runner ${runner.name ?? runner.runnerId} (${runner.runnerId})`,
					);
				}
			} else {
				logOut('dashboard: no runner bound to this pairing token.');
				logOut(
					'dashboard: bind a runner from runner settings, then this machine will receive its runs.',
				);
			}
			if (parsed.capabilityAck === undefined) {
				logOut(
					'dashboard: dashboard did not echo capabilityAck (older server). Continuing.',
				);
			}
			if (daemonStart.ok) {
				const status = daemonStart.alreadyRunning
					? 'runtime daemon already running, restarted with new token'
					: daemonStart.connected
						? 'runtime daemon connected (verified socket open)'
						: 'runtime daemon started but did not reach the socket within 10s';
				logOut(`dashboard: ${status}`);
				if (!daemonStart.connected && !daemonStart.alreadyRunning) {
					logOut(
						'dashboard pair: pairing succeeded; tail logs with `drisp dashboard logs --follow`.',
					);
				}
			} else {
				logError(
					`dashboard: runtime daemon did not start${
						daemonStart.message ? ` — ${daemonStart.message}` : ''
					}`,
				);
				logOut(
					'dashboard pair: pairing succeeded; start the daemon with `drisp dashboard daemon start`.',
				);
			}
			logOut('dashboard: ready. Click Run in the dashboard.');
		}
		// Pairing on disk is the source of truth. A daemon spawn failure is a
		// warning, not a pair failure — the user can retry `daemon start` later.
		return 0;
	}

	if (subcommand === 'status') {
		if (subcommandArgs.length > 0) {
			logError(`dashboard status: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const config = readConfig();
		if (!config) {
			if (flags.json) {
				logOut(JSON.stringify({ok: false, paired: false}));
			} else {
				logOut('dashboard: not paired');
			}
			return 1;
		}
		const queryDaemon = deps.queryRuntimeDaemon ?? defaultQueryRuntimeDaemon;
		let daemonReply: UdsResponse | null = null;
		try {
			daemonReply = await queryDaemon({cmd: 'status'});
		} catch (err) {
			daemonReply = {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}

		// Optional runner check: if --runner is supplied, do the same dashboard
		// GET that doctor does. Saves the user from running two commands when
		// they want a full health check.
		type RunnerHealth = {
			id: string;
			matches: boolean;
			error?: string;
			executionTarget?: string;
			remoteInstanceId?: string;
		};
		let runnerHealth: RunnerHealth | undefined;
		if (flags.runner) {
			const refreshResult = await tryRefresh('refresh');
			if (refreshResult.ok) {
				runnerHealth = await fetchRunnerHealth(
					fetchImpl,
					config.dashboardUrl,
					flags.runner,
					refreshResult.token,
				);
			} else {
				runnerHealth = {
					id: flags.runner,
					matches: false,
					error: 'could not refresh access token',
				};
			}
		}

		const daemonRunning = daemonReply.ok && daemonReply.cmd === 'status';
		const socketHealthy =
			daemonRunning &&
			(daemonReply as {socketConnected: boolean}).socketConnected;
		const runnerOk = !runnerHealth || runnerHealth.matches;
		const ok = daemonRunning && socketHealthy && runnerOk;

		if (flags.json) {
			logOut(
				JSON.stringify({
					ok,
					paired: true,
					instanceId: config.instanceId,
					dashboardUrl: config.dashboardUrl,
					pairedAt: config.pairedAt,
					...(config.lastRefreshAt !== undefined
						? {lastRefreshAt: config.lastRefreshAt}
						: {}),
					configPath: configPath(),
					daemon:
						daemonReply.ok && daemonReply.cmd === 'status'
							? {
									running: true,
									pid: daemonReply.pid,
									startedAt: daemonReply.startedAt,
									socketConnected: daemonReply.socketConnected,
									...(daemonReply.lastFrameAt !== undefined
										? {lastFrameAt: daemonReply.lastFrameAt}
										: {}),
									activeRuns: daemonReply.activeRuns,
									completedRuns: daemonReply.completedRuns,
									...(daemonReply.refreshState
										? {refreshState: daemonReply.refreshState}
										: {}),
								}
							: {
									running: false,
									...(!daemonReply.ok ? {error: daemonReply.error} : {}),
								},
					...(runnerHealth ? {runner: runnerHealth} : {}),
				}),
			);
		} else {
			logOut(
				`dashboard: paired to ${config.dashboardUrl} as ${config.instanceId}`,
			);
			if (runnerHealth) {
				if (runnerHealth.matches) {
					logOut(
						`runner:    ${runnerHealth.id} bound to this instance (executionTarget=remote)`,
					);
				} else {
					logError(
						`runner:    ${runnerHealth.id} ${runnerHealth.error ?? 'not bound'}`,
					);
				}
			}
			if (daemonRunning) {
				const r = daemonReply as Extract<UdsResponse, {cmd: 'status'}>;
				const uptimeSec = Math.max(
					0,
					Math.floor((now() - r.startedAt) / 1_000),
				);
				logOut(
					`daemon:    running (pid ${r.pid}, uptime ${formatDuration(uptimeSec)}, ${r.completedRuns} runs completed, ${r.activeRuns} active)`,
				);
				logOut(
					`socket:    ${r.socketConnected ? 'connected' : 'disconnected'}${
						r.lastFrameAt !== undefined
							? ` (last frame ${formatDuration(
									Math.max(0, Math.floor((now() - r.lastFrameAt) / 1_000)),
								)} ago)`
							: ''
					}`,
				);
				if (r.refreshState) {
					if (
						r.refreshState.cooldownUntilMs !== undefined &&
						r.refreshState.cooldownUntilMs > now()
					) {
						const remainingSec = Math.ceil(
							(r.refreshState.cooldownUntilMs - now()) / 1_000,
						);
						logError(
							`refresh:   circuit-broken — sleeping for ${formatDuration(
								remainingSec,
							)} before retry. Re-pair if this persists.`,
						);
					} else {
						logOut(
							`refresh:   ${r.refreshState.recentFailures} recent failure(s); next reconnect will retry`,
						);
					}
				}
			} else {
				logOut(
					'daemon:    NOT running. Start it with `drisp dashboard daemon start`.',
				);
			}
			if (config.lastRefreshAt !== undefined) {
				logOut(
					`token:     last refreshed ${formatDuration(
						Math.max(0, Math.floor((now() - config.lastRefreshAt) / 1_000)),
					)} ago`,
				);
			}
		}
		return ok ? 0 : 1;
	}

	if (subcommand === 'logs') {
		if (subcommandArgs.length > 0) {
			logError(`dashboard logs: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const tail = flags.tail ?? 20;
		const follow = flags.follow ?? false;
		try {
			const tailFn = deps.tailDaemonLog ?? defaultTailDaemonLog;
			return await tailFn({tail, follow});
		} catch (err) {
			logError(
				`dashboard logs: ${err instanceof Error ? err.message : String(err)}`,
			);
			return 1;
		}
	}

	if (subcommand === 'runs') {
		if (subcommandArgs.length > 0) {
			logError(`dashboard runs: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const queryDaemon = deps.queryRuntimeDaemon ?? defaultQueryRuntimeDaemon;
		let reply: UdsResponse;
		try {
			reply = await queryDaemon({
				cmd: 'runs',
				...(flags.active === true ? {active: true} : {}),
				...(flags.limit !== undefined ? {limit: flags.limit} : {}),
			});
		} catch (err) {
			logError(
				`dashboard runs: ${err instanceof Error ? err.message : String(err)}`,
			);
			return 1;
		}
		if (!reply.ok || reply.cmd !== 'runs') {
			logError(
				`dashboard runs: ${reply.ok ? 'unexpected reply' : reply.error}`,
			);
			return 1;
		}
		if (flags.json) {
			logOut(JSON.stringify({ok: true, runs: reply.runs}));
			return 0;
		}
		if (reply.runs.length === 0) {
			logOut('dashboard: no runs recorded');
			return 0;
		}
		logOut(['runId', 'started', 'duration', 'status'].join('\t'));
		for (const run of reply.runs) {
			const duration = run.endedAt
				? formatDuration(
						Math.max(0, Math.floor((run.endedAt - run.startedAt) / 1_000)),
					)
				: '—';
			logOut(
				[
					run.runId,
					formatDuration(
						Math.max(0, Math.floor((now() - run.startedAt) / 1_000)),
					) + ' ago',
					duration,
					run.status,
				].join('\t'),
			);
		}
		return 0;
	}

	const performRefreshImpl =
		deps.performRefresh ??
		(async (_label: 'refresh' | 'connect') =>
			refreshDashboardAccessToken({fetch: fetchImpl, now}));

	async function tryRefresh(
		label: 'refresh' | 'connect',
	): Promise<
		{ok: true; token: DashboardAccessToken} | {ok: false; code: number}
	> {
		try {
			const token = await performRefreshImpl(label);
			return {ok: true, token};
		} catch (err) {
			logError(
				`dashboard ${label}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return {ok: false, code: 1};
		}
	}

	if (subcommand === 'refresh') {
		if (subcommandArgs.length > 0) {
			logError(`dashboard refresh: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		if (!readConfig()) {
			logError(
				'dashboard refresh: not paired. Run "athena dashboard pair" first.',
			);
			return 1;
		}
		const result = await tryRefresh('refresh');
		if (!result.ok) return result.code;
		const {token} = result;
		if (flags.json) {
			// Re-read so callers get the rotated refresh token alongside the
			// access token. The refresh helper rotates the on-disk value before
			// returning so this is consistent.
			const rotated = readConfig();
			logOut(
				JSON.stringify({
					ok: true,
					instanceId: token.instanceId,
					accessToken: token.accessToken,
					refreshToken: rotated?.refreshToken,
					expiresInSec: token.expiresInSec,
				}),
			);
		} else {
			logOut(
				`dashboard: refreshed access token for instance ${token.instanceId}`,
			);
		}
		return 0;
	}

	if (subcommand === 'daemon') {
		const mode = subcommandArgs[0];
		if (mode === 'foreground') {
			if (subcommandArgs.length > 1) {
				logError(
					`dashboard daemon foreground: unexpected argument ${subcommandArgs[1]}`,
				);
				return 2;
			}
			const config = readConfig();
			if (!config) {
				logError(
					'dashboard daemon foreground: not paired. Run "drisp dashboard pair" first.',
				);
				return 1;
			}
			let daemon;
			try {
				daemon = await runDashboardRuntimeDaemon({
					readConfig,
					refreshAccessToken: async () => performRefreshImpl('connect'),
					makeInstanceSocketClient: deps.makeInstanceSocketClient,
					executeRemoteAssignment: deps.executeRemoteAssignment,
					log: (level, message) => {
						if (level === 'error' || level === 'warn') {
							logError(`dashboard daemon: ${message}`);
						} else {
							logOut(`dashboard daemon: ${message}`);
						}
					},
				});
			} catch (err) {
				logError(
					`dashboard daemon foreground: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				return 1;
			}
			logOut(`dashboard daemon: foreground runtime connected`);
			const wait = deps.waitForShutdown ?? defaultWaitForShutdown;
			const reason = await wait();
			await daemon.stop(reason);
			logOut(`dashboard daemon: stopped (${reason})`);
			return 0;
		}

		if (mode === 'start') {
			if (subcommandArgs.length > 1) {
				logError(
					`dashboard daemon start: unexpected argument ${subcommandArgs[1]}`,
				);
				return 2;
			}
			if (!readConfig()) {
				logError(
					'dashboard daemon start: not paired. Run "drisp dashboard pair" first.',
				);
				return 1;
			}
			const result = await (
				deps.startRuntimeDaemon ?? defaultStartRuntimeDaemon
			)({log: msg => logOut(msg)});
			if (flags.json) {
				logOut(JSON.stringify(result));
			} else if (result.ok) {
				logOut(
					result.connected
						? 'dashboard: daemon started and connected'
						: 'dashboard: daemon started; socket not yet verified (tail logs)',
				);
			} else {
				logError(
					`dashboard daemon start: ${result.message ?? 'unknown failure'}`,
				);
			}
			return result.ok ? 0 : 1;
		}

		if (mode === 'stop') {
			if (subcommandArgs.length > 1) {
				logError(
					`dashboard daemon stop: unexpected argument ${subcommandArgs[1]}`,
				);
				return 2;
			}
			const result = await (deps.stopRuntimeDaemon ?? defaultStopRuntimeDaemon)(
				{},
			);
			if (flags.json) {
				logOut(JSON.stringify(result));
			} else if (!result.wasRunning) {
				logOut('dashboard: daemon not running');
			} else if (result.ok) {
				logOut('dashboard: daemon stopped');
			} else {
				logError(
					`dashboard daemon stop: ${result.message ?? 'unknown failure'}`,
				);
			}
			return result.ok ? 0 : 1;
		}

		if (mode === 'restart') {
			if (subcommandArgs.length > 1) {
				logError(
					`dashboard daemon restart: unexpected argument ${subcommandArgs[1]}`,
				);
				return 2;
			}
			const stopResult = await (
				deps.stopRuntimeDaemon ?? defaultStopRuntimeDaemon
			)({});
			if (stopResult.wasRunning && !stopResult.ok) {
				logError(
					`dashboard daemon restart: stop failed: ${stopResult.message ?? 'unknown'}`,
				);
				return 1;
			}
			const startResult = await (
				deps.startRuntimeDaemon ?? defaultStartRuntimeDaemon
			)({log: msg => logOut(msg)});
			if (flags.json) {
				logOut(JSON.stringify({restart: true, ...startResult}));
			} else if (startResult.ok) {
				logOut(
					startResult.connected
						? 'dashboard: daemon restarted and connected'
						: 'dashboard: daemon restarted; socket not yet verified',
				);
			} else {
				logError(
					`dashboard daemon restart: ${startResult.message ?? 'unknown'}`,
				);
			}
			return startResult.ok ? 0 : 1;
		}

		if (mode === 'install') {
			if (subcommandArgs.length > 1) {
				logError(
					`dashboard daemon install: unexpected argument ${subcommandArgs[1]}`,
				);
				return 2;
			}
			const installer = deps.installServiceUnit ?? defaultInstallServiceUnit;
			const result = installer();
			if (flags.json) {
				logOut(JSON.stringify(result));
			} else if (result.ok) {
				logOut(`dashboard: wrote service unit at ${result.path}`);
				logOut(`dashboard: load with: ${result.loadCommand}`);
				logOut(`dashboard: start with: ${result.startCommand}`);
			} else {
				logError(
					`dashboard daemon install: ${result.message ?? 'unsupported platform'}`,
				);
			}
			return result.ok ? 0 : 1;
		}

		if (mode === 'reload') {
			if (subcommandArgs.length > 1) {
				logError(
					`dashboard daemon reload: unexpected argument ${subcommandArgs[1]}`,
				);
				return 2;
			}
			const queryDaemon = deps.queryRuntimeDaemon ?? defaultQueryRuntimeDaemon;
			try {
				const reply = await queryDaemon({cmd: 'reload'});
				if (!reply.ok) {
					logError(`dashboard daemon reload: ${reply.error}`);
					return 1;
				}
			} catch (err) {
				logError(
					`dashboard daemon reload: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				return 1;
			}
			if (flags.json) {
				logOut(JSON.stringify({ok: true}));
			} else {
				logOut('dashboard: daemon reloaded');
			}
			return 0;
		}

		logError(
			`dashboard daemon: unknown subcommand ${
				mode ? mode : '(missing)'
			}. Expected "foreground|start|stop|restart|reload|install".`,
		);
		return 2;
	}

	if (subcommand === 'connect') {
		if (subcommandArgs.length > 0) {
			logError(`dashboard connect: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		logError(
			'dashboard connect: deprecated; use `dashboard daemon foreground` (or `daemon start` to background).',
		);
		return await runDashboardCommand(
			{
				subcommand: 'daemon',
				subcommandArgs: ['foreground'],
				flags: input.flags,
			},
			deps,
		);
	}

	if (subcommand === 'doctor') {
		if (subcommandArgs.length > 0) {
			logError(`dashboard doctor: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const config = readConfig();
		if (!config) {
			if (flags.json) {
				logOut(JSON.stringify({ok: false, paired: false}));
			} else {
				logOut('dashboard: not paired');
				logOut(
					'dashboard doctor: run "drisp dashboard pair" before using doctor.',
				);
			}
			return 1;
		}

		// Only rotate the refresh token when we actually need an access token
		// (runner check). Otherwise doctor would burn a token on every health
		// check the user runs.
		let token: DashboardAccessToken | null = null;
		if (flags.runner) {
			const refreshResult = await tryRefresh('refresh');
			if (!refreshResult.ok) return refreshResult.code;
			token = refreshResult.token;
		}
		const refreshed = readConfig();

		type RunnerReport = {
			id: string;
			executionTarget?: string;
			remoteInstanceId?: string;
			matches: boolean;
			error?: string;
		};
		let runnerReport: RunnerReport | undefined;
		let runnerOk = !flags.runner;

		if (flags.runner && token) {
			const runnerId = flags.runner;
			const accessToken = token.accessToken;
			const expectedInstanceId = token.instanceId;
			const url = new URL(
				`/api/runners/${encodeURIComponent(runnerId)}`,
				config.dashboardUrl,
			).toString();
			let response: Response;
			try {
				response = await fetchImpl(url, {
					method: 'GET',
					headers: {
						authorization: `Bearer ${accessToken}`,
						accept: 'application/json',
					},
				});
			} catch (err) {
				runnerOk = false;
				runnerReport = {
					id: runnerId,
					matches: false,
					error: `request failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				};
				return reportDoctor(false);
			}
			if (response.status === 404) {
				runnerOk = false;
				runnerReport = {
					id: runnerId,
					matches: false,
					error: 'runner not found',
				};
			} else if (response.status === 405 || response.status === 501) {
				runnerOk = false;
				runnerReport = {
					id: runnerId,
					matches: false,
					error:
						'runner check unavailable: dashboard endpoint missing (GET /api/runners/<id>)',
				};
			} else if (!response.ok) {
				runnerOk = false;
				const message = await safeReadError(response);
				runnerReport = {
					id: runnerId,
					matches: false,
					error: `dashboard returned ${response.status}${
						message ? ` — ${message}` : ''
					}`,
				};
			} else {
				let body: unknown;
				try {
					body = await response.json();
				} catch (err) {
					runnerOk = false;
					runnerReport = {
						id: runnerId,
						matches: false,
						error: `invalid response body: ${
							err instanceof Error ? err.message : String(err)
						}`,
					};
					return reportDoctor(false);
				}
				const obj = (
					typeof body === 'object' && body !== null
						? (body as Record<string, unknown>)
						: {}
				) as Record<string, unknown>;
				const executionTarget =
					typeof obj['executionTarget'] === 'string'
						? (obj['executionTarget'] as string)
						: undefined;
				const remoteInstanceId =
					typeof obj['remoteInstanceId'] === 'string'
						? (obj['remoteInstanceId'] as string)
						: undefined;
				const matchesTarget = executionTarget === 'remote';
				const matchesInstance = remoteInstanceId === expectedInstanceId;
				const matches = matchesTarget && matchesInstance;
				runnerOk = matches;
				const reasons: string[] = [];
				if (!matchesTarget) {
					reasons.push(
						`executionTarget is "${
							executionTarget ?? 'unset'
						}" (expected "remote")`,
					);
				}
				if (!matchesInstance) {
					reasons.push(
						`remoteInstanceId is "${
							remoteInstanceId ?? 'unset'
						}" (expected "${expectedInstanceId}")`,
					);
				}
				runnerReport = {
					id: runnerId,
					executionTarget,
					remoteInstanceId,
					matches,
					error: reasons.length > 0 ? reasons.join('; ') : undefined,
				};
			}
		}

		return reportDoctor(runnerOk);

		function reportDoctor(ok: boolean): number {
			if (flags.json) {
				logOut(
					JSON.stringify({
						ok,
						paired: true,
						instanceId: config!.instanceId,
						dashboardUrl: config!.dashboardUrl,
						pairedAt: config!.pairedAt,
						...(refreshed?.lastRefreshAt !== undefined
							? {lastRefreshAt: refreshed.lastRefreshAt}
							: {}),
						configPath: configPath(),
						...(runnerReport ? {runner: runnerReport} : {}),
					}),
				);
			} else {
				logOut(
					`dashboard: paired to ${config!.dashboardUrl} as ${config!.instanceId}`,
				);
				if (token) {
					logOut(`dashboard: refresh token rotated, access token minted`);
				}
				if (runnerReport) {
					if (runnerReport.matches) {
						logOut(
							`dashboard: runner ${runnerReport.id} bound to this instance (executionTarget=remote, remoteInstanceId=${runnerReport.remoteInstanceId})`,
						);
					} else {
						logError(
							`dashboard doctor: runner ${runnerReport.id} not bound — ${
								runnerReport.error ?? 'unknown reason'
							}`,
						);
					}
				}
			}
			return ok ? 0 : 1;
		}
	}

	if (subcommand === 'console') {
		const sub = subcommandArgs[0];
		if (sub === 'enable') {
			const runnerId = subcommandArgs[1];
			if (!runnerId) {
				logError('dashboard console enable: missing <runnerId>');
				return 2;
			}
			if (subcommandArgs.length > 2) {
				logError(
					`dashboard console enable: unexpected argument ${subcommandArgs[2]}`,
				);
				return 2;
			}
			// Opinionated wrapper around `console link`: extra preflight that
			// the runner is bound to *this* instance, then delegate to link.
			const config = readConfig();
			if (!config) {
				logError(
					'dashboard console enable: not paired. Run "drisp dashboard pair" first.',
				);
				return 1;
			}
			const refreshResult = await tryRefresh('refresh');
			if (!refreshResult.ok) return refreshResult.code;
			const health = await fetchRunnerHealth(
				fetchImpl,
				config.dashboardUrl,
				runnerId,
				refreshResult.token,
			);
			if (!health.matches) {
				logError(
					`dashboard console enable: runner ${runnerId} is not bound to this instance${
						health.error ? ` (${health.error})` : ''
					}`,
				);
				return 1;
			}
			return await runDashboardCommand(
				{
					subcommand: 'console',
					subcommandArgs: ['link', runnerId],
					flags: input.flags,
				},
				deps,
			);
		}
		if (sub === 'link') {
			const runnerId = subcommandArgs[1];
			if (!runnerId) {
				logError('dashboard console link: missing <runnerId>');
				return 2;
			}
			if (subcommandArgs.length > 2) {
				logError(
					`dashboard console link: unexpected argument ${subcommandArgs[2]}`,
				);
				return 2;
			}
			const config = readConfig();
			if (!config) {
				logError(
					'dashboard console link: not paired. Run "drisp dashboard pair" first.',
				);
				return 1;
			}
			let brokerUrl: string;
			try {
				brokerUrl = consoleBrokerUrl(config.dashboardUrl, runnerId);
			} catch (err) {
				logError(
					`dashboard console link: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				return 1;
			}
			const dir = (deps.channelDir ?? channelSidecarDir)();
			let previousBroker: string | undefined;
			const target = path.join(dir, 'console.json');
			try {
				const existing = JSON.parse(fs.readFileSync(target, 'utf-8')) as {
					broker_url?: unknown;
				};
				if (typeof existing.broker_url === 'string') {
					previousBroker = existing.broker_url;
				}
			} catch {
				// no existing file or unreadable — treated as fresh write
			}
			try {
				fs.mkdirSync(dir, {recursive: true, mode: 0o700});
			} catch (err) {
				logError(
					`dashboard console link: failed to create ${dir}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				return 1;
			}
			const payload = {
				broker_url: brokerUrl,
				runner_id: runnerId,
				dashboard_config: true,
			};
			const tmp = `${target}.tmp`;
			try {
				fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', {
					mode: 0o600,
				});
				fs.renameSync(tmp, target);
			} catch (err) {
				try {
					fs.unlinkSync(tmp);
				} catch {
					// best-effort
				}
				logError(
					`dashboard console link: failed to write ${target}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				return 1;
			}
			const reload = await (
				deps.reloadGatewayChannels ?? defaultReloadGatewayChannels
			)();
			if (flags.json) {
				logOut(
					JSON.stringify({
						ok: true,
						runnerId,
						brokerUrl,
						path: target,
						...(previousBroker ? {previousBrokerUrl: previousBroker} : {}),
						gatewayReload: reload,
					}),
				);
			} else {
				if (previousBroker && previousBroker !== brokerUrl) {
					logOut(`console: replaced existing config (was: ${previousBroker})`);
				}
				logOut(`console: linked runner ${runnerId} at ${brokerUrl}`);
				logOut(`console: wrote ${target}`);
				if (reload.ok) {
					logOut(`console: gateway channels reloaded (${reload.message})`);
				} else {
					logError(`console: gateway reload skipped: ${reload.message}`);
					logOut(
						'console: start or reload the gateway before using the Console tab.',
					);
				}
			}
			return 0;
		}
		logError(
			`dashboard console: unknown subcommand ${
				sub ? sub : '(missing)'
			}. Expected "enable <runnerId>" or "link <runnerId>".`,
		);
		return 2;
	}

	if (subcommand === 'unpair') {
		if (subcommandArgs.length > 0) {
			logError(`dashboard unpair: unexpected argument ${subcommandArgs[0]}`);
			return 2;
		}
		const config = readConfig();
		if (!config) {
			if (flags.json) {
				logOut(JSON.stringify({ok: true, paired: false}));
			} else {
				logOut('dashboard unpair: not paired (nothing to do)');
			}
			return 0;
		}

		// 1. Stop the daemon first so it stops processing assignments before we
		//    invalidate its credentials.
		const stopResult = await (
			deps.stopRuntimeDaemon ?? defaultStopRuntimeDaemon
		)({});
		if (!flags.json) {
			if (stopResult.wasRunning) {
				if (stopResult.ok) {
					logOut('dashboard: runtime daemon stopped');
				} else {
					logError(
						`dashboard: runtime daemon stop failed: ${
							stopResult.message ?? 'unknown'
						}`,
					);
				}
			} else {
				logOut('dashboard: runtime daemon not running (skipping stop)');
			}
		}

		// 2. Best-effort revoke. If the dashboard endpoint is unavailable or the
		//    network is down, surface a warning but proceed with local removal —
		//    leaving a paired-on-disk-but-unreachable config is worse UX than a
		//    server-side token that's still valid for a few minutes.
		let revokeOk = false;
		let revokeMessage: string | undefined;
		try {
			const refreshResult = await tryRefresh('refresh');
			if (refreshResult.ok) {
				const url = new URL(
					`/api/instances/${encodeURIComponent(config.instanceId)}/revoke`,
					config.dashboardUrl,
				).toString();
				const response = await fetchImpl(url, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${refreshResult.token.accessToken}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({}),
				});
				if (response.ok || response.status === 404) {
					revokeOk = true;
				} else {
					const detail = await safeReadError(response);
					revokeMessage = `dashboard returned ${response.status}${
						detail ? ` — ${detail}` : ''
					}`;
				}
			} else {
				revokeMessage = 'could not refresh access token';
			}
		} catch (err) {
			revokeMessage = err instanceof Error ? err.message : String(err);
		}

		if (!flags.json) {
			if (revokeOk) {
				logOut(`dashboard: revoking refresh token at ${config.dashboardUrl}`);
				logOut('dashboard: refresh token revoked');
			} else {
				logError(
					`dashboard: revoke failed${revokeMessage ? `: ${revokeMessage}` : ''}`,
				);
				logOut(
					'dashboard: WARNING — refresh token may still be valid until you revoke it from the dashboard UI.',
				);
			}
		}

		// 3. Remove local credentials.
		removeConfig();

		if (flags.json) {
			logOut(
				JSON.stringify({
					ok: true,
					daemon: stopResult,
					revoke: {
						ok: revokeOk,
						...(revokeMessage ? {message: revokeMessage} : {}),
					},
				}),
			);
		} else {
			logOut(
				`dashboard: unpaired (credentials removed${
					stopResult.wasRunning ? ', daemon stopped' : ''
				})`,
			);
		}
		return 0;
	}

	logError(`Unknown dashboard subcommand: ${subcommand}`);
	logError(USAGE);
	return 2;
}

function defaultWaitForShutdown(): Promise<string> {
	return new Promise<string>(resolve => {
		const onSignal = (signal: NodeJS.Signals): void => {
			process.off('SIGINT', onSignal);
			process.off('SIGTERM', onSignal);
			resolve(signal);
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);
	});
}

async function defaultReloadGatewayChannels(): Promise<{
	ok: boolean;
	message: string;
}> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runGatewayCommand(
		{subcommand: 'reload-channels', subcommandArgs: []},
		{
			logOut: m => out.push(m),
			logError: m => err.push(m),
		},
	);
	return {
		ok: code === 0,
		message:
			(code === 0 ? out.join('\n') : err.join('\n')) ||
			(code === 0 ? 'gateway channels reloaded' : 'gateway not reachable'),
	};
}

function resolveDaemonEntry(): string | null {
	// `import.meta.url` resolves to the bundled chunk under `dist/`. The
	// daemon entry is bundled as a sibling `dashboard-daemon.js`. Walking up
	// to the chunk's directory is robust whether the chunk lives at
	// `dist/cli.js` or at a hashed split chunk like `dist/chunk-X.js`.
	let here: string;
	try {
		here = fileURLToPath(import.meta.url);
	} catch {
		return null;
	}
	const candidates = [
		path.join(path.dirname(here), 'dashboard-daemon.js'),
		// When invoked via `npm run start`, `here` may be the unbundled source
		// path. Walk up until we hit a `dist/` sibling.
		path.join(
			path.dirname(here),
			'..',
			'..',
			'..',
			'dist',
			'dashboard-daemon.js',
		),
	];
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.R_OK);
			return candidate;
		} catch {
			// next candidate
		}
	}
	return null;
}

// NODE_OPTIONS is intentionally excluded — it can carry --require/--inspect
// which would let a parent shell inject arbitrary code into the daemon. The
// daemon should boot from a clean environment.
const DAEMON_ENV_ALLOWLIST = [
	'HOME',
	'PATH',
	'LANG',
	'LC_ALL',
	'ATHENA_DASHBOARD_ORIGIN',
];

function buildDaemonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const key of DAEMON_ENV_ALLOWLIST) {
		if (env[key] !== undefined) out[key] = env[key];
	}
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith('XDG_') && value !== undefined) {
			out[key] = value;
		}
	}
	return out;
}

const SOCKET_PROBE_TIMEOUT_MS = 10_000;
const SOCKET_PROBE_INTERVAL_MS = 200;

async function defaultStartRuntimeDaemon(opts: {
	log: (msg: string) => void;
}): Promise<RuntimeDaemonStartResult> {
	const paths = daemonStatePaths();

	// If a daemon is already alive, send a stop+start cycle so it picks up the
	// rotated refresh token from the just-completed pair. Falling through into
	// the spawn path covers the case where the lock is stale.
	const existing = readPidLock(paths.pidPath);
	if (existing.state === 'held') {
		try {
			await sendUdsRequest(paths.socketPath, {
				cmd: 'stop',
				reason: 'pair-restart',
			});
		} catch (err) {
			opts.log(
				`daemon: pair-restart stop request failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		// Wait for the previous daemon to release the lock.
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const after = readPidLock(paths.pidPath);
			if (after.state !== 'held') break;
			await new Promise(r => setTimeout(r, 100));
		}
	}

	const entry = resolveDaemonEntry();
	if (!entry) {
		return {
			ok: false,
			message: 'cannot resolve dashboard-daemon.js entry path',
		};
	}

	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(process.execPath, [entry], {
			detached: true,
			stdio: 'ignore',
			env: buildDaemonEnv(process.env),
		});
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
	child.unref();

	// Track child lifecycle so we can fail fast when the daemon dies before
	// the probe deadline rather than waiting the full 10s. Without this the
	// user sees a generic "socket not verified within 10s" for any startup
	// crash (binary mismatch, missing module, lock contention, etc.).
	let earlyExit: string | undefined;
	let spawnError: string | undefined;
	const onError = (err: Error): void => {
		spawnError = err.message;
	};
	const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
		earlyExit = `daemon exited early (code=${code ?? 'null'}, signal=${
			signal ?? 'null'
		})`;
	};
	child.once('error', onError);
	child.once('exit', onExit);

	// Verify-then-return: poll the daemon UDS until status reports the socket
	// is connected, max 10s. Pairing succeeded on disk regardless — this is
	// purely about reporting an honest "connected" status to the user.
	const probeDeadline = Date.now() + SOCKET_PROBE_TIMEOUT_MS;
	let lastError: string | undefined;
	let connected = false;
	let everReached = false;
	let pid: number | undefined;
	while (Date.now() < probeDeadline) {
		if (spawnError) break;
		if (earlyExit) break;
		try {
			const reply = await sendUdsRequest(
				paths.socketPath,
				{cmd: 'status'},
				{timeoutMs: 1_500},
			);
			everReached = true;
			if (reply.ok && reply.cmd === 'status') {
				pid = reply.pid;
				if (reply.socketConnected) {
					connected = true;
					break;
				}
			} else if (!reply.ok) {
				lastError = reply.error;
			}
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		await new Promise(r => setTimeout(r, SOCKET_PROBE_INTERVAL_MS));
	}

	child.off('error', onError);
	child.off('exit', onExit);

	// "ok" iff we have evidence the daemon is alive: either the socket is fully
	// connected, or we got at least one UDS reply. If the child crashed early
	// or we never reached the daemon, that's a real start failure — the caller
	// should treat it as such instead of optimistically "started in background".
	const reachable = connected || everReached;
	if (spawnError) {
		return {
			ok: false,
			message: `daemon failed to start: ${spawnError}`,
		};
	}
	if (earlyExit && !connected) {
		return {
			ok: false,
			message: earlyExit,
		};
	}
	if (!reachable) {
		return {
			ok: false,
			message: `daemon did not respond on UDS within ${SOCKET_PROBE_TIMEOUT_MS}ms${
				lastError ? ` (${lastError})` : ''
			}`,
		};
	}

	opts.log(
		connected
			? `daemon: socket verified${pid !== undefined ? ` (pid ${pid})` : ''}`
			: `daemon: started but socket not yet connected${
					lastError ? ` (${lastError})` : ''
				}`,
	);

	return {
		ok: true,
		connected,
		...(pid !== undefined ? {pid} : {}),
		message: connected
			? 'started, socket verified'
			: 'started, socket not yet verified',
	};
}

async function defaultStopRuntimeDaemon(
	opts: {timeoutMs?: number} = {},
): Promise<RuntimeDaemonStopResult> {
	const paths = daemonStatePaths();
	const existing = readPidLock(paths.pidPath);
	if (existing.state !== 'held') {
		return {ok: true, wasRunning: false, message: 'daemon not running'};
	}
	try {
		const reply = await sendUdsRequest(
			paths.socketPath,
			{cmd: 'stop', reason: 'cli-stop'},
			{timeoutMs: opts.timeoutMs ?? 5_000},
		);
		if (!reply.ok) {
			return {ok: false, wasRunning: true, message: reply.error};
		}
	} catch (err) {
		return {
			ok: false,
			wasRunning: true,
			message: err instanceof Error ? err.message : String(err),
		};
	}
	// Wait for the lock to be released so callers know the previous daemon is
	// fully gone before they restart.
	const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
	while (Date.now() < deadline) {
		const after = readPidLock(paths.pidPath);
		if (after.state !== 'held') {
			return {ok: true, wasRunning: true};
		}
		await new Promise(r => setTimeout(r, 100));
	}
	return {ok: false, wasRunning: true, message: 'daemon did not exit in time'};
}

async function defaultQueryRuntimeDaemon(
	req: UdsRequest,
): Promise<UdsResponse> {
	const paths = daemonStatePaths();
	const existing = readPidLock(paths.pidPath);
	if (existing.state !== 'held') {
		return {ok: false, error: 'daemon not running'};
	}
	return await sendUdsRequest(paths.socketPath, req);
}

async function defaultTailDaemonLog(opts: {
	tail: number;
	follow: boolean;
}): Promise<number> {
	const paths = daemonStatePaths();
	let stream: fs.ReadStream | null = null;
	let watcher: fs.FSWatcher | null = null;
	try {
		const stat = fs.statSync(paths.logPath);
		const size = stat.size;
		const buf = Buffer.alloc(Math.min(size, opts.tail * 1024));
		const fd = fs.openSync(paths.logPath, 'r');
		try {
			fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
		} finally {
			fs.closeSync(fd);
		}
		const lines = buf
			.toString('utf-8')
			.split('\n')
			.filter(l => l.length > 0);
		const tail = lines.slice(-opts.tail);
		for (const line of tail) {
			process.stdout.write(line + '\n');
		}
		if (!opts.follow) return 0;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			process.stderr.write(
				`dashboard logs: log file ${paths.logPath} does not exist yet\n`,
			);
			return opts.follow ? 0 : 1;
		}
		throw err;
	}

	let position = fs.statSync(paths.logPath).size;
	return await new Promise<number>(resolve => {
		let pollTimer: NodeJS.Timeout | null = null;
		const drain = (): void => {
			try {
				const stat = fs.statSync(paths.logPath);
				if (stat.size < position) {
					// rotated — start from the new file's beginning
					position = 0;
				}
				if (stat.size > position) {
					const fd = fs.openSync(paths.logPath, 'r');
					const buf = Buffer.alloc(stat.size - position);
					try {
						fs.readSync(fd, buf, 0, buf.length, position);
					} finally {
						fs.closeSync(fd);
					}
					position = stat.size;
					process.stdout.write(buf);
				}
			} catch (err) {
				// ENOENT during rotation is expected; surface anything else.
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
					process.stderr.write(
						`dashboard logs: tail error: ${
							err instanceof Error ? err.message : String(err)
						}\n`,
					);
				}
			}
		};
		try {
			watcher = fs.watch(paths.logPath, {persistent: true}, () => {
				drain();
			});
		} catch {
			// fs.watch may fail on certain filesystems; fall back to polling
			pollTimer = setInterval(drain, 500);
			pollTimer.unref?.();
		}
		const onSignal = (): void => {
			if (watcher) {
				watcher.close();
				watcher = null;
			}
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			if (stream) {
				stream.close();
				stream = null;
			}
			resolve(0);
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);
	});
}

function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '?';
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3_600) {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		return s > 0 ? `${m}m${s}s` : `${m}m`;
	}
	if (seconds < 86_400) {
		const h = Math.floor(seconds / 3_600);
		const m = Math.floor((seconds % 3_600) / 60);
		return m > 0 ? `${h}h${m}m` : `${h}h`;
	}
	const d = Math.floor(seconds / 86_400);
	const h = Math.floor((seconds % 86_400) / 3_600);
	return h > 0 ? `${d}d${h}h` : `${d}d`;
}

type FetchedRunnerHealth = {
	id: string;
	matches: boolean;
	executionTarget?: string;
	remoteInstanceId?: string;
	error?: string;
};

async function fetchRunnerHealth(
	fetchImpl: typeof fetch,
	dashboardUrl: string,
	runnerId: string,
	token: DashboardAccessToken,
): Promise<FetchedRunnerHealth> {
	const url = new URL(
		`/api/runners/${encodeURIComponent(runnerId)}`,
		dashboardUrl,
	).toString();
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: 'GET',
			headers: {
				authorization: `Bearer ${token.accessToken}`,
				accept: 'application/json',
			},
		});
	} catch (err) {
		return {
			id: runnerId,
			matches: false,
			error: `request failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
	if (!response.ok) {
		return {
			id: runnerId,
			matches: false,
			error: `dashboard returned ${response.status}`,
		};
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch (err) {
		return {
			id: runnerId,
			matches: false,
			error: `invalid response body: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
	const obj =
		typeof body === 'object' && body !== null
			? (body as Record<string, unknown>)
			: {};
	const executionTarget =
		typeof obj['executionTarget'] === 'string'
			? (obj['executionTarget'] as string)
			: undefined;
	const remoteInstanceId =
		typeof obj['remoteInstanceId'] === 'string'
			? (obj['remoteInstanceId'] as string)
			: undefined;
	const matches =
		executionTarget === 'remote' && remoteInstanceId === token.instanceId;
	const reasons: string[] = [];
	if (executionTarget !== 'remote') {
		reasons.push(
			`executionTarget=${executionTarget ?? 'unset'} (expected "remote")`,
		);
	}
	if (remoteInstanceId !== token.instanceId) {
		reasons.push(
			`remoteInstanceId=${remoteInstanceId ?? 'unset'} (expected "${token.instanceId}")`,
		);
	}
	return {
		id: runnerId,
		matches,
		...(executionTarget !== undefined ? {executionTarget} : {}),
		...(remoteInstanceId !== undefined ? {remoteInstanceId} : {}),
		...(reasons.length > 0 ? {error: reasons.join('; ')} : {}),
	};
}

function defaultInstallServiceUnit(): ServiceInstallResult {
	const entry = resolveDaemonEntry();
	if (!entry) {
		return {
			ok: false,
			platform: 'unsupported',
			message: 'cannot resolve dashboard-daemon.js entry path',
		};
	}
	return installServiceUnit({
		daemonEntry: entry,
		nodeBinary: process.execPath,
	});
}

function compareSemver(a: string, b: string): number {
	const parseN = (s: string): [number, number, number] => {
		const parts = s.replace(/^v/, '').split('-')[0]!.split('.');
		return [
			Number.parseInt(parts[0] ?? '0', 10) || 0,
			Number.parseInt(parts[1] ?? '0', 10) || 0,
			Number.parseInt(parts[2] ?? '0', 10) || 0,
		];
	};
	const av = parseN(a);
	const bv = parseN(b);
	for (let i = 0; i < 3; i += 1) {
		if (av[i]! < bv[i]!) return -1;
		if (av[i]! > bv[i]!) return 1;
	}
	return 0;
}

function consoleBrokerUrl(dashboardUrl: string, runnerId: string): string {
	const url = new URL(dashboardUrl);
	if (url.protocol === 'https:') url.protocol = 'wss:';
	else if (url.protocol === 'http:') url.protocol = 'ws:';
	else throw new Error(`unsupported dashboard protocol: ${url.protocol}`);
	url.pathname = `/api/runners/${encodeURIComponent(runnerId)}/console/adapter`;
	url.search = '';
	url.hash = '';
	return url.toString();
}

async function safeReadError(response: Response): Promise<string> {
	try {
		const text = await response.text();
		if (text.length === 0) return '';
		try {
			const parsed = JSON.parse(text) as unknown;
			if (
				typeof parsed === 'object' &&
				parsed !== null &&
				typeof (parsed as Record<string, unknown>)['error'] === 'string'
			) {
				return (parsed as Record<string, string>)['error']!;
			}
		} catch {
			// fall through to raw text
		}
		return text.length > 200 ? text.slice(0, 200) + '…' : text;
	} catch {
		return '';
	}
}

function parsePairResponse(raw: unknown): PairResponse {
	if (typeof raw !== 'object' || raw === null) {
		throw new Error('expected object');
	}
	const obj = raw as Record<string, unknown>;
	const instanceId = obj['instanceId'];
	const refreshToken = obj['refreshToken'];
	if (typeof instanceId !== 'string' || instanceId.length === 0) {
		throw new Error('missing instanceId');
	}
	if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
		throw new Error('missing refreshToken');
	}
	return {
		instanceId,
		refreshToken,
		...(typeof obj['jti'] === 'string' ? {jti: obj['jti'] as string} : {}),
		...(typeof obj['accessToken'] === 'string'
			? {accessToken: obj['accessToken'] as string}
			: {}),
		...(typeof obj['expiresInSec'] === 'number'
			? {expiresInSec: obj['expiresInSec'] as number}
			: {}),
		...(Array.isArray(obj['runners'])
			? {
					runners: obj['runners']
						.map(parsePairedRunner)
						.filter((runner): runner is PairedRunner => runner !== null),
				}
			: {}),
		...(typeof obj['requiredCliVersion'] === 'string'
			? {requiredCliVersion: obj['requiredCliVersion'] as string}
			: {}),
		...(typeof obj['capabilityAck'] === 'object' &&
		obj['capabilityAck'] !== null
			? {capabilityAck: parseCapabilityAck(obj['capabilityAck'])}
			: {}),
	};
}

function parseCapabilityAck(raw: unknown): CapabilityAck {
	if (typeof raw !== 'object' || raw === null) return {};
	const obj = raw as Record<string, unknown>;
	const ack: CapabilityAck = {};
	if (typeof obj['runtimeDaemon'] === 'boolean') {
		ack.runtimeDaemon = obj['runtimeDaemon'] as boolean;
	}
	if (typeof obj['consoleAdapter'] === 'boolean') {
		ack.consoleAdapter = obj['consoleAdapter'] as boolean;
	}
	if (typeof obj['instanceSocket'] === 'boolean') {
		ack.instanceSocket = obj['instanceSocket'] as boolean;
	}
	return ack;
}

function parsePairedRunner(raw: unknown): PairedRunner | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	const runnerId = obj['runnerId'];
	if (typeof runnerId !== 'string' || runnerId.length === 0) return null;
	return {
		runnerId,
		...(typeof obj['name'] === 'string' ? {name: obj['name'] as string} : {}),
		...(typeof obj['executionTarget'] === 'string'
			? {executionTarget: obj['executionTarget'] as string}
			: {}),
		...(typeof obj['remoteInstanceId'] === 'string'
			? {remoteInstanceId: obj['remoteInstanceId'] as string}
			: {}),
	};
}
