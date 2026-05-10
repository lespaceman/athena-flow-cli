/**
 * App-side bridge between an Athena interactive runtime and the gateway daemon.
 *
 * Owns one long-lived `ControlClient` connection per runtime. Responsibilities:
 *   1. Register the runtime on `start()` (`session.register`); unregister on
 *      `stop()`.
 *   2. Expose `onTurnDispatch(cb)` so the runtime layer can subscribe to
 *      `session.dispatch.turn` push frames and translate them into the
 *      harness-specific "start a turn" call (e.g. `useSessionController()
 *      .startTurn(...)`).
 *   3. Expose `completeTurn(payload)` to be called when the harness emits
 *      `turn.complete`; round-trips through `session.turn.complete` so the
 *      gateway can relay the assistant reply back on the originating channel.
 *   4. Expose `relayPermission(req)` / `relayQuestion(req)` for the runtime
 *      to broadcast permission/question prompts across all gateway-resident
 *      channel adapters; relay requests use a long timeout (matching the
 *      coordinator TTL) and return a structured result.
 *   5. Expose `cancelRelayPermission(id, reason)` / `cancelRelayQuestion(id,
 *      reason)` so that a local-UI claim can race the channel.
 *
 * AppShell wiring (subscribing turn dispatches into `spawnHarness`, threading
 * relay calls through the harness permission/question handlers) lands in a
 * follow-up commit. This module is the substrate; the wiring is downstream.
 */

import {
	connectGatewayControlClient,
	GatewayProtocolError,
	resolveGatewayPaths,
	type ControlClient,
	type GatewayPaths,
} from './gatewayControlClient';
import {generateChannelRequestId} from '../../shared/gateway-protocol/channelRequestId';
import {writeGatewayTrace} from '../../infra/gatewayTrace';
import {readGatewayClientConfig} from '../../infra/config/gatewayClient';
import {trackGatewayTransportReconnect} from '../../infra/telemetry/events';
import type {
	ChannelLocation,
	ControlPushEnvelope,
	PermissionRelayResult,
	QuestionRelayResult,
	RelayCancelReason,
	RelayPermissionCancelRequestPayload,
	RelayPermissionCancelResponsePayload,
	RelayPermissionRequestPayload,
	RelayPermissionResponsePayload,
	RelayQuestion,
	RelayQuestionCancelRequestPayload,
	RelayQuestionCancelResponsePayload,
	RelayQuestionRequestPayload,
	RelayQuestionResponsePayload,
	SessionDispatchTurnPushPayload,
	SessionRegisterRequestPayload,
	SessionRegisterResponsePayload,
	SessionTurnCompleteRequestPayload,
	SessionTurnCompleteResponsePayload,
	SessionUnregisterRequestPayload,
	SessionUnregisterResponsePayload,
	RuntimeEndpoint,
} from '../../shared/gateway-protocol';

/**
 * Long timeout used for relay requests — they wait on a human, so the
 * default 5s client timeout is irrelevant. Matches the coordinator's
 * default TTL with a small headroom so the response wins the race.
 */
const RELAY_REQUEST_TIMEOUT_MS = 6 * 60_000;

export type SessionBridgeOptions = {
	runtimeId: string;
	defaultAgentId: string;
	pid?: number;
	/**
	 * Optional dashboard-side **Attachment** key (today: runnerId). When set,
	 * the gateway parks this runtime in the per-attachment slot keyed by
	 * `attachmentId`; otherwise the legacy single-runtime fallback slot is
	 * used. See ADR 0001 phases 4–5.
	 */
	attachmentId?: string;
	paths?: GatewayPaths;
	/** Override token loader for tests. */
	loadToken?: (tokenPath: string) => string;
	/** Explicit endpoint; defaults to ~/.config/athena/gateway.json. */
	endpoint?: RuntimeEndpoint;
	/** Override endpoint loader for tests. */
	loadEndpoint?: () => RuntimeEndpoint;
	/** Pre-resolved client; bypasses the UDS connect step (test affordance). */
	client?: ControlClient;
	/** Test affordance: replaces the connect step on every attempt (incl. reconnect). */
	connectClient?: (input: {
		endpoint: RuntimeEndpoint;
		paths: GatewayPaths;
	}) => Promise<ControlClient>;
	/** Test affordance: override the reconnect backoff schedule (ms per attempt). */
	backoffMs?: readonly number[];
};

