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

import {connect, type ControlClient} from '../../gateway/control/client';
import {resolveGatewayPaths, type GatewayPaths} from '../../gateway/paths';
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
} from '../../shared/gateway-protocol';
import {readFileSync} from 'node:fs';

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
	paths?: GatewayPaths;
	/** Override token loader for tests. */
	loadToken?: (tokenPath: string) => string;
	/** Pre-resolved client; bypasses the UDS connect step (test affordance). */
	client?: ControlClient;
};

export type TurnDispatchHandler = (
	payload: SessionDispatchTurnPushPayload,
) => void | Promise<void>;

export type SessionBridgePermissionRequest = {
	channelRequestId?: string;
	toolName: string;
	description: string;
	inputPreview: string;
	ttlMs?: number;
};

export type SessionBridgeQuestionRequest = {
	channelRequestId?: string;
	title: string;
	questions: RelayQuestion[];
	ttlMs?: number;
};

export type SessionBridgeTurnComplete = {
	dispatchId: string;
	location: ChannelLocation;
	text: string;
	idempotencyKey: string;
};

export class SessionBridge {
	private readonly opts: SessionBridgeOptions;
	private client: ControlClient | null = null;
	private turnDispatchUnsubscribe: (() => void) | null = null;
	private readonly turnDispatchHandlers = new Set<TurnDispatchHandler>();
	private started = false;

	constructor(opts: SessionBridgeOptions) {
		this.opts = opts;
	}

	async start(): Promise<SessionRegisterResponsePayload> {
		if (this.started) {
			throw new Error('session bridge already started');
		}
		const paths = this.opts.paths ?? resolveGatewayPaths();
		const client =
			this.opts.client ??
			(await connect({
				socketPath: paths.socketPath,
				token: (this.opts.loadToken ?? defaultLoadToken)(paths.tokenPath),
			}));
		this.client = client;
		this.turnDispatchUnsubscribe = client.onPush(
			'session.dispatch.turn',
			(envelope: ControlPushEnvelope) => {
				const payload = envelope.payload as SessionDispatchTurnPushPayload;
				for (const cb of this.turnDispatchHandlers) {
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
			},
		);
		const req: SessionRegisterRequestPayload = {
			runtimeId: this.opts.runtimeId,
			defaultAgentId: this.opts.defaultAgentId,
			pid: this.opts.pid ?? process.pid,
		};
		const res = await client.request<
			SessionRegisterRequestPayload,
			SessionRegisterResponsePayload
		>('session.register', req);
		this.started = true;
		return res;
	}

	async stop(): Promise<void> {
		const client = this.client;
		if (!client) return;
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
		client.close();
		this.client = null;
		this.started = false;
	}

	onTurnDispatch(cb: TurnDispatchHandler): () => void {
		this.turnDispatchHandlers.add(cb);
		return () => {
			this.turnDispatchHandlers.delete(cb);
		};
	}

	async completeTurn(
		input: SessionBridgeTurnComplete,
	): Promise<SessionTurnCompleteResponsePayload> {
		const client = this.requireClient();
		const req: SessionTurnCompleteRequestPayload = {
			runtimeId: this.opts.runtimeId,
			dispatchId: input.dispatchId,
			location: input.location,
			text: input.text,
			idempotencyKey: input.idempotencyKey,
		};
		return client.request<
			SessionTurnCompleteRequestPayload,
			SessionTurnCompleteResponsePayload
		>('session.turn.complete', req);
	}

	async relayPermission(
		req: SessionBridgePermissionRequest,
	): Promise<RelayPermissionResponsePayload> {
		const client = this.requireClient();
		const payload: RelayPermissionRequestPayload = {
			...(req.channelRequestId !== undefined
				? {channelRequestId: req.channelRequestId}
				: {}),
			toolName: req.toolName,
			description: req.description,
			inputPreview: req.inputPreview,
			...(req.ttlMs !== undefined ? {ttlMs: req.ttlMs} : {}),
		};
		return client.request<
			RelayPermissionRequestPayload,
			RelayPermissionResponsePayload
		>('relay.permission.request', payload, {
			timeoutMs: req.ttlMs ?? RELAY_REQUEST_TIMEOUT_MS,
		});
	}

	async relayQuestion(
		req: SessionBridgeQuestionRequest,
	): Promise<RelayQuestionResponsePayload> {
		const client = this.requireClient();
		const payload: RelayQuestionRequestPayload = {
			...(req.channelRequestId !== undefined
				? {channelRequestId: req.channelRequestId}
				: {}),
			title: req.title,
			questions: req.questions,
			...(req.ttlMs !== undefined ? {ttlMs: req.ttlMs} : {}),
		};
		return client.request<
			RelayQuestionRequestPayload,
			RelayQuestionResponsePayload
		>('relay.question.request', payload, {
			timeoutMs: req.ttlMs ?? RELAY_REQUEST_TIMEOUT_MS,
		});
	}

	async cancelRelayPermission(
		channelRequestId: string,
		reason: RelayCancelReason,
	): Promise<boolean> {
		const client = this.requireClient();
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
		const client = this.requireClient();
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
}

export type {PermissionRelayResult, QuestionRelayResult};

function defaultLoadToken(tokenPath: string): string {
	return readFileSync(tokenPath, 'utf8').trim();
}
