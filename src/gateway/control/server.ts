/**
 * UDS NDJSON server for the gateway control plane.
 *
 * Wire protocol (one JSON object per line, terminated by `\n`):
 *
 *   1. First frame from client must be:
 *        {"kind":"connect","token":"<bearer>"}
 *      The server replies with either:
 *        {"ok":true,"hello":{"daemonPid":N,"startedAt":N}}    or
 *        {"ok":false,"error":{"code":"unauthorized","message":"..."}}
 *
 *   2. Subsequent frames are `ControlEnvelope`s; each gets a
 *      `ControlResponseEnvelope` reply correlated by `request_id`. The
 *      server may also push `ControlPushEnvelope`s to the connection when
 *      the daemon has unsolicited events (e.g. `session.dispatch.turn`).
 *
 * Filesystem ACL is the primary authentication boundary (UDS path in a 0700
 * dir, socket file 0600); the token in the connect frame is a defense-in-
 * depth check against socket leaks.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type {
	ControlEnvelope,
	ControlPushEnvelope,
	ControlResponseEnvelope,
} from '../../shared/gateway-protocol';
import {timingSafeTokenEqual} from '../auth';
import {encodeLine, LineReader, LineReaderOverflowError} from './lineReader';

const CONNECT_TIMEOUT_MS = 2_000;

export type ConnectionContext = {
	/** Process-unique id for this connection. */
	connectionId: string;
	/** Push an unsolicited frame to the connected peer. */
	push: (envelope: ControlPushEnvelope) => void;
	/** Force-close the connection (e.g. when the runtime unregisters). */
	disconnect: () => void;
};

export type RequestHandler = (
	envelope: ControlEnvelope,
	connection: ConnectionContext,
) => Promise<ControlResponseEnvelope> | ControlResponseEnvelope;

export type ControlServerOptions = {
	socketPath: string;
	token: string;
	startedAt: number;
	handler: RequestHandler;
	/** Notified when a connection authenticates. */
	onConnect?: (ctx: ConnectionContext) => void;
	/** Notified when a connection closes (after auth or otherwise). */
	onDisconnect?: (ctx: ConnectionContext) => void;
	/** Override stderr for tests. */
	logError?: (message: string) => void;
};

export type ControlServer = {
	close: () => Promise<void>;
};

function isStringRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nowError(
	requestId: string,
	code: string,
	message: string,
): ControlResponseEnvelope {
	return {
		request_id: requestId,
		ts: Date.now(),
		ok: false,
		error: {code, message},
	};
}

let connectionCounter = 0;
function nextConnectionId(): string {
	connectionCounter = (connectionCounter + 1) >>> 0;
	return `c${connectionCounter}-${process.pid}`;
}

