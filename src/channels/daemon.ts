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
export {CHANNEL_BROADCAST_SESSION_ID};

type Args = {
	channel: string;
	entry: string;
	socket: string;
	childArgs: string[];
	idleTimeoutMs: number;
};

type SessionSocket = net.Socket & {sessionId?: string};

export function fanoutEventToSessions(
	event: ChannelEventMessage,
	sessionIds: Iterable<string>,
): ChannelEventMessage[] {
	return [...sessionIds].map(sessionId => ({...event, session_id: sessionId}));
}

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

	constructor(private readonly args: Args) {}

	async start(): Promise<void> {
		await this.prepareSocket();
		const server = net.createServer(socket => this.accept(socket));
		server.on('error', err => {
			console.error(
				`[athena:channel-daemon:${this.args.channel}] ${err.message}`,
			);
			process.exit(1);
		});
		server.listen(this.args.socket);
	}

	private accept(socket: SessionSocket): void {
		this.clearIdleTimer();
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
		for (const line of reader.push(chunk)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				this.sendToSocket(socket, {
					session_id: socket.sessionId ?? 'unknown',
					event: 'error',
					params: {message: 'invalid JSON line'},
				});
				continue;
			}
			const result = parseMethodMessage(parsed);
			if (!result.ok) {
				this.sendToSocket(socket, {
					session_id: socket.sessionId ?? 'unknown',
					event: 'error',
					params: {message: `invalid method message: ${result.reason}`},
				});
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
			this.sendToSocket(socket, {
				session_id: message.session_id,
				event: 'error',
				params: {message: 'channel subprocess is not initialized'},
			});
			return;
		}
		this.writeToChild(message);
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
		this.firstInit = init;
		this.child = spawn(
			process.execPath,
			this.args.childArgs.length > 0 ? this.args.childArgs : [this.args.entry],
			{
				stdio: ['pipe', 'pipe', 'pipe'],
				env: process.env,
			},
		);
		this.child.stdout?.on('data', chunk => {
			for (const line of this.childReader.push(chunk as Buffer)) {
				this.dispatchChildLine(line);
			}
		});
		this.child.stderr?.on('data', chunk => {
			for (const line of this.childStderrReader.push(chunk as Buffer)) {
				this.broadcast({
					session_id: init.session_id,
					event: 'error',
					params: {message: line},
				});
			}
		});
		this.child.on('exit', (code, signal) => {
			this.child = null;
			this.broadcast({
				session_id: init.session_id,
				event: 'error',
				params: {
					message: `channel subprocess exited (code=${code} signal=${signal})`,
					fatal: true,
				},
			});
		});
		this.child.stdin?.on('error', err => {
			this.broadcast({
				session_id: init.session_id,
				event: 'error',
				params: {message: `channel stdin error: ${err.message}`},
			});
		});
		this.writeToChild(init);
	}

	private writeToChild(message: ChannelMethodMessage): void {
		if (!this.child?.stdin || this.child.stdin.destroyed) return;
		this.child.stdin.write(encodeLine(message));
	}

	private dispatchChildLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.broadcast({
				session_id: this.firstInit?.session_id ?? 'unknown',
				event: 'error',
				params: {message: `invalid child JSON line: ${line.slice(0, 200)}`},
			});
			return;
		}
		const result = parseEventMessage(parsed);
		if (!result.ok) {
			this.broadcast({
				session_id: this.firstInit?.session_id ?? 'unknown',
				event: 'error',
				params: {message: `invalid child event: ${result.reason}`},
			});
			return;
		}
		this.routeEvent(result.value);
	}

	private routeEvent(event: ChannelEventMessage): void {
		if (event.session_id === CHANNEL_BROADCAST_SESSION_ID) {
			for (const expanded of expandBroadcastEvent(
				event,
				this.sessions.keys(),
			)) {
				const sockets = this.sessions.get(expanded.session_id);
				if (!sockets) continue;
				for (const socket of sockets) this.sendToSocket(socket, expanded);
			}
			return;
		}
		const sockets = this.sessions.get(event.session_id);
		if (!sockets) return;
		for (const socket of sockets) this.sendToSocket(socket, event);
	}

	private broadcast(event: ChannelEventMessage): void {
		for (const expanded of fanoutEventToSessions(event, this.sessions.keys())) {
			const sockets = this.sessions.get(expanded.session_id);
			if (!sockets) continue;
			for (const socket of sockets) this.sendToSocket(socket, expanded);
		}
	}

	private sendToSocket(socket: net.Socket, event: ChannelEventMessage): void {
		if (!socket.destroyed) socket.write(encodeLine(event));
	}

	private scheduleIdleExit(): void {
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
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
