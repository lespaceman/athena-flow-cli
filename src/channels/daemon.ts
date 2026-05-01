#!/usr/bin/env node
/**
 * Process-global channel daemon.
 *
 * One daemon listens on a per-channel Unix socket and owns one channel
 * subprocess. Session-local ChannelRegistry instances attach over the socket;
 * all channel protocol messages carry `session_id`, letting the daemon route
 * replies back to the correct session without starting another poller.
 */

import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {errorMessage} from '../shared/utils/errorMessage';
import {
	CHANNEL_SECRETS_ENV,
	isAuthFrame,
	loadOrCreateChannelAuthToken,
	timingSafeEqualString,
} from './auth';
import {
	encodeLine,
	LineReader,
	parseEventMessage,
	parseMethodMessage,
} from './protocol';
import {
	CHANNEL_BROADCAST_SESSION_ID,
	type ChannelEventMessage,
	type ChannelMethodMessage,
} from './types';

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const UNKNOWN_SESSION_ID = 'unknown';
const BOT_TOKEN_RE = /\/bot\d{6,}:[A-Za-z0-9_-]{20,}/g;

function errorEvent(
	sessionId: string,
	message: string,
	fatal?: boolean,
): ChannelEventMessage {
	return {
		session_id: sessionId,
		event: 'error',
		params: fatal === undefined ? {message} : {message, fatal},
	};
}

export {CHANNEL_BROADCAST_SESSION_ID};

type Args = {
	channel: string;
	entry: string;
	socket: string;
	childArgs: string[];
	idleTimeoutMs: number;
};

type SessionSocket = net.Socket & {sessionId?: string; authed?: boolean};

function readSecretsFromEnv(): Record<string, unknown> {
	const raw = process.env[CHANNEL_SECRETS_ENV];
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// fall through
	}
	return {};
}

/** @internal Exported for tests only. */
export function fanoutEventToSessions(
	event: ChannelEventMessage,
	sessionIds: Iterable<string>,
): ChannelEventMessage[] {
	return [...sessionIds].map(sessionId => ({...event, session_id: sessionId}));
}

/** @internal Exported for tests only. */
export function expandBroadcastEvent(
	event: ChannelEventMessage,
	sessionIds: Iterable<string>,
): ChannelEventMessage[] {
	if (event.session_id !== CHANNEL_BROADCAST_SESSION_ID) return [event];
	return fanoutEventToSessions(event, sessionIds);
}

function parseArgs(argv: string[]): Args {
	let channel = '';
	let entry = '';
	let socket = '';
	const childArgs: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === '--channel' && next) {
			channel = next;
			i++;
		} else if (arg === '--entry' && next) {
			entry = next;
			i++;
		} else if (arg === '--socket' && next) {
			socket = next;
			i++;
		} else if (arg === '--arg' && next) {
			childArgs.push(next);
			i++;
		}
	}
	if (!channel) throw new Error('--channel is required');
	if (!entry) throw new Error('--entry is required');
	if (!socket) throw new Error('--socket is required');
	const idleTimeoutMs = Number(
		process.env['ATHENA_CHANNEL_DAEMON_IDLE_MS'] ?? DEFAULT_IDLE_TIMEOUT_MS,
	);
	return {
		channel,
		entry,
		socket,
		childArgs,
		idleTimeoutMs: Number.isFinite(idleTimeoutMs)
			? Math.max(100, idleTimeoutMs)
			: DEFAULT_IDLE_TIMEOUT_MS,
	};
}

class ChannelDaemon {
	private readonly sessions = new Map<string, Set<SessionSocket>>();
	private readonly socketReaders = new WeakMap<SessionSocket, LineReader>();
	private child: ChildProcess | null = null;
	private childReader = new LineReader();
	private childStderrReader = new LineReader();
	private firstInit: ChannelMethodMessage | null = null;
	private idleTimer: NodeJS.Timeout | null = null;
	private server: net.Server | null = null;
	private readonly authToken: string;
	private readonly secrets: Record<string, unknown>;

	constructor(private readonly args: Args) {
		this.authToken = loadOrCreateChannelAuthToken(this.args.channel);
		this.secrets = readSecretsFromEnv();
		// Don't let secrets leak into the child's env (or anything else we
		// spawn). They will be re-injected into init.params.options instead.
		delete process.env[CHANNEL_SECRETS_ENV];
	}

