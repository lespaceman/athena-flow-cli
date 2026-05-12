import {WebSocket} from 'ws';
import type {RuntimeDecision} from '../../core/runtime/types';
import type {DashboardFeedEnvelope} from './dashboardFeedPublisher';

export type RunEventFrame = {
	type: 'run_event';
	runId: string;
	seq: number;
	ts: number;
	kind: string;
	payload?: unknown;
};

export type FeedEventFrame = {
	type: 'feed_event';
	deliverySeq: number;
	envelope: DashboardFeedEnvelope;
};

export type InstanceSocketFrame =
	| {type: 'ping'; ts: number}
	| {type: 'pong'; ts: number}
	| {
			type: 'job_assignment';
			runId: string;
			runSpec?: unknown;
			/**
			 * The runner this assignment is bound to. Top-level so the CLI can
			 * route to the right Attachment without inspecting `runSpec`.
			 * Optional: dashboards predating phase-1 of the supervisor work
			 * don't emit it. The CLI falls back to single-runtime semantics
			 * when absent.
			 */
			runnerId?: string;
	  }
	| {type: 'assignment_accepted'; runId: string}
	| {type: 'feed_ack'; deliverySeq?: number; eventId?: string}
	| {
			type: 'dashboard_decision';
			athenaSessionId: string;
			requestId: string;
			decision: RuntimeDecision;
	  }
	| {type: 'cancel'; runId: string; runnerId?: string}
	| {
			/**
			 * Pushed by the dashboard when a runner is bound to or unbound from
			 * this instance. Full-list semantics — the CLI's mirror reconciles
			 * via `diffAttachments`. Optional fields mirror the pair-response
			 * runner shape so the same parser fits both paths.
			 */
			type: 'attachments.changed';
			attachments: Array<{
				runnerId: string;
				name?: string;
				slug?: string;
				executionTarget?: string;
				remoteInstanceId?: string;
			}>;
	  }
	| {type: 'error'; code: string; message?: string}
	| RunEventFrame
	| FeedEventFrame;

export type InstanceSocketLogger = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

export type InstanceSocketClientOptions = {
	dashboardUrl: string;
	instanceId: string;
	accessToken: string;
	heartbeatIntervalMs?: number;
	connectTimeoutMs?: number;
	log?: InstanceSocketLogger;
	/**
	 * Test seam. Production code uses the default factory which constructs a
	 * `ws` `WebSocket` with the access token sent as the first
	 * `Sec-WebSocket-Protocol` value. The dashboard's instance-socket
	 * extractor accepts the token via subprotocol or `?token=` query — we
	 * use subprotocol so browser clients (which cannot set arbitrary
	 * headers, including `Authorization`) follow the same contract.
	 */
	makeWebSocket?: (url: string, accessToken: string) => WebSocket;
	now?: () => number;
};