export async function startControlServer(
	opts: ControlServerOptions,
): Promise<ControlServer> {
	const {socketPath, token, startedAt, handler} = opts;
	const logError =
		opts.logError ?? ((m: string) => process.stderr.write(m + '\n'));

	await unlinkIfStale(socketPath);
	fs.mkdirSync(path.dirname(socketPath), {recursive: true, mode: 0o700});

	const activeSockets = new Set<net.Socket>();
	const server = net.createServer({pauseOnConnect: false}, socket => {
		activeSockets.add(socket);
		socket.once('close', () => activeSockets.delete(socket));
		handleConnection(
			socket,
			token,
			startedAt,
			handler,
			logError,
			opts.onConnect,
			opts.onDisconnect,
		);
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => reject(err);
		server.once('error', onError);
		server.listen(socketPath, () => {
			server.off('error', onError);
			try {
				if (process.platform !== 'win32') {
					fs.chmodSync(socketPath, 0o600);
				}
			} catch (err) {
				logError(
					`gateway: chmod 0600 on socket failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
			resolve();
		});
	});

	return {
		close: () =>
			new Promise<void>(resolve => {
				// `server.close()` only fires its callback once all sockets close.
				// In-flight handlers (e.g. a long-poll relay waiting on a human)
				// keep client sockets alive indefinitely, so we destroy them
				// explicitly to bound shutdown time.
				for (const socket of activeSockets) {
					socket.destroy();
				}
				activeSockets.clear();
				server.close(() => {
					try {
						fs.unlinkSync(socketPath);
					} catch {
						// best-effort
					}
					resolve();
				});
			}),
	};
}

async function unlinkIfStale(socketPath: string): Promise<void> {
	if (!fs.existsSync(socketPath)) return;
	const alive = await new Promise<boolean>(resolve => {
		const probe = net.connect(socketPath);
		const timer = setTimeout(() => {
			probe.destroy();
			resolve(false);
		}, 250);
		probe.once('connect', () => {
			clearTimeout(timer);
			probe.end();
			resolve(true);
		});
		probe.once('error', () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
	if (!alive) {
		try {
			fs.unlinkSync(socketPath);
		} catch {
			// best-effort
		}
	}
}

function handleConnection(
	socket: net.Socket,
	expectedToken: string,
	startedAt: number,
	handler: RequestHandler,
	logError: (m: string) => void,
	onConnect?: (ctx: ConnectionContext) => void,
	onDisconnect?: (ctx: ConnectionContext) => void,
): void {
	let authed = false;
	const reader = new LineReader();
	const connectTimer = setTimeout(() => {
		socket.destroy();
	}, CONNECT_TIMEOUT_MS);

	const writeLine = (line: string): void => {
		if (!socket.writable) return;
		socket.write(line);
	};

	const ctx: ConnectionContext = {
		connectionId: nextConnectionId(),
		push: env => writeLine(encodeLine(env)),
		disconnect: () => socket.destroy(),
	};

	socket.on('data', chunk => {
		let lines: string[];
		try {
			lines = reader.push(chunk);
		} catch (err) {
			if (err instanceof LineReaderOverflowError) {
				logError(`gateway: control connection overflow — closing`);
			}
			socket.destroy();
			return;
		}

		for (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				socket.destroy();
				return;
			}
			if (!isStringRecord(parsed)) {
				socket.destroy();
				return;
			}

			if (!authed) {
				if (parsed['kind'] !== 'connect') {
					socket.destroy();
					return;
				}
				const tok = parsed['token'];
				if (
					typeof tok !== 'string' ||
					!timingSafeTokenEqual(tok, expectedToken)
				) {
					writeLine(
						encodeLine({
							ok: false,
							error: {code: 'unauthorized', message: 'invalid token'},
						}),
					);
					socket.end();
					return;
				}
				authed = true;
				clearTimeout(connectTimer);
				writeLine(
					encodeLine({
						ok: true,
						hello: {daemonPid: process.pid, startedAt},
					}),
				);
				onConnect?.(ctx);
				continue;
			}

			const requestId =
				typeof parsed['request_id'] === 'string'
					? (parsed['request_id'] as string)
					: '';
			if (
				typeof parsed['kind'] !== 'string' ||
				typeof parsed['ts'] !== 'number' ||
				!('payload' in parsed) ||
				requestId.length === 0
			) {
				writeLine(
					encodeLine(nowError(requestId, 'bad_request', 'malformed envelope')),
				);
				continue;
			}
			void Promise.resolve()
				.then(() => handler(parsed as ControlEnvelope, ctx))
				.then(res => writeLine(encodeLine(res)))
				.catch((err: unknown) =>
					writeLine(
						encodeLine(
							nowError(
								requestId,
								'handler_error',
								err instanceof Error ? err.message : String(err),
							),
						),
					),
				);
		}
	});

	socket.on('error', err => {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== 'EPIPE' && code !== 'ECONNRESET') {
			logError(`gateway: socket error: ${err.message}`);
		}
	});

	socket.on('close', () => {
		clearTimeout(connectTimer);
		if (authed) {
			onDisconnect?.(ctx);
		}
	});
}
