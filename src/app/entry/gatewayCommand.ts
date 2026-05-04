import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	connect,
	type ControlClient,
	GatewayUnauthorizedError,
	GatewayUnreachableError,
} from '../../gateway/control/client';
import {rotateGatewayToken} from '../../gateway/auth';
import {resolveGatewayPaths} from '../../gateway/paths';
import {
	createWsClientTransport,
	wsClientOptionsForEndpoint,
} from '../../gateway/transport/wsClient';
import {
	readGatewayClientConfig,
	writeGatewayClientConfig,
} from '../../infra/config/gatewayClient';
import type {
	PingResponsePayload,
	RuntimeEndpoint,
	StatusResponsePayload,
} from '../../shared/gateway-protocol';
import {isSupportedGatewayUrl} from '../../shared/gateway-protocol';
import {formatElapsed} from '../../shared/utils/formatElapsed';

const USAGE = `Usage: athena-flow gateway <subcommand> [--json]

Subcommands:
  start     Run the gateway daemon in foreground (only mode in this build).
            Options: [--bind <host:port>] [--insecure]
                     [--tls-cert <path>] [--tls-key <path>]
                     [--grace-period-ms <n>]
  status    Print daemon pid, uptime, and version.
  probe     Send a ping RPC and report reachability + latency.
  link      Store a remote WS/WSS gateway endpoint for this user.
  unlink    Restore local UDS gateway mode for this user.
  rotate-token  Regenerate the gateway token file (server-side).
                Restart the daemon to drop existing connections; clients
                must re-run "athena gateway link --token <new>".
`;

export type GatewayCommandInput = {
	subcommand: string;
	subcommandArgs: string[];
};

export type GatewayCommandDeps = {
	logOut?: (message: string) => void;
	logError?: (message: string) => void;
	resolveDaemonEntry?: () => string;
	resolveSocketPath?: () => string;
	resolveTokenPath?: () => string;
	readClientConfig?: () => RuntimeEndpoint;
	writeClientConfig?: (config: RuntimeEndpoint) => void;
	connectGateway?: (
		opts: GatewayCommandConnectOptions,
	) => Promise<ControlClient>;
	spawnDaemon?: (entry: string, args: string[]) => ChildProcess;
};

export type GatewayCommandConnectOptions = {
	endpoint: RuntimeEndpoint;
	socketPath: string;
	tokenPath: string;
	timeoutMs: number;
};

function defaultResolveDaemonEntry(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, 'athena-gateway.js');
}

function readToken(tokenPath: string): string {
	try {
		return fs.readFileSync(tokenPath, 'utf-8').trim();
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			throw new Error(
				`gateway token missing at ${tokenPath}. ` +
					`Start the daemon with "athena gateway start" first.`,
			);
		}
		throw err;
	}
}

function flagJson(args: string[]): boolean {
	return args.includes('--json');
}

