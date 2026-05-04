/**
 * `ConsoleBrokerClient` — adapter-local WS wrapper that owns one outbound
 * connection to the rich-client broker and speaks the `AthenaConsoleFrame`
 * protocol.
 *
 * Notes:
 *   - Pairing token travels via the `Authorization: Bearer …` header. It is
 *     never appended to the URL query string and never logged.
 *   - This client is independent from `gateway/transport/wsClient.ts`, which
 *     speaks `ControlEnvelope` for the runtime control plane.
 *   - Reconnect uses full-jitter backoff, capped at `maxDelayMs`. Reconnect
 *     is silent (no `connect()` reissue from callers); the `onReady`
 *     callback fires after each successful re-handshake so subscribers can
 *     refresh their transport-health view.
 */

import {readFileSync} from 'node:fs';
import {WebSocket} from 'ws';
import type {
	AthenaConsoleFrame,
	AthenaConsoleHelloFrame,
	AthenaConsoleReadyFrame,
} from '../../../shared/gateway-protocol';

export type ConsoleBrokerClientLogger = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

export type ConsoleReconnectOptions = {
	initialDelayMs?: number;
	maxDelayMs?: number;
};

export type ConsoleBrokerClientOptions = {
	brokerUrl: string;
	pairingToken: string;
	tlsCaPath?: string;
	log: ConsoleBrokerClientLogger;
	connectTimeoutMs?: number;
	reconnect?: ConsoleReconnectOptions;
};

export type ConsoleHelloPayload = {
	runnerId: string;
	workspaceId?: string;
	clientName: string;
	clientVersion: string;
};

