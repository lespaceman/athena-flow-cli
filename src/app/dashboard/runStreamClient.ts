import {WebSocket} from 'ws';

/**
 * Per-run WebSocket client for the dashboard's RunStreamDO.
 *
 * Why this exists: relaying run events through the long-lived instance socket
 * is fragile. When that socket disconnects (token rotation, idle drop, DO
 * recycle), every frame queued during the gap is silently lost — and because
 * the dashboard's RunStreamDO enforces a strict `seq === lastAckedSeq + 1`,
 * one missed frame poisons the whole run (every subsequent frame becomes a
 * `sequence_gap`). This module opens a dedicated WS per run using the
 * `callbackWsUrl` + `callbackToken` the dashboard mints in `prepareDispatch`,
 * and uses RunStreamDO's resume-on-reconnect protocol to recover from
 * disconnects without losing frames.
 *
 * Protocol (server-side: convex/lib/durable-objects/run-stream-do.ts):
 *   - Connect to `wss://.../api/runs/:runId/stream?token=:token`
 *   - Server immediately sends `{type: 'resume', lastAckedSeq, terminated}`
 *   - Client sends frames `{seq, ts, kind, payload}` with seq strictly +1
 *   - Server replies `{type: 'ack', seq}` per frame, or
 *     `{type: 'error', code: 'sequence_gap', expected, message}` on gap
 *   - Terminal frames (kind in {completion, error}) cause server to ack then
 *     close 1000 'run_terminated' — the connection is single-use after.
 *   - Heartbeat: client sends `{type: 'ping', ts}`, server replies
 *     `{type: 'pong', ts}`.
 */

export type RunStreamLogger = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

export type RunStreamFrameInput = {
	ts: number;
	kind: string;
	payload?: unknown;
};

export type RunStreamClientOptions = {
	wsUrl: string;
	token: string;
	log?: RunStreamLogger;
	now?: () => number;
	/** Reconnect backoff schedule (in ms). Last value is repeated. */
	reconnectDelaysMs?: number[];
	/** Client-side heartbeat interval (ping). 0 disables. */
	heartbeatIntervalMs?: number;
	/** Watchdog: close socket if no server frame for this long. 0 disables. */
	watchdogTimeoutMs?: number;
	/** Cap on outbound queue size. Frames over the cap are dropped after a
	 *  warning — better than unbounded memory if the server is unreachable
	 *  for hours. */
	maxQueueSize?: number;
	/** Test seam. */
	makeWebSocket?: (url: string) => WebSocket;
	/** Test seam — schedule a function to run later. */
	setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
	/** Test seam — cancel a previously-scheduled timer. */
	clearTimer?: (timer: NodeJS.Timeout) => void;
};

export type RunStreamClient = {
	/**
	 * Open the connection. Resolves on the first successful WS open + receipt
	 * of the server's `resume` frame. Rejects only on the first connection
	 * attempt — subsequent disconnects are handled internally.
	 */
	connect(): Promise<void>;
	/**
	 * Append a frame to the outbound queue. Delivered with at-least-once
	 * semantics: retransmitted on reconnect until the server ACKs it.
	 */
	sendEvent(input: RunStreamFrameInput): void;
	/**
	 * Resolves when the server has signalled termination (either by sending
	 * `resume {terminated: true}` or by closing after acking a terminal kind).
	 * Useful for the daemon: once this resolves, the run is fully durable on
	 * the dashboard.
	 */
	whenTerminated(): Promise<void>;
	/** Close the connection. Idempotent. */
	close(reason?: string): Promise<void>;
};

const DEFAULT_RECONNECT_DELAYS_MS = [250, 1_000, 2_000, 5_000, 15_000];
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_WATCHDOG_MS = 90_000;
const DEFAULT_MAX_QUEUE_SIZE = 5_000;

type QueuedFrame = {
	seq: number;
	ts: number;
	kind: string;
	payload: unknown;
};

type ServerFrame =
	| {type: 'resume'; lastAckedSeq: number; terminated: boolean}
	| {type: 'ack'; seq: number}
	| {type: 'pong'; ts?: number}
	| {type: 'error'; code: string; message?: string; expected?: number};

