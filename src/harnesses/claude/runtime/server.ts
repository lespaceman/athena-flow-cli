/**
 * UDS server for receiving Claude hook events via NDJSON.
 *
 * This module encapsulates all network I/O and NDJSON protocol handling.
 * It is the ONLY place that reads/writes to Unix Domain Sockets.
 *
 * Also accepts stream-json stdout data via feedStdout() to translate
 * tool result events into RuntimeEvents (same emit path as hook events).
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
import {BoundedLineParser} from './boundedLineParser';
import {getInteractionHints} from './interactionRules';
import {createStreamJsonToolParser} from './streamJsonToolParser';

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

const SIMULATED_STARTUP_FAILURE_ENV = 'ATHENA_SIMULATE_HOOK_SERVER_FAILURE';

function makeStartupError(
	code: RuntimeStartupErrorCode,
	message: string,
): RuntimeStartupError {
	return {code, message};
}

function getSimulatedStartupFailure(): {
	code: RuntimeStartupErrorCode;
	message: string;
} | null {
	const raw = process.env[SIMULATED_STARTUP_FAILURE_ENV];
	switch (raw) {
		case 'socket_path_too_long':
			return {
				code: 'socket_path_too_long',
				message: `Simulated hook server startup failure via ${SIMULATED_STARTUP_FAILURE_ENV}=socket_path_too_long`,
			};
		case 'socket_dir_unavailable':
			return {
				code: 'socket_dir_unavailable',
				message: `Simulated hook server startup failure via ${SIMULATED_STARTUP_FAILURE_ENV}=socket_dir_unavailable`,
			};
		case 'socket_bind_failed':
			return {
				code: 'socket_bind_failed',
				message: `Simulated hook server startup failure via ${SIMULATED_STARTUP_FAILURE_ENV}=socket_bind_failed`,
			};
		case undefined:
		default:
			return null;
	}
}

function getSocketPathLimit(): number {
	return process.platform === 'darwin'
		? MAX_UNIX_SOCKET_PATH_BYTES.darwin
		: MAX_UNIX_SOCKET_PATH_BYTES.default;
}

/** Global TTL for pending requests — strictly less than forwarder's 5min timeout */
const PENDING_TTL_MS = 4 * 60 * 1000 + 30 * 1000; // 4 minutes 30 seconds

export function createServer(opts: ServerOptions) {
	const {projectDir, instanceId} = opts;
	const pending = new Map<string, PendingRequest>();
	const handlers = new Set<RuntimeEventHandler>();
	const decisionHandlers = new Set<RuntimeDecisionHandler>();
	let server: net.Server | null = null;
	let status: 'stopped' | 'running' = 'stopped';
	let socketPath = '';
	let lastError: RuntimeStartupError | null = null;
	let startPromise: Promise<void> | null = null;
	let sessionId = '';

	const streamParser = createStreamJsonToolParser((toolEvent): void => {
		const event: RuntimeEvent = {
			id: `stream-${toolEvent.tool_use_id ?? 'unknown'}-${Date.now()}`,
			timestamp: Date.now(),
			kind: 'tool.delta',
			data: {
				tool_name: toolEvent.tool_name,
				tool_input: {},
				tool_use_id: toolEvent.tool_use_id,
				delta: toolEvent.content,
			},
			hookName: 'stream-json',
			sessionId,
			toolName: toolEvent.tool_name,
			toolUseId: toolEvent.tool_use_id,
			context: {cwd: projectDir, transcriptPath: ''},
			interaction: getInteractionHints('tool.delta'),
			payload: null,
		};
		emit(event);
	});

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
		start(): Promise<void> {
			if (status === 'running') {
				return Promise.resolve();
			}
			if (startPromise) {
				return startPromise;
			}

			const socketDir = path.join(projectDir, '.claude', 'run');
			socketPath = path.join(socketDir, `ink-${instanceId}.sock`);
			lastError = null;

			const simulatedFailure = getSimulatedStartupFailure();
			if (simulatedFailure) {
				status = 'stopped';
				lastError = makeStartupError(
					simulatedFailure.code,
					simulatedFailure.message,
				);
				console.error(
					`[athena] hook server failed to start on ${socketPath}: ${lastError.message}`,
				);
				return Promise.resolve();
			}

			if (Buffer.byteLength(socketPath) > getSocketPathLimit()) {
				status = 'stopped';
				lastError = makeStartupError(
					'socket_path_too_long',
					`Socket path is too long for ${process.platform}: ${socketPath}`,
				);
				console.error(
					`[athena] hook server failed to start on ${socketPath}: ${lastError.message}`,
				);
				return Promise.resolve();
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
				return Promise.resolve();
			}
			// Sweep stale sockets from previous crashed processes
			cleanupStaleSockets(socketDir);
			try {
				fs.unlinkSync(socketPath);
			} catch {
				/* doesn't exist */
			}

			server = net.createServer((socket: net.Socket) => {
				const parser = new BoundedLineParser();

				socket.on('data', (chunk: Buffer) => {
					const lines = parser.feed(chunk);
					for (const line of lines) {
						try {
							const parsed: unknown = JSON.parse(line);
							if (!isValidHookEventEnvelope(parsed)) {
								socket.end();
								return;
							}

							const envelope = parsed as HookEventEnvelope;
							if (envelope.session_id) {
								sessionId = envelope.session_id;
							}
							const runtimeEvent = mapEnvelopeToRuntimeEvent(envelope);

							// Set up timeout — use event-specific or global TTL
							const timeoutMs =
								runtimeEvent.interaction.defaultTimeoutMs ?? PENDING_TTL_MS;
							const timer = setTimeout(() => {
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
							}, timeoutMs);

							pending.set(runtimeEvent.id, {
								event: runtimeEvent,
								socket,
								timer,
							});
							emit(runtimeEvent);
						} catch {
							socket.end();
						}
					}
				});

				socket.on('error', () => {
					/* handled by close */
				});

				socket.on('close', () => {
					for (const [reqId, req] of pending) {
						if (req.socket === socket) {
							if (req.timer) clearTimeout(req.timer);
							// Emit passthrough decision for expectsDecision entries
							// to prevent stale permission requests in the TUI
							if (req.event.interaction.expectsDecision) {
								notifyDecision(reqId, {
									type: 'passthrough',
									source: 'timeout',
								});
							}
							pending.delete(reqId);
						}
					}
				});
			});

			const currentServer = server;
			startPromise = new Promise(resolve => {
				let settled = false;
				const settle = () => {
					if (settled) return;
					settled = true;
					startPromise = null;
					resolve();
				};

				currentServer.on('listening', () => {
					status = 'running';
					lastError = null;
					settle();
				});
				currentServer.on('error', (error: NodeJS.ErrnoException) => {
					status = 'stopped';
					lastError = makeStartupError('socket_bind_failed', error.message);
					console.error(
						`[athena] hook server failed to start on ${socketPath}: ${error.message}`,
					);
					settle();
				});

				try {
					currentServer.listen(socketPath, () => {
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
					settle();
				}
			});
			return startPromise;
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
			startPromise = null;
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
		feedStdout(chunk: string): void {
			streamParser.feed(chunk);
		},
	};
}