export async function runGatewayCommand(
	input: GatewayCommandInput,
	deps: GatewayCommandDeps = {},
): Promise<number> {
	const logOut = deps.logOut ?? ((m: string) => process.stdout.write(m + '\n'));
	const logError =
		deps.logError ?? ((m: string) => process.stderr.write(m + '\n'));
	const resolveDaemonEntry =
		deps.resolveDaemonEntry ?? defaultResolveDaemonEntry;
	const resolveSocketPath =
		deps.resolveSocketPath ?? (() => resolveGatewayPaths().socketPath);
	const resolveTokenPath =
		deps.resolveTokenPath ?? (() => resolveGatewayPaths().tokenPath);
	const readClientConfig = deps.readClientConfig ?? readGatewayClientConfig;
	const writeClientConfig =
		deps.writeClientConfig ?? (config => writeGatewayClientConfig(config));
	const connectGateway = deps.connectGateway ?? defaultConnectGateway;
	const spawnDaemon =
		deps.spawnDaemon ??
		((entry: string, args: string[]) =>
			spawn(process.execPath, [entry, ...args], {stdio: 'inherit'}));

	const {subcommand, subcommandArgs} = input;

	if (!subcommand || subcommand === 'help' || subcommand === '--help') {
		logOut(USAGE);
		return 0;
	}

	if (subcommand === 'start') {
		// M1: foreground is the only mode; the spawn indirection here is a
		// stub — M8 will reuse it for `spawn(detached: true)` background mode
		// plus launchd/systemd install. For now it costs an extra Node startup
		// but isolates the daemon's lifecycle from the CLI process.
		const entry = resolveDaemonEntry();
		const child = spawnDaemon(entry, subcommandArgs);
		return await new Promise<number>(resolve => {
			child.once('exit', code => resolve(code ?? 0));
			child.once('error', err => {
				logError(`gateway start: failed to spawn daemon: ${err.message}`);
				resolve(1);
			});
		});
	}

	if (subcommand === 'link') {
		const parsed = parseLinkArgs(subcommandArgs);
		if (!parsed.ok) {
			logError(parsed.message);
			return 2;
		}
		writeClientConfig({
			mode: 'remote',
			url: parsed.url,
			token: parsed.token,
			...(parsed.tlsCaPath !== undefined ? {tlsCaPath: parsed.tlsCaPath} : {}),
		});
		logOut(`gateway: linked remote endpoint ${parsed.url}`);
		return 0;
	}

	if (subcommand === 'rotate-token') {
		const json = flagJson(subcommandArgs);
		const extras = subcommandArgs.filter(a => a !== '--json');
		if (extras.length > 0) {
			logError(`gateway rotate-token: unexpected argument ${extras[0]}`);
			return 2;
		}
		const tokenPath = resolveTokenPath();
		try {
			const newToken = rotateGatewayToken(tokenPath);
			if (json) {
				logOut(JSON.stringify({ok: true, token: newToken, tokenPath}));
			} else {
				logOut(newToken);
				logOut(
					`gateway: rotated token at ${tokenPath}. Restart the daemon to drop existing connections, then re-run "athena gateway link --token <new>" on each client.`,
				);
			}
			return 0;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (json) {
				logOut(JSON.stringify({ok: false, message}));
			} else {
				logError(`gateway rotate-token: ${message}`);
			}
			return 1;
		}
	}

	if (subcommand === 'unlink') {
		if (subcommandArgs.length > 0) {
			logError('gateway unlink does not accept arguments');
			return 2;
		}
		writeClientConfig({mode: 'local'});
		logOut('gateway: using local gateway endpoint');
		return 0;
	}

	if (subcommand === 'probe') {
		const json = flagJson(subcommandArgs);
		const socketPath = resolveSocketPath();
		const tokenPath = resolveTokenPath();
		const endpoint = readClientConfig();
		const startedAt = Date.now();
		try {
			const client = await connectGateway({
				endpoint,
				socketPath,
				tokenPath,
				timeoutMs: 3_000,
			});
			const res = await client.request<
				Record<string, never>,
				PingResponsePayload
			>('ping', {});
			client.close();
			const latencyMs = Date.now() - startedAt;
			if (json) {
				logOut(
					JSON.stringify({
						ok: true,
						reachable: true,
						latency_ms: latencyMs,
						daemon_pid: res.daemonPid,
						daemon_uptime_ms: res.uptimeMs,
					}),
				);
			} else {
				logOut(
					`gateway: reachable pid=${res.daemonPid} uptime=${res.uptimeMs}ms latency=${latencyMs}ms`,
				);
			}
			return 0;
		} catch (err) {
			return reportProbeFailure(err, json, logOut, logError);
		}
	}

	if (subcommand === 'status') {
		const json = flagJson(subcommandArgs);
		const socketPath = resolveSocketPath();
		const tokenPath = resolveTokenPath();
		const endpoint = readClientConfig();
		try {
			const client = await connectGateway({
				endpoint,
				socketPath,
				tokenPath,
				timeoutMs: 3_000,
			});
			const res = await client.request<
				Record<string, never>,
				StatusResponsePayload
			>('status', {});
			client.close();
			if (json) {
				logOut(JSON.stringify(res));
			} else {
				const runtimeSummary = formatRuntimeSummary(res.runtimes[0]);
				logOut(
					`gateway: running pid=${res.daemonPid} uptime=${res.uptimeMs}ms version=${res.version}${runtimeSummary}`,
				);
			}
			return 0;
		} catch (err) {
			return reportProbeFailure(err, json, logOut, logError);
		}
	}

	logError(`Unknown gateway subcommand: ${subcommand}`);
	logError(USAGE);
	return 2;
}