export function createRunStreamClient(
	opts: RunStreamClientOptions,
): RunStreamClient {
	const log = opts.log ?? (() => {});
	const now = opts.now ?? (() => Date.now());
	const reconnectDelays = opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
	const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
	const watchdogMs = opts.watchdogTimeoutMs ?? DEFAULT_WATCHDOG_MS;
	const maxQueueSize = opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
	const makeWebSocket =
		opts.makeWebSocket ?? ((url: string) => new WebSocket(url));
	const setTimer =
		opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	const clearTimer =
		opts.clearTimer ?? ((t: NodeJS.Timeout) => clearTimeout(t));

	let nextSeq = 1;
	const queue: QueuedFrame[] = [];
	let ws: WebSocket | null = null;
	let connectAttempt = 0;
	let stopped = false;
	let serverTerminated = false;
	let heartbeatTimer: NodeJS.Timeout | null = null;
	let watchdogTimer: NodeJS.Timeout | null = null;
	let reconnectTimer: NodeJS.Timeout | null = null;
	let resumeResolved = false;
	let firstConnect: {
		resolve: () => void;
		reject: (err: Error) => void;
	} | null = null;
	const terminationWaiters: Array<() => void> = [];

	function trimQueueUpTo(lastAckedSeq: number): void {
		while (queue.length > 0 && queue[0]!.seq <= lastAckedSeq) {
			queue.shift();
		}
	}

	function trimQueueUpToExclusive(expectedSeq: number): void {
		// Drop frames whose seq is < expectedSeq. Used after `sequence_gap`:
		// the server has already acked everything below `expected` (or the run
		// state moved on), so we should not re-send those.
		while (queue.length > 0 && queue[0]!.seq < expectedSeq) {
			queue.shift();
		}
	}

	function clearTimers(): void {
		if (heartbeatTimer) {
			clearTimer(heartbeatTimer);
			heartbeatTimer = null;
		}
		if (watchdogTimer) {
			clearTimer(watchdogTimer);
			watchdogTimer = null;
		}
		if (reconnectTimer) {
			clearTimer(reconnectTimer);
			reconnectTimer = null;
		}
	}

	function startHeartbeat(): void {
		if (heartbeatMs <= 0) return;
		const tick = (): void => {
			if (!ws || ws.readyState !== ws.OPEN) return;
			try {
				ws.send(JSON.stringify({type: 'ping', ts: now()}));
			} catch (err) {
				log(
					'warn',
					`run-stream ping failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
			heartbeatTimer = setTimer(tick, heartbeatMs);
			heartbeatTimer.unref?.();
		};
		heartbeatTimer = setTimer(tick, heartbeatMs);
		heartbeatTimer.unref?.();
	}

	function bumpWatchdog(): void {
		if (watchdogMs <= 0) return;
		if (watchdogTimer) clearTimer(watchdogTimer);
		watchdogTimer = setTimer(() => {
			log(
				'warn',
				`run-stream watchdog: no server frames for ${watchdogMs}ms — recycling socket`,
			);
			try {
				ws?.terminate();
			} catch {
				// best-effort
			}
		}, watchdogMs);
		watchdogTimer.unref?.();
	}

	function flushQueue(): void {
		if (!ws || ws.readyState !== ws.OPEN || !resumeResolved) return;
		for (const frame of queue) {
			try {
				ws.send(JSON.stringify(frame));
			} catch (err) {
				// Stop flushing on first failure; reconnect will replay.
				log(
					'warn',
					`run-stream flush stopped: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				return;
			}
		}
	}

	function notifyTerminated(): void {
		serverTerminated = true;
		const waiters = terminationWaiters.splice(0, terminationWaiters.length);
		for (const w of waiters) {
			try {
				w();
			} catch {
				// listeners must not break shutdown
			}
		}
	}

	function handleServerFrame(parsed: ServerFrame): void {
		bumpWatchdog();
		switch (parsed.type) {
			case 'resume': {
				resumeResolved = true;
				trimQueueUpTo(parsed.lastAckedSeq);
				// Resolve the initial connect promise either way: the caller
				// asked us to *attach* to the per-run channel; whether the run
				// is already terminated is signalled separately via
				// whenTerminated().
				if (firstConnect) {
					const f = firstConnect;
					firstConnect = null;
					f.resolve();
				}
				if (parsed.terminated) {
					notifyTerminated();
					try {
						ws?.close(1000, 'already_terminated');
					} catch {
						// best-effort
					}
					return;
				}
				flushQueue();
				return;
			}
			case 'ack': {
				trimQueueUpTo(parsed.seq);
				// Server closes the socket after acking a terminal frame; if the
				// frame we just acked was terminal, we expect an imminent close.
				return;
			}
			case 'pong':
				return;
			case 'error': {
				if (
					parsed.code === 'sequence_gap' &&
					typeof parsed.expected === 'number'
				) {
					// Resync: drop anything below the expected seq and re-flush.
					trimQueueUpToExclusive(parsed.expected);
					flushQueue();
					log(
						'warn',
						`run-stream sequence_gap: server expected seq=${parsed.expected}; replayed ${queue.length} frames`,
					);
					return;
				}
				log(
					'warn',
					`run-stream server error: ${parsed.code}${
						parsed.message ? ` ${parsed.message}` : ''
					}`,
				);
				return;
			}
		}
	}

	function nextReconnectDelay(): number {
		if (reconnectDelays.length === 0) return 0;
		const idx = Math.min(connectAttempt, reconnectDelays.length - 1);
		const ms = reconnectDelays[idx] ?? 0;
		connectAttempt += 1;
		return ms;
	}

	function scheduleReconnect(): void {
		if (stopped || serverTerminated) return;
		const delayMs = nextReconnectDelay();
		log('info', `run-stream reconnect scheduled in ${delayMs}ms`);
		reconnectTimer = setTimer(() => {
			reconnectTimer = null;
			void openSocket();
		}, delayMs);
		reconnectTimer.unref?.();
	}

	async function openSocket(): Promise<void> {
		if (stopped || serverTerminated) return;
		resumeResolved = false;
		const next = makeWebSocket(opts.wsUrl);
		ws = next;
		next.on('open', () => {
			connectAttempt = 0;
			startHeartbeat();
			bumpWatchdog();
			// Don't flush yet; wait for the server's `resume` frame so we know
			// what's already been acked.
		});
		next.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
			let parsed: ServerFrame;
			try {
				parsed = JSON.parse(String(data)) as ServerFrame;
			} catch {
				log('warn', 'run-stream received non-JSON frame');
				return;
			}
			handleServerFrame(parsed);
		});
		next.on('close', (code: number, reasonBuf: Buffer) => {
			if (next !== ws) return;
			ws = null;
			clearTimers();
			const reason = reasonBuf?.toString?.() || 'closed';
			if (code === 1000 && reason === 'run_terminated') {
				notifyTerminated();
				return;
			}
			if (firstConnect) {
				const f = firstConnect;
				firstConnect = null;
				f.reject(
					new Error(`run-stream initial connect failed: ${reason} (${code})`),
				);
				return;
			}
			scheduleReconnect();
		});
		next.on('error', err => {
			log(
				'warn',
				`run-stream socket error: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			// Wait for the close event to drive reconnection; ws emits both.
		});
	}

	return {
		async connect() {
			if (firstConnect) {
				throw new Error('run-stream client already connecting');
			}
			await new Promise<void>((resolve, reject) => {
				firstConnect = {resolve, reject};
				void openSocket();
			});
		},
		sendEvent(input: RunStreamFrameInput): void {
			const frame: QueuedFrame = {
				seq: nextSeq++,
				ts: input.ts,
				kind: input.kind,
				payload: input.payload ?? null,
			};
			if (queue.length >= maxQueueSize) {
				log(
					'warn',
					`run-stream queue at cap (${maxQueueSize}); dropping oldest unacked frame seq=${queue[0]!.seq}`,
				);
				queue.shift();
			}
			queue.push(frame);
			if (ws && ws.readyState === ws.OPEN && resumeResolved) {
				try {
					ws.send(JSON.stringify(frame));
				} catch (err) {
					log(
						'warn',
						`run-stream send failed (will replay): ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}
		},
		whenTerminated() {
			if (serverTerminated) return Promise.resolve();
			return new Promise<void>(resolve => {
				terminationWaiters.push(resolve);
			});
		},
		async close(reason = 'client_close') {
			stopped = true;
			clearTimers();
			const current = ws;
			ws = null;
			if (current) {
				try {
					current.close(1000, reason);
				} catch {
					try {
						current.terminate();
					} catch {
						// best-effort
					}
				}
			}
			notifyTerminated();
		},
	};
}