export type InstanceSocketClient = {
	connect(): Promise<void>;
	close(reason?: string): void;
	onFrame(handler: (frame: InstanceSocketFrame) => void): void;
	onClose(handler: (reason: string) => void): void;
	sendRunEvent(event: Omit<RunEventFrame, 'type'>): void;
	sendFeedEvent(event: Omit<FeedEventFrame, 'type'>): void;
};

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export function instanceSocketUrl(
	dashboardUrl: string,
	instanceId: string,
): string {
	const url = new URL(dashboardUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = `/api/instances/${encodeURIComponent(instanceId)}/socket`;
	url.search = '';
	url.hash = '';
	return url.toString();
}

export function createInstanceSocketClient(
	opts: InstanceSocketClientOptions,
): InstanceSocketClient {
	const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
	const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const log = opts.log ?? (() => {});
	const now = opts.now ?? (() => Date.now());
	const makeWebSocket =
		opts.makeWebSocket ??
		((url: string, accessToken: string): WebSocket =>
			new WebSocket(url, [accessToken]));

	const frameHandlers = new Set<(frame: InstanceSocketFrame) => void>();
	const closeHandlers = new Set<(reason: string) => void>();
	let ws: WebSocket | null = null;
	let heartbeat: NodeJS.Timeout | null = null;
	let droppedSinceClose = 0;

	function send(frame: InstanceSocketFrame): void {
		if (!ws || ws.readyState !== ws.OPEN) {
			droppedSinceClose += 1;
			if (droppedSinceClose === 1) {
				log(
					'warn',
					`instance socket dropped frame (socket not open): type=${frame.type}`,
				);
			}
			return;
		}
		droppedSinceClose = 0;
		try {
			ws.send(JSON.stringify(frame));
		} catch (err) {
			log(
				'warn',
				`instance socket send failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	function startHeartbeat(): void {
		stopHeartbeat();
		const interval = setInterval(() => {
			send({type: 'ping', ts: now()});
		}, heartbeatMs);
		interval.unref();
		heartbeat = interval;
	}

	function stopHeartbeat(): void {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
	}

	function emitClose(reason: string): void {
		stopHeartbeat();
		for (const handler of [...closeHandlers]) {
			try {
				handler(reason);
			} catch {
				// listeners must not break shutdown
			}
		}
	}

	function handleFrame(parsed: InstanceSocketFrame): void {
		if (parsed.type === 'job_assignment') {
			send({type: 'assignment_accepted', runId: parsed.runId});
			log('info', `instance socket: assignment accepted runId=${parsed.runId}`);
		}
		for (const handler of [...frameHandlers]) {
			try {
				handler(parsed);
			} catch (err) {
				log(
					'warn',
					`instance socket frame handler threw: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}
	}

	async function connect(): Promise<void> {
		if (ws) throw new Error('instance socket already connected');
		const url = instanceSocketUrl(opts.dashboardUrl, opts.instanceId);
		const next = makeWebSocket(url, opts.accessToken);

		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const cleanup = (): void => {
					next.off('open', onOpen);
					next.off('error', onError);
					clearTimeout(timer);
				};
				const onOpen = (): void => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve();
				};
				const onError = (err: Error): void => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(new Error(`instance socket connect failed: ${err.message}`));
				};
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(
						new Error(
							`instance socket connect failed: timed out after ${connectTimeoutMs}ms`,
						),
					);
				}, connectTimeoutMs);
				next.once('open', onOpen);
				next.once('error', onError);
			});
		} catch (err) {
			// Swallow any late 'error' events emitted by terminate() so they
			// don't surface as unhandled — `ws` re-emits an error when the
			// underlying socket is torn down before the upgrade completes.
			next.on('error', () => {});
			try {
				next.terminate();
			} catch {
				// best-effort
			}
			throw err;
		}

		ws = next;
		startHeartbeat();

		next.on('message', data => {
			let parsed: InstanceSocketFrame;
			try {
				parsed = JSON.parse(String(data)) as InstanceSocketFrame;
			} catch (err) {
				log(
					'warn',
					`instance socket frame parse failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				return;
			}
			handleFrame(parsed);
		});

		next.on('close', (_code, reasonBuf) => {
			if (next !== ws) return;
			ws = null;
			const reason = reasonBuf.toString() || 'closed';
			emitClose(reason);
		});

		next.on('error', err => {
			log('warn', `instance socket error: ${err.message}`);
		});
	}

	function close(reason?: string): void {
		stopHeartbeat();
		if (ws) {
			try {
				ws.close(1000, reason ?? 'client closed');
			} catch {
				ws.terminate();
			}
		}
		ws = null;
	}

	function onFrame(handler: (frame: InstanceSocketFrame) => void): void {
		frameHandlers.add(handler);
	}

	function onClose(handler: (reason: string) => void): void {
		closeHandlers.add(handler);
	}

	function sendRunEvent(event: Omit<RunEventFrame, 'type'>): void {
		send({type: 'run_event', ...event});
	}

	function sendFeedEvent(event: Omit<FeedEventFrame, 'type'>): void {
		send({type: 'feed_event', ...event});
	}

	return {connect, close, onFrame, onClose, sendRunEvent, sendFeedEvent};
}
