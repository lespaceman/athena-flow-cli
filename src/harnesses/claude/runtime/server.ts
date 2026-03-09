/**
 * UDS server for receiving Claude hook events via NDJSON.
 *
 * This module encapsulates all network I/O and NDJSON protocol handling.
 * It is the ONLY place that reads/writes to Unix Domain Sockets.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {cleanupStaleSockets} from './cleanupStaleSockets';
import type {HookResultEnvelope} from '../protocol/envelope';
import {isValidHookEventEnvelope} from '../protocol/envelope';
import type {HookEventEnvelope} from '../protocol/envelope';
import type {HookResultPayload} from '../protocol/result';
import type {
	RuntimeEvent,
	RuntimeDecision,
	RuntimeEventHandler,
	RuntimeDecisionHandler,
	RuntimeStartupError,
	RuntimeStartupErrorCode,
} from '../../../core/runtime/types';
import type {RuntimeConnector} from '../../../core/runtime/connector';
import {mapEnvelopeToRuntimeEvent} from './mapper';
import {mapDecisionToResult} from './decisionMapper';

type PendingRequest = {
	event: RuntimeEvent;
	socket: net.Socket;
	timer: ReturnType<typeof setTimeout> | undefined;
};

type ServerOptions = {
	projectDir: string;
	instanceId: number;
};

const MAX_UNIX_SOCKET_PATH_BYTES = {
	darwin: 103,
	default: 107,
} as const;

function makeStartupError(
	code: RuntimeStartupErrorCode,
	message: string,
): RuntimeStartupError {
	return {code, message};
}

function getSocketPathLimit(): number {
	return process.platform === 'darwin'
		? MAX_UNIX_SOCKET_PATH_BYTES.darwin
		: MAX_UNIX_SOCKET_PATH_BYTES.default;
}

export function createServer(opts: ServerOptions) {
	const {projectDir, instanceId} = opts;
	const pending = new Map<string, PendingRequest>();
	const handlers = new Set<RuntimeEventHandler>();
	const decisionHandlers = new Set<RuntimeDecisionHandler>();
	let server: net.Server | null = null;
	let status: 'stopped' | 'running' = 'stopped';
	let socketPath = '';
	let lastError: RuntimeStartupError | null = null;

	function emit(event: RuntimeEvent): void {
		for (const handler of handlers) {
			try {
				handler(event);
			} catch (err) {
				console.error(
					`[athena] handler error processing ${event.hookName}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
	}

	function notifyDecision(eventId: string, decision: RuntimeDecision): void {
		for (const handler of decisionHandlers) {
			try {
				handler(eventId, decision);
			} catch (err) {
				console.error(
					'[athena] decision handler error:',
					err instanceof Error ? err.message : err,
				);
			}
		}
	}

	function respondToForwarder(
		requestId: string,
		resultPayload: HookResultPayload,
	): void {
		const req = pending.get(requestId);
		if (!req) return;

		if (req.timer) clearTimeout(req.timer);

		const envelope: HookResultEnvelope = {
			request_id: requestId,
			ts: Date.now(),
			payload: resultPayload,
		};

		try {
			req.socket.write(JSON.stringify(envelope) + '\n');
			req.socket.end();
		} catch {
			// Socket may already be closed
		}

		pending.delete(requestId);
	}

	const connector: RuntimeConnector = {
		start(): void {
			const socketDir = path.join(projectDir, '.claude', 'run');
			socketPath = path.join(socketDir, `ink-${instanceId}.sock`);
			lastError = null;

			if (Buffer.byteLength(socketPath) > getSocketPathLimit()) {
				status = 'stopped';
				lastError = makeStartupError(
					'socket_path_too_long',
					`Socket path is too long for ${process.platform}: ${socketPath}`,
				);
				console.error(
					`[athena] hook server failed to start on ${socketPath}: ${lastError.message}`,
				);
				return;
			}

			try {
				fs.mkdirSync(socketDir, {recursive: true});
			} catch (error) {
				status = 'stopped';
				lastError = makeStartupError(
					'socket_dir_unavailable',
					error instanceof Error ? error.message : String(error),
				);
				console.error(
					`[athena] hook server failed to create socket dir ${socketDir}: ${lastError.message}`,
				);
				return;
			}
			// Sweep stale sockets from previous crashed processes
			cleanupStaleSockets(socketDir);
			try {
				fs.unlinkSync(socketPath);
			} catch {
				/* doesn't exist */
			}

			server = net.createServer((socket: net.Socket) => {
				let data = '';

				socket.on('data', (chunk: Buffer) => {
					data += chunk.toString();
					const lines = data.split('\n');
					if (lines.length <= 1 || !lines[0]) return;

					const line = lines[0]!;
					data = lines.slice(1).join('\n');

					try {
						const parsed: unknown = JSON.parse(line);
						if (!isValidHookEventEnvelope(parsed)) {
							socket.end();
							return;
						}

						const envelope = parsed as HookEventEnvelope;
						const runtimeEvent = mapEnvelopeToRuntimeEvent(envelope);

						// Set up timeout if interaction hints specify one
						let timer: ReturnType<typeof setTimeout> | undefined;
						if (runtimeEvent.interaction.defaultTimeoutMs) {
							timer = setTimeout(() => {
								const timeoutDecision: RuntimeDecision = {
									type: 'passthrough',
									source: 'timeout',
								};
								const result = mapDecisionToResult(
									runtimeEvent,
									timeoutDecision,
								);
								respondToForwarder(runtimeEvent.id, result);
								notifyDecision(runtimeEvent.id, timeoutDecision);
							}, runtimeEvent.interaction.defaultTimeoutMs);
						}

						pending.set(runtimeEvent.id, {
							event: runtimeEvent,
							socket,
							timer,
						});
						emit(runtimeEvent);
					} catch {
						socket.end();
					}
				});

				socket.on('error', () => {
					/* handled by close */
				});

				socket.on('close', () => {
					for (const [reqId, req] of pending) {
						if (req.socket === socket) {
							if (req.timer) clearTimeout(req.timer);
							pending.delete(reqId);
						}
					}
				});
			});

			server.on('listening', () => {
				status = 'running';
				lastError = null;
			});
			server.on('error', (error: NodeJS.ErrnoException) => {
				status = 'stopped';
				lastError = makeStartupError('socket_bind_failed', error.message);
				console.error(
					`[athena] hook server failed to start on ${socketPath}: ${error.message}`,
				);
			});

			try {
				server.listen(socketPath, () => {
					try {
						fs.chmodSync(socketPath, 0o600);
					} catch {
						/* best effort */
					}
				});
			} catch (error) {
				status = 'stopped';
				lastError = makeStartupError(
					'socket_bind_failed',
					error instanceof Error ? error.message : String(error),
				);
				console.error(
					`[athena] hook server failed to start on ${socketPath}: ${lastError.message}`,
				);
			}
		},

		stop(): void {
			for (const req of pending.values()) {
				if (req.timer) clearTimeout(req.timer);
			}
			pending.clear();

			if (server) {
				server.close();
				server = null;
			}
			status = 'stopped';
			lastError = null;

			try {
				fs.unlinkSync(socketPath);
			} catch {
				/* best effort */
			}
		},

		getStatus(): 'stopped' | 'running' {
			return status;
		},

		getLastError(): RuntimeStartupError | null {
			return lastError;
		},

		onEvent(handler: RuntimeEventHandler): () => void {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},

		onDecision(handler: RuntimeDecisionHandler): () => void {
			decisionHandlers.add(handler);
			return () => decisionHandlers.delete(handler);
		},

		sendDecision(eventId: string, decision: RuntimeDecision): void {
			const req = pending.get(eventId);
			if (!req) return; // Late decision — request already timed out or responded

			const result = mapDecisionToResult(req.event, decision);
			respondToForwarder(eventId, result);
			notifyDecision(eventId, decision);
		},
	};

	return {
		...connector,
		_getPendingCount(): number {
			return pending.size;
		},
	};
}