async function defaultConnectGateway(
	opts: GatewayCommandConnectOptions,
): Promise<ControlClient> {
	if (opts.endpoint.mode === 'remote') {
		return connect({
			socketPath: opts.socketPath,
			token: opts.endpoint.token,
			timeoutMs: opts.timeoutMs,
			transport: createWsClientTransport(
				wsClientOptionsForEndpoint({
					url: opts.endpoint.url,
					timeoutMs: opts.timeoutMs,
					tlsCaPath: opts.endpoint.tlsCaPath,
				}),
			),
		});
	}
	return connect({
		socketPath: opts.socketPath,
		token: readToken(opts.tokenPath),
		timeoutMs: opts.timeoutMs,
	});
}

type LinkArgs =
	| {ok: true; url: string; token: string; tlsCaPath?: string}
	| {ok: false; message: string};

function parseLinkArgs(args: string[]): LinkArgs {
	const positional: string[] = [];
	let token: string | undefined;
	let tlsCaPath: string | undefined;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === '--token') {
			const v = args[i + 1];
			if (!v || v.startsWith('--')) {
				return {ok: false, message: 'gateway link --token requires a value'};
			}
			token = v;
			i += 1;
			continue;
		}
		if (arg === '--tls-ca') {
			const v = args[i + 1];
			if (!v || v.startsWith('--')) {
				return {ok: false, message: 'gateway link --tls-ca requires a path'};
			}
			tlsCaPath = v;
			i += 1;
			continue;
		}
		if (arg.startsWith('--token=')) {
			token = arg.slice('--token='.length);
			continue;
		}
		if (arg.startsWith('--tls-ca=')) {
			tlsCaPath = arg.slice('--tls-ca='.length);
			continue;
		}
		if (arg.startsWith('--')) {
			return {ok: false, message: `gateway link: unknown option ${arg}`};
		}
		positional.push(arg);
	}

	const url = positional[0];
	if (!url) {
		return {ok: false, message: 'gateway link requires a ws:// or wss:// URL'};
	}
	if (positional.length > 1) {
		return {ok: false, message: 'gateway link accepts exactly one URL'};
	}
	if (!isSupportedGatewayUrl(url)) {
		return {ok: false, message: 'gateway link URL must use ws:// or wss://'};
	}
	if (!token) {
		return {ok: false, message: 'gateway link requires --token <token>'};
	}
	if (tlsCaPath !== undefined && tlsCaPath.length === 0) {
		return {ok: false, message: 'gateway link --tls-ca requires a path'};
	}
	return {
		ok: true,
		url,
		token,
		...(tlsCaPath !== undefined ? {tlsCaPath} : {}),
	};
}

function reportProbeFailure(
	err: unknown,
	json: boolean,
	logOut: (m: string) => void,
	logError: (m: string) => void,
): number {
	const message = err instanceof Error ? err.message : String(err);
	if (err instanceof GatewayUnreachableError) {
		if (json) {
			logOut(
				JSON.stringify({
					ok: false,
					reachable: false,
					reason: 'unreachable',
					message,
				}),
			);
		} else {
			logError(`gateway: not reachable — ${message}`);
		}
		return 1;
	}
	if (err instanceof GatewayUnauthorizedError) {
		if (json) {
			logOut(
				JSON.stringify({
					ok: false,
					reachable: true,
					reason: 'unauthorized',
					message,
				}),
			);
		} else {
			logError(`gateway: unauthorized — ${message}`);
		}
		return 1;
	}
	if (json) {
		logOut(JSON.stringify({ok: false, reason: 'error', message}));
	} else {
		logError(`gateway: ${message}`);
	}
	return 1;
}

function formatRuntimeSummary(
	r: StatusResponsePayload['runtimes'][number] | undefined,
): string {
	if (!r) return ' runtime=<none>';
	const lastRebindAt =
		r.binding.state !== 'none' ? r.binding.lastRebindAt : undefined;
	const rebind =
		lastRebindAt !== undefined
			? ` rebound=${formatElapsed(Date.now() - lastRebindAt)}`
			: '';
	return ` runtime=${r.runtimeId} binding=${r.binding.state} pid=${r.pid}${rebind}`;
}