	async start(): Promise<void> {
		await this.prepareSocket();
		const server = net.createServer(socket => this.accept(socket));
		server.on('error', err => {
			console.error(
				`[athena:channel-daemon:${this.args.channel}] ${err.message}`,
			);
			process.exit(1);
		});
		await new Promise<void>(resolve => {
			server.listen(this.args.socket, () => resolve());
		});
		fs.chmodSync(this.args.socket, 0o600);
		this.server = server;
	}

	private accept(socket: SessionSocket): void {
		this.clearIdleTimer();
		socket.authed = false;
		this.socketReaders.set(socket, new LineReader());
		socket.on('data', chunk => this.handleSocketData(socket, chunk));
		socket.on('close', () => this.detach(socket));
		socket.on('error', () => this.detach(socket));
	}

	private handleSocketData(
		socket: SessionSocket,
		chunk: Buffer | string,
	): void {
		const reader = this.socketReaders.get(socket);
		if (!reader) return;
		const sid = () => socket.sessionId ?? UNKNOWN_SESSION_ID;
		let lines: string[];
		try {
			lines = reader.push(chunk);
		} catch (err) {
			this.sendToSocket(
				socket,
				errorEvent(sid(), `protocol error: ${errorMessage(err)}`),
			);
			socket.destroy();
			this.detach(socket);
			return;
		}
		for (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				this.sendToSocket(socket, errorEvent(sid(), 'invalid JSON line'));
				continue;
			}
			if (!socket.authed) {
				if (
					isAuthFrame(parsed) &&
					timingSafeEqualString(parsed.token, this.authToken)
				) {
					socket.authed = true;
					continue;
				}
				this.sendToSocket(
					socket,
					errorEvent(sid(), 'authentication required', true),
				);
				socket.destroy();
				this.detach(socket);
				return;
			}
			const result = parseMethodMessage(parsed);
			if (!result.ok) {
				this.sendToSocket(
					socket,
					errorEvent(sid(), `invalid method message: ${result.reason}`),
				);
				continue;
			}
			this.handleMethod(socket, result.value);
		}
	}

	private handleMethod(
		socket: SessionSocket,
		message: ChannelMethodMessage,
	): void {
		if (message.method === 'shutdown') {
			this.detach(socket);
			socket.end();
			return;
		}
		this.attach(socket, message.session_id);
		if (message.method === 'init') {
			if (!this.child) this.startChild(message);
			return;
		}
		if (!this.child) {
			this.sendToSocket(
				socket,
				errorEvent(message.session_id, 'channel subprocess unavailable'),
			);
			return;
		}
		this.writeToChild(message, socket);
	}

	private attach(socket: SessionSocket, sessionId: string): void {
		if (socket.sessionId === sessionId) return;
		this.detach(socket);
		socket.sessionId = sessionId;
		let sockets = this.sessions.get(sessionId);
		if (!sockets) {
			sockets = new Set();
			this.sessions.set(sessionId, sockets);
		}
		sockets.add(socket);
	}

	private detach(socket: SessionSocket): void {
		const sessionId = socket.sessionId;
		if (!sessionId) return;
		const sockets = this.sessions.get(sessionId);
		sockets?.delete(socket);
		if (sockets?.size === 0) this.sessions.delete(sessionId);
		socket.sessionId = undefined;
		if (this.totalSockets() === 0) this.scheduleIdleExit();
	}

	private startChild(init: ChannelMethodMessage): void {
		const initWithSecrets = this.injectSecrets(init);
		this.firstInit = initWithSecrets;
		this.child = spawn(
			process.execPath,
			this.args.childArgs.length > 0 ? this.args.childArgs : [this.args.entry],
			{
				stdio: ['pipe', 'pipe', 'pipe'],
				env: process.env,
			},
		);
		this.child.stdout?.on('data', chunk => {
			let lines: string[];
			try {
				lines = this.childReader.push(chunk as Buffer);
			} catch (err) {
				this.broadcast(
					errorEvent(
						init.session_id,
						`child stdout protocol error: ${errorMessage(err)}`,
						true,
					),
				);
				this.child?.kill();
				return;
			}
			for (const line of lines) this.dispatchChildLine(line);
		});
		this.child.stderr?.on('data', chunk => {
			let lines: string[];
			try {
				lines = this.childStderrReader.push(chunk as Buffer);
			} catch {
				return;
			}
			for (const line of lines) {
				this.broadcast(
					errorEvent(
						init.session_id,
						line.replace(BOT_TOKEN_RE, '/bot[REDACTED]'),
					),
				);
			}
		});
		this.child.on('exit', (code, signal) => {
			this.child = null;
			this.broadcast(
				errorEvent(
					init.session_id,
					`channel subprocess exited (code=${code} signal=${signal})`,
					true,
				),
			);
		});
		this.child.stdin?.on('error', err => {
			this.broadcast(
				errorEvent(init.session_id, `channel stdin error: ${err.message}`),
			);
		});
		this.writeToChild(initWithSecrets);
	}

	private injectSecrets(init: ChannelMethodMessage): ChannelMethodMessage {
		if (init.method !== 'init') return init;
		if (Object.keys(this.secrets).length === 0) return init;
		const params = init.params as {options?: Record<string, unknown>};
		const merged: Record<string, unknown> = {
			...(params.options ?? {}),
			...this.secrets,
		};
		return {
			...init,
			params: {...params, options: merged},
		} as ChannelMethodMessage;
	}

	private writeToChild(
		message: ChannelMethodMessage,
		origin?: SessionSocket,
	): void {
		const report = (msg: string): void => {
			const ev = errorEvent(message.session_id, msg);
			if (origin) this.sendToSocket(origin, ev);
			else this.broadcast(ev);
		};
		if (!this.child?.stdin || this.child.stdin.destroyed) {
			report('channel subprocess unavailable');
			return;
		}
		try {
			this.child.stdin.write(encodeLine(message));
		} catch (err) {
			report(`channel stdin write failed: ${errorMessage(err)}`);
		}
	}

	private dispatchChildLine(line: string): void {
		const sid = this.firstInit?.session_id ?? UNKNOWN_SESSION_ID;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.broadcast(
				errorEvent(sid, `invalid child JSON line: ${line.slice(0, 200)}`),
			);
			return;
		}
		const result = parseEventMessage(parsed);
		if (!result.ok) {
			this.broadcast(errorEvent(sid, `invalid child event: ${result.reason}`));
			return;
		}
		this.routeEvent(result.value);
	}

	private routeEvent(event: ChannelEventMessage): void {
		if (event.session_id === CHANNEL_BROADCAST_SESSION_ID) {
			this.broadcast(event);
			return;
		}
		this.deliverToSession(event.session_id, event);
	}

	private broadcast(event: ChannelEventMessage): void {
		// Snapshot keys: sendToSocket → detach can mutate this.sessions.
		for (const sessionId of [...this.sessions.keys()]) {
			this.deliverToSession(sessionId, {...event, session_id: sessionId});
		}
	}

	private deliverToSession(
		sessionId: string,
		event: ChannelEventMessage,
	): void {
		const sockets = this.sessions.get(sessionId);
		if (!sockets) return;
		for (const socket of [...sockets]) this.sendToSocket(socket, event);
	}

	private sendToSocket(socket: net.Socket, event: ChannelEventMessage): void {
		if (!socket.destroyed) socket.write(encodeLine(event));
	}

	private scheduleIdleExit(): void {
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			// Stop accepting new connections first so any client racing the
			// idle timer fails fast (ECONNREFUSED → attachWithRetry) rather
			// than connecting to a daemon about to exit.
			this.server?.close();
			if (this.totalSockets() > 0) return;
			if (this.child && this.firstInit) {
				this.writeToChild({
					session_id: this.firstInit.session_id,
					method: 'shutdown',
					params: {},
				});
			}
			process.exit(0);
		}, this.args.idleTimeoutMs);
	}

	private clearIdleTimer(): void {
		if (!this.idleTimer) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	private totalSockets(): number {
		let total = 0;
		for (const sockets of this.sessions.values()) total += sockets.size;
		return total;
	}

	private async prepareSocket(): Promise<void> {
		fs.mkdirSync(path.dirname(this.args.socket), {
			recursive: true,
			mode: 0o700,
		});
		if (!fs.existsSync(this.args.socket)) return;
		const alive = await new Promise<boolean>(resolve => {
			const probe = net.createConnection(this.args.socket, () => {
				probe.end();
				resolve(true);
			});
			probe.once('error', () => resolve(false));
		});
		if (!alive) fs.unlinkSync(this.args.socket);
	}
}

async function main(): Promise<void> {
	const daemon = new ChannelDaemon(parseArgs(process.argv.slice(2)));
	await daemon.start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	void main().catch(err => {
		console.error(
			`[athena:channel-daemon] ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	});
}