export type TurnDispatchHandler = (
	payload: SessionDispatchTurnPushPayload,
) => void | Promise<void>;

export type SessionBridgePermissionRequest = {
	channelRequestId?: string;
	toolName: string;
	description: string;
	inputPreview: string;
	// null = no local deadline (human-in-the-loop, e.g. AskUserQuestion).
	ttlMs?: number | null;
};

export type SessionBridgeQuestionRequest = {
	channelRequestId?: string;
	title: string;
	questions: RelayQuestion[];
	// null = no local deadline (human-in-the-loop, e.g. AskUserQuestion).
	ttlMs?: number | null;
};

export type SessionBridgeTurnComplete = {
	dispatchId: string;
	location: ChannelLocation;
	text: string;
	idempotencyKey: string;
};

export type SessionBridgeConnectionState =
	| 'idle'
	| 'connected'
	| 'reconnecting'
	| 'stopped';

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export class SessionBridge {
	private readonly opts: SessionBridgeOptions;
	private readonly backoffSchedule: readonly number[];
	private readonly turnDispatchHandlers = new Set<TurnDispatchHandler>();
	// Pushes that arrive with no subscriber attached are parked here and
	// replayed when the first handler subscribes. Required because
	// `bridge.start()` (and therefore the daemon's `drainPending`) can
	// complete before the React tree mounts the AppShell effect that calls
	// `onTurnDispatch`. Without this, the first wave of pushes — and
	// anything that lands in a re-subscribe gap — is silently dropped.
	private bufferedDispatches: SessionDispatchTurnPushPayload[] = [];
	private client: ControlClient | null = null;
	private turnDispatchUnsubscribe: (() => void) | null = null;
	private clientCloseUnsubscribe: (() => void) | null = null;
	private started = false;
	private stopped = false;
	private reconnecting: Promise<void> | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private sleepResolver: (() => void) | null = null;
	private terminalError: Error | null = null;

	constructor(opts: SessionBridgeOptions) {
		this.opts = opts;
		this.backoffSchedule =
			opts.backoffMs && opts.backoffMs.length > 0
				? opts.backoffMs
				: RECONNECT_BACKOFF_MS;
	}

	getConnectionState(): SessionBridgeConnectionState {
		if (this.stopped) return 'stopped';
		if (!this.started) return 'idle';
		if (this.reconnecting) return 'reconnecting';
		return 'connected';
	}

	async start(): Promise<SessionRegisterResponsePayload> {
		if (this.started) {
			throw new Error('session bridge already started');
		}
		const target = this.resolveEndpointPaths();
		writeGatewayTrace(
			`sessionBridge start runtimeId=${this.opts.runtimeId} endpoint=${target.endpoint.mode}${
				target.endpoint.mode === 'remote' ? ` url=${target.endpoint.url}` : ''
			}`,
		);
		const res = await this.connectAndRegister(target);
		writeGatewayTrace(
			`sessionBridge registered runtimeId=${this.opts.runtimeId}`,
		);
		this.started = true;
		return res;
	}

	private resolveEndpointPaths(): {
		endpoint: RuntimeEndpoint;
		paths: GatewayPaths;
	} {
		const endpoint =
			this.opts.endpoint ??
			(this.opts.paths
				? {mode: 'local' as const}
				: (this.opts.loadEndpoint ?? readGatewayClientConfig)());
		const paths = this.opts.paths ?? resolveGatewayPaths();
		return {endpoint, paths};
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.wakeSleep();
		const pendingReconnect = this.reconnecting;
		if (pendingReconnect) {
			try {
				await pendingReconnect;
			} catch {
				// reconnect failures during stop are expected
			}
		}
		const client = this.client;
		if (!client) {
			this.started = false;
			return;
		}
		try {
			const req: SessionUnregisterRequestPayload = {
				runtimeId: this.opts.runtimeId,
			};
			await client.request<
				SessionUnregisterRequestPayload,
				SessionUnregisterResponsePayload
			>('session.unregister', req);
		} catch {
			// best-effort: gateway may already be down
		}
		this.turnDispatchUnsubscribe?.();
		this.turnDispatchUnsubscribe = null;
		this.clientCloseUnsubscribe?.();
		this.clientCloseUnsubscribe = null;
		client.close();
		this.client = null;
		this.started = false;
		this.bufferedDispatches = [];
	}

	onTurnDispatch(cb: TurnDispatchHandler): () => void {
		const wasEmpty = this.turnDispatchHandlers.size === 0;
		this.turnDispatchHandlers.add(cb);
		if (wasEmpty && this.bufferedDispatches.length > 0) {
			const drained = this.bufferedDispatches;
			this.bufferedDispatches = [];
			writeGatewayTrace(
				`sessionBridge replaying buffered dispatches count=${drained.length} runtimeId=${this.opts.runtimeId}`,
			);
			for (const payload of drained) {
				this.invokeDispatchHandler(cb, payload);
			}
		}
		return () => {
			this.turnDispatchHandlers.delete(cb);
		};
	}

	private invokeDispatchHandler(
		cb: TurnDispatchHandler,
		payload: SessionDispatchTurnPushPayload,
	): void {
		try {
			const r = cb(payload);
			if (r && typeof (r as Promise<unknown>).catch === 'function') {
				(r as Promise<unknown>).catch(() => {
					// handler errors must not break the push channel
				});
			}
		} catch {
			// handler errors must not break the push channel
		}
	}

	async completeTurn(
		input: SessionBridgeTurnComplete,
	): Promise<SessionTurnCompleteResponsePayload> {
		const client = await this.requireConnectedClient();
		writeGatewayTrace(
			`sessionBridge completeTurn request runtimeId=${this.opts.runtimeId} dispatchId=${input.dispatchId} channel=${input.location.channelId} account=${input.location.accountId} thread=${input.location.thread?.id ?? ''} textLength=${input.text.length}`,
		);
		const req: SessionTurnCompleteRequestPayload = {
			runtimeId: this.opts.runtimeId,
			dispatchId: input.dispatchId,
			location: input.location,
			text: input.text,
			idempotencyKey: input.idempotencyKey,
		};
		const res = await client.request<
			SessionTurnCompleteRequestPayload,
			SessionTurnCompleteResponsePayload
		>('session.turn.complete', req);
		writeGatewayTrace(
			`sessionBridge completeTurn response runtimeId=${this.opts.runtimeId} dispatchId=${input.dispatchId} delivered=${res.delivered} providerMessageId=${res.providerMessageId ?? ''}`,
		);
		return res;
	}

	async relayPermission(
		req: SessionBridgePermissionRequest,
	): Promise<RelayPermissionResponsePayload> {
		writeGatewayTrace(
			`sessionBridge relayPermission tool=${req.toolName} runtimeId=${this.opts.runtimeId}`,
		);
		const channelRequestId = req.channelRequestId ?? generateChannelRequestId();
		const payload: RelayPermissionRequestPayload = {
			channelRequestId,
			toolName: req.toolName,
			description: req.description,
			inputPreview: req.inputPreview,
			...(req.ttlMs !== undefined ? {ttlMs: req.ttlMs} : {}),
		};
		const overallTimeoutMs =
			req.ttlMs === null ? null : (req.ttlMs ?? RELAY_REQUEST_TIMEOUT_MS);
		return this.requestWithReconnect<
			RelayPermissionRequestPayload,
			RelayPermissionResponsePayload
		>('relay.permission.request', payload, overallTimeoutMs);
	}

	async relayQuestion(
		req: SessionBridgeQuestionRequest,
	): Promise<RelayQuestionResponsePayload> {
		const channelRequestId = req.channelRequestId ?? generateChannelRequestId();
		const payload: RelayQuestionRequestPayload = {
			channelRequestId,
			title: req.title,
			questions: req.questions,
			...(req.ttlMs !== undefined ? {ttlMs: req.ttlMs} : {}),
		};
		const overallTimeoutMs =
			req.ttlMs === null ? null : (req.ttlMs ?? RELAY_REQUEST_TIMEOUT_MS);
		return this.requestWithReconnect<
			RelayQuestionRequestPayload,
			RelayQuestionResponsePayload
		>('relay.question.request', payload, overallTimeoutMs);
	}

	/**
	 * Wraps `client.request(...)` for relay RPCs so an in-flight relay
	 * survives a transient WS disconnect: on `connection closed`, wait for
	 * the bridge's reconnect to settle, then re-issue the same payload. The
	 * server attaches the replay to the existing pending entry by
	 * `channelRequestId`, so adapters are not re-prompted. Bounded by the
	 * caller-provided overall timeout so a long outage still surfaces.
	 */
	private async requestWithReconnect<TPayload, TResponse>(
		kind: string,
		payload: TPayload,
		// null = wait indefinitely (human-in-the-loop, e.g. AskUserQuestion).
		overallTimeoutMs: number | null,
	): Promise<TResponse> {
		const deadline =
			overallTimeoutMs === null ? null : Date.now() + overallTimeoutMs;
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- bounded by deadline + thrown errors below
		while (true) {
			const client = await this.requireConnectedClient();
			const remaining = deadline === null ? null : deadline - Date.now();
			if (remaining !== null && remaining <= 0) {
				throw new GatewayProtocolError(`request ${kind} timed out`);
			}
			try {
				return await client.request<TPayload, TResponse>(kind, payload, {
					// When unbounded, pass the largest safe setTimeout value so the
					// inner request never self-cancels in any human time scale.
					timeoutMs: remaining ?? 2_147_483_647,
				});
			} catch (err) {
				if (
					err instanceof GatewayProtocolError &&
					err.code === 'connection_closed' &&
					!this.stopped &&
					(deadline === null || Date.now() < deadline)
				) {
					writeGatewayTrace(
						`sessionBridge relay retry kind=${kind} runtimeId=${this.opts.runtimeId}`,
					);
					// Yield so the client's onClose handler runs and primes
					// `this.reconnecting` before the next requireConnectedClient call;
					// otherwise we could spin against a stale closed client.
					await new Promise(r => setImmediate(r));
					continue;
				}
				throw err;
			}
		}
	}

	async cancelRelayPermission(
		channelRequestId: string,
		reason: RelayCancelReason,
	): Promise<boolean> {
		const client = await this.requireConnectedClient();
		const payload: RelayPermissionCancelRequestPayload = {
			channelRequestId,
			reason,
		};
		const res = await client.request<
			RelayPermissionCancelRequestPayload,
			RelayPermissionCancelResponsePayload
		>('relay.permission.cancel', payload);
		return res.cancelled;
	}

	async cancelRelayQuestion(
		channelRequestId: string,
		reason: RelayCancelReason,
	): Promise<boolean> {
		const client = await this.requireConnectedClient();
		const payload: RelayQuestionCancelRequestPayload = {
			channelRequestId,
			reason,
		};
		const res = await client.request<
			RelayQuestionCancelRequestPayload,
			RelayQuestionCancelResponsePayload
		>('relay.question.cancel', payload);
		return res.cancelled;
	}

	private requireClient(): ControlClient {
		const client = this.client;
		if (!client) {
			throw new Error('session bridge not started');
		}
		return client;
	}

	private async requireConnectedClient(): Promise<ControlClient> {
		if (!this.started) {
			throw new Error('session bridge not started');
		}
		if (this.reconnecting) {
			await this.reconnecting;
		}
		if (this.stopped) {
			throw this.terminalError ?? new Error('session bridge stopped');
		}
		return this.requireClient();
	}

	private kickReconnect(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.reconnecting) return this.reconnecting;
		this.reconnectAttempts = 0;
		const target = this.resolveEndpointPaths();
		const transportKind = target.endpoint.mode === 'remote' ? 'ws' : 'uds';
		this.reconnecting = (async () => {
			while (!this.stopped) {
				const attempt = this.reconnectAttempts;
				writeGatewayTrace(
					`sessionBridge reconnect attempt=${attempt} runtimeId=${this.opts.runtimeId}`,
				);
				try {
					await this.connectAndRegister(target);
					this.reconnectAttempts = 0;
					writeGatewayTrace(
						`sessionBridge reconnected runtimeId=${this.opts.runtimeId}`,
					);
					return;
				} catch (err) {
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated by stop() during await
					if (this.stopped) return;
					if (
						err instanceof GatewayProtocolError &&
						err.code === 'already_registered'
					) {
						this.terminalError = err;
						this.stopped = true;
						writeGatewayTrace(
							`sessionBridge reconnect terminal err=already_registered runtimeId=${this.opts.runtimeId}`,
						);
						return;
					}
					this.reconnectAttempts = attempt + 1;
					const delay = this.delayForAttempt(attempt);
					trackGatewayTransportReconnect({
						transport: transportKind,
						attempt: this.reconnectAttempts,
						backoffMs: delay,
					});
					const msg = err instanceof Error ? err.message : String(err);
					writeGatewayTrace(
						`sessionBridge reconnect failed attempt=${attempt} delayMs=${delay} err=${msg}`,
					);
					await this.sleepCancelable(delay);
				}
			}
		})().finally(() => {
			this.reconnecting = null;
		});
		return this.reconnecting;
	}

	private delayForAttempt(attempt: number): number {
		const base =
			this.backoffSchedule[
				Math.min(attempt, this.backoffSchedule.length - 1)
			] ?? 30_000;
		const jitter = Math.random() * base;
		return Math.floor(base / 2 + jitter / 2);
	}

	private sleepCancelable(ms: number): Promise<void> {
		return new Promise(resolve => {
			if (this.stopped) {
				resolve();
				return;
			}
			this.sleepResolver = resolve;
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				this.sleepResolver = null;
				resolve();
			}, ms);
		});
	}

	private wakeSleep(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const resolver = this.sleepResolver;
		this.sleepResolver = null;
		if (resolver) resolver();
	}

	private async connectAndRegister(input: {
		endpoint: RuntimeEndpoint;
		paths: GatewayPaths;
	}): Promise<SessionRegisterResponsePayload> {
		const client = this.opts.connectClient
			? await this.opts.connectClient(input)
			: this.opts.client && !this.client
				? this.opts.client
				: await connectGatewayControlClient({
						endpoint: input.endpoint,
						paths: input.paths,
						loadToken: this.opts.loadToken,
					});
		const previousClient = this.client;
		this.replaceClient(client);
		const req: SessionRegisterRequestPayload = {
			runtimeId: this.opts.runtimeId,
			defaultAgentId: this.opts.defaultAgentId,
			pid: this.opts.pid ?? process.pid,
			...(this.opts.attachmentId !== undefined
				? {attachmentId: this.opts.attachmentId}
				: {}),
		};
		try {
			return await client.request<
				SessionRegisterRequestPayload,
				SessionRegisterResponsePayload
			>('session.register', req);
		} catch (err) {
			this.turnDispatchUnsubscribe?.();
			this.turnDispatchUnsubscribe = null;
			this.clientCloseUnsubscribe?.();
			this.clientCloseUnsubscribe = null;
			client.close();
			this.client = previousClient;
			throw err;
		}
	}

	private replaceClient(client: ControlClient): void {
		this.turnDispatchUnsubscribe?.();
		this.clientCloseUnsubscribe?.();
		this.client = client;
		this.turnDispatchUnsubscribe = client.onPush(
			'session.dispatch.turn',
			(envelope: ControlPushEnvelope) => {
				const payload = envelope.payload as SessionDispatchTurnPushPayload;
				if (this.turnDispatchHandlers.size === 0) {
					this.bufferedDispatches.push(payload);
					writeGatewayTrace(
						`sessionBridge buffered dispatch (no handlers) runtimeId=${this.opts.runtimeId} bufferSize=${this.bufferedDispatches.length} dispatchId=${payload.dispatchId}`,
					);
					return;
				}
				for (const cb of this.turnDispatchHandlers) {
					this.invokeDispatchHandler(cb, payload);
				}
			},
		);
		this.clientCloseUnsubscribe = client.onClose(() => {
			if (this.client !== client || !this.started || this.stopped) return;
			writeGatewayTrace(
				`sessionBridge connection closed runtimeId=${this.opts.runtimeId}`,
			);
			this.kickReconnect().catch(() => {});
		});
	}
}

export type {PermissionRelayResult, QuestionRelayResult};
