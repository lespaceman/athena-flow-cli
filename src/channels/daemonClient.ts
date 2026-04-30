import {spawn, type ChildProcess} from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import {encodeLine, LineReader, parseEventMessage} from './protocol';
import {channelDaemonSocketPath} from './daemonPaths';
import type {
	ChannelDefinition,
	ChannelEventMessage,
	ChannelMethodMessage,
} from './types';

type SocketLike = {
	destroyed: boolean;
	write: (chunk: string) => void;
	end: () => void;
	destroy: () => void;
	on: (event: string, listener: (...args: unknown[]) => void) => SocketLike;
	once: (event: string, listener: (...args: unknown[]) => void) => SocketLike;
	removeListener: (
		event: string,
		listener: (...args: unknown[]) => void,
	) => SocketLike;
};

export type ChannelDaemonClientHandlers = {
	onEvent: (event: ChannelEventMessage) => void;
	onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
	onError: (message: string) => void;
};

export type ChannelDaemonClientDeps = {
	connect?: (socketPath: string, onConnect: () => void) => SocketLike;
	spawnDaemon?: (definition: ChannelDefinition, socketPath: string) => void;
	socketPath?: (channelName: string) => string;
	retryDelayMs?: number;
};

export type ChannelDaemonClientOptions = {
	definition: ChannelDefinition;
	sessionId: string;
	handlers: ChannelDaemonClientHandlers;
	deps?: ChannelDaemonClientDeps;
};

const daemonStarts = new Map<string, Promise<void>>();
const ATTACH_RETRY_ATTEMPTS = 25;
const ATTACH_RETRY_DELAY_MS = 40;

export function clearChannelDaemonRegistry(): void {
	daemonStarts.clear();
}

function isAttachFailure(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException).code;
	return code === 'ENOENT' || code === 'ECONNREFUSED';
}

function defaultConnect(socketPath: string, onConnect: () => void): SocketLike {
	return net.createConnection(socketPath, onConnect);
}

function defaultSpawnDaemon(
	definition: ChannelDefinition,
	socketPath: string,
): void {
	const daemonEntryPath = definition.daemonEntryPath;
	if (!daemonEntryPath) {
		throw new Error(`channel daemon entry missing for ${definition.name}`);
	}
	const child: ChildProcess = spawn(
		process.execPath,
		[
			daemonEntryPath,
			'--channel',
			definition.name,
			'--entry',
			definition.entryPath,
			'--socket',
			socketPath,
			...(definition.args ?? []).flatMap(arg => ['--arg', arg]),
		],
		{
			stdio: 'ignore',
			detached: true,
			env: process.env,
		},
	);
	child.unref();
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + '...' : s;
}

export class ChannelDaemonClient {
	readonly definition: ChannelDefinition;
	private readonly sessionId: string;
	private readonly handlers: ChannelDaemonClientHandlers;
	private readonly deps: Required<ChannelDaemonClientDeps>;
	private socket: SocketLike | null = null;
	private reader = new LineReader();
	private started = false;
	private disposed = false;

	constructor(opts: ChannelDaemonClientOptions) {
		this.definition = opts.definition;
		this.sessionId = opts.sessionId;
		this.handlers = opts.handlers;
		this.deps = {
			connect: opts.deps?.connect ?? defaultConnect,
			spawnDaemon: opts.deps?.spawnDaemon ?? defaultSpawnDaemon,
			socketPath: opts.deps?.socketPath ?? channelDaemonSocketPath,
			retryDelayMs: opts.deps?.retryDelayMs ?? ATTACH_RETRY_DELAY_MS,
		};
	}

	get name(): string {
		return this.definition.name;
	}

	async start(): Promise<void> {
		if (this.started || this.disposed) return;
		this.started = true;
		const socketPath = this.deps.socketPath(this.definition.name);
		try {
			this.socket = await this.attach(socketPath);
		} catch (err) {
			if (!isAttachFailure(err)) throw err;
			await this.ensureDaemonStarted(socketPath);
			this.socket = await this.attachWithRetry(socketPath);
		}
		this.installSocketHandlers(this.socket);
		this.send({
			session_id: this.sessionId,
			method: 'init',
			params: {
				allowed_user_ids: this.definition.allowedUserIds,
				options: this.definition.options ?? {},
			},
		});
	}

	send(message: ChannelMethodMessage): void {
		if (!this.socket || this.socket.destroyed) return;
		try {
			this.socket.write(encodeLine(message));
		} catch (err) {
			this.handlers.onError(
				`daemon write failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (!this.socket) return;
		this.send({session_id: this.sessionId, method: 'shutdown', params: {}});
		this.socket.end();
		this.socket = null;
	}

	private attach(socketPath: string): Promise<SocketLike> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const socket = this.deps.connect(socketPath, () => {
				if (settled) return;
				settled = true;
				socket.removeListener('error', onError);
				resolve(socket);
			});
			const onError = (err: unknown) => {
				if (settled) return;
				settled = true;
				reject(err);
			};
			socket.once('error', onError);
		});
	}

	private async ensureDaemonStarted(socketPath: string): Promise<void> {
		let start = daemonStarts.get(this.definition.name);
		if (!start) {
			start = Promise.resolve().then(() => {
				this.deps.spawnDaemon(this.definition, socketPath);
			});
			daemonStarts.set(this.definition.name, start);
		}
		await start;
	}

	private async attachWithRetry(socketPath: string): Promise<SocketLike> {
		let lastError: unknown;
		for (let attempt = 0; attempt < ATTACH_RETRY_ATTEMPTS; attempt++) {
			try {
				return await this.attach(socketPath);
			} catch (err) {
				if (!isAttachFailure(err)) throw err;
				lastError = err;
				if (attempt < ATTACH_RETRY_ATTEMPTS - 1) {
					await delay(this.deps.retryDelayMs);
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	private installSocketHandlers(socket: SocketLike): void {
		socket.on('data', chunk => {
			for (const line of this.reader.push(String(chunk))) {
				this.dispatchLine(line);
			}
		});
		socket.on('error', err => {
			this.handlers.onError(
				`daemon socket error: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
		socket.on('close', () => {
			if (!this.disposed) this.handlers.onExit(null, null);
		});
	}

	private dispatchLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.handlers.onError(`invalid daemon JSON line: ${truncate(line, 200)}`);
			return;
		}
		const result = parseEventMessage(parsed);
		if (!result.ok) {
			this.handlers.onError(`invalid daemon event: ${result.reason}`);
			return;
		}
		this.handlers.onEvent(result.value);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