export type ConsoleBrokerClient = {
	connect(hello: ConsoleHelloPayload): Promise<void>;
	close(reason: string): void;
	sendFrame(frame: AthenaConsoleFrame): void;
	onFrame(handler: (frame: AthenaConsoleFrame) => void): void;
	onReady(handler: (address: AthenaConsoleReadyFrame['address']) => void): void;
	onClose(handler: (reason: string) => void): void;
	getReadyAddress(): AthenaConsoleReadyFrame['address'] | null;
	isReady(): boolean;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_INITIAL_RECONNECT_MS = 1_000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;

export function createConsoleBrokerClient(
	opts: ConsoleBrokerClientOptions,
): ConsoleBrokerClient {
	const initialDelay =
		opts.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_RECONNECT_MS;
	const maxDelay = opts.reconnect?.maxDelayMs ?? DEFAULT_MAX_RECONNECT_MS;
	let ws: WebSocket | null = null;
	let ready: AthenaConsoleReadyFrame | null = null;
	let closeRequested = false;
	let reconnectAttempt = 0;
	let reconnectTimer: NodeJS.Timeout | null = null;
	let lastHello: ConsoleHelloPayload | null = null;
	const frameHandlers = new Set<(frame: AthenaConsoleFrame) => void>();
	const closeHandlers = new Set<(reason: string) => void>();
	const readyHandlers = new Set<
		(address: AthenaConsoleReadyFrame['address']) => void
	>();
	const tokenRedacted = '<redacted>';

	function redact(message: string): string {
		return message.split(opts.pairingToken).join(tokenRedacted);
	}

	function emitClose(reason: string): void {
		for (const h of [...closeHandlers]) {
			try {
				h(reason);
			} catch {
				// listener errors must not break shutdown
			}
		}
	}

	function scheduleReconnect(): void {
		if (closeRequested || !lastHello) return;
		const exp = Math.min(maxDelay, initialDelay * 2 ** reconnectAttempt);
		const delay = Math.floor(Math.random() * exp);
		reconnectAttempt++;
		const hello = lastHello;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			void attemptConnect(hello).then(
				() => {
					reconnectAttempt = 0;
				},
				err => {
					opts.log(
						'warn',
						`console broker reconnect failed: ${redact(err instanceof Error ? err.message : String(err))}`,
					);
					scheduleReconnect();
				},
			);
		}, delay);
	}

	async function attemptConnect(hello: ConsoleHelloPayload): Promise<void> {
		const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const headers = {Authorization: `Bearer ${opts.pairingToken}`};
		const wsOpts = opts.tlsCaPath
			? {headers, ca: readFileSync(opts.tlsCaPath)}
			: {headers};
		const next = new WebSocket(opts.brokerUrl, wsOpts);
		ws = next;
		ready = null;

		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const finishOk = (): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve();
				};
				const finishErr = (err: Error): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(err);
				};
				const timer = setTimeout(() => {
					finishErr(
						new Error(`console broker connect timed out after ${timeoutMs}ms`),
					);
				}, timeoutMs);

				next.once('open', () => {
					try {
						const helloFrame: AthenaConsoleHelloFrame = {
							kind: 'console.hello',
							frameId: makeFrameId(),
							sentAt: Date.now(),
							protocolVersion: 1,
							clientName: hello.clientName,
							clientVersion: hello.clientVersion,
							address: {
								runnerId: hello.runnerId,
								...(hello.workspaceId !== undefined
									? {workspaceId: hello.workspaceId}
									: {}),
							},
						};
						next.send(JSON.stringify(helloFrame));
					} catch (err) {
						finishErr(err instanceof Error ? err : new Error(String(err)));
					}
				});

				next.once('error', err => {
					finishErr(
						new Error(`console broker connect failed: ${redact(err.message)}`),
					);
				});

				const earlyCloseListener = (code: number, reasonBuf: Buffer): void => {
					if (!ready) {
						const reason = reasonBuf.toString();
						finishErr(
							new Error(
								`console broker closed before ready (code=${code}${reason ? ` reason=${reason}` : ''})`,
							),
						);
					}
				};
				next.once('close', earlyCloseListener);

				next.on('message', data => {
					let parsed: AthenaConsoleFrame;
					try {
						parsed = JSON.parse(String(data)) as AthenaConsoleFrame;
					} catch (err) {
						opts.log(
							'warn',
							`console broker frame parse failed: ${redact(String(err))}`,
						);
						return;
					}
					if (!ready) {
						if (parsed.kind === 'console.ready') {
							const claimedRunnerId = hello.runnerId;
							const readyRunnerId = parsed.address.runnerId;
							if (readyRunnerId !== claimedRunnerId) {
								finishErr(
									new Error(
										`console broker ready runnerId mismatch: claimed ${claimedRunnerId}, got ${readyRunnerId}`,
									),
								);
								return;
							}
							ready = parsed;
							next.removeListener('close', earlyCloseListener);
							const address = parsed.address;
							for (const h of [...readyHandlers]) {
								try {
									h(address);
								} catch {
									// ready handlers must not break the connect path
								}
							}
							finishOk();
							return;
						}
						if (parsed.kind === 'console.error') {
							finishErr(
								new Error(
									`console broker rejected hello: ${parsed.code} ${parsed.message}`,
								),
							);
							return;
						}
						opts.log(
							'warn',
							`console broker pre-ready frame ignored: ${parsed.kind}`,
						);
						return;
					}
					for (const h of [...frameHandlers]) {
						try {
							h(parsed);
						} catch (err) {
							opts.log(
								'warn',
								`console frame handler threw: ${redact(err instanceof Error ? err.message : String(err))}`,
							);
						}
					}
				});
			});
		} catch (err) {
			try {
				next.terminate();
			} catch {
				// best-effort
			}
			if (ws === next) {
				ws = null;
				ready = null;
			}
			throw err;
		}

		// Permanent close listener — drives reconnect.
		next.on('close', (_code, reasonBuf) => {
			if (next !== ws) return; // a later attempt has already taken over
			ws = null;
			ready = null;
			emitClose(reasonBuf.toString() || 'closed');
			if (!closeRequested) scheduleReconnect();
		});
	}

	async function connect(hello: ConsoleHelloPayload): Promise<void> {
		if (ws) throw new Error('console broker client already connected');
		closeRequested = false;
		lastHello = hello;
		await attemptConnect(hello);
	}

	function close(reason: string): void {
		closeRequested = true;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (ws) {
			try {
				ws.close(1000, reason);
			} catch {
				ws.terminate();
			}
		}
		ws = null;
		ready = null;
		emitClose(reason);
	}

	function sendFrame(frame: AthenaConsoleFrame): void {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			throw new Error('console broker client not connected');
		}
		ws.send(JSON.stringify(frame));
	}

	function onFrame(handler: (frame: AthenaConsoleFrame) => void): void {
		frameHandlers.add(handler);
	}

	function onClose(handler: (reason: string) => void): void {
		closeHandlers.add(handler);
	}

	function onReady(
		handler: (address: AthenaConsoleReadyFrame['address']) => void,
	): void {
		readyHandlers.add(handler);
	}

	return {
		connect,
		close,
		sendFrame,
		onFrame,
		onReady,
		onClose,
		getReadyAddress: () => ready?.address ?? null,
		isReady: () => ready !== null,
	};
}

let frameCounter = 0;
function makeFrameId(): string {
	frameCounter = (frameCounter + 1) % 1_000_000;
	return `f${Date.now().toString(36)}-${frameCounter.toString(36)}`;
}
