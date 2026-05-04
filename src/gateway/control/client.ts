/**
 * UDS NDJSON client for the gateway control plane.
 *
 * Long-lived connection: tracks pending requests by `request_id` and routes
 * unsolicited push frames (those carrying `push_id` instead of `request_id`)
 * to subscribers registered via `onPush`. The session bridge in
 * `app/channels/sessionBridge.ts` (M5+) opens one of these per Athena
 * runtime and stays connected.
 */

import crypto from 'node:crypto';
import type {
	ControlEnvelope,
	ControlPushEnvelope,
	ControlResponseEnvelope,
} from '../../shared/gateway-protocol';
import {
	TransportUnreachableError,
	type ClientTransport,
} from '../transport/types';
import {createUdsClientTransport} from '../transport/uds';

export type ControlClientOptions = {
	socketPath: string;
	token: string;
	timeoutMs?: number;
	transport?: ClientTransport;
};

export class GatewayUnreachableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GatewayUnreachableError';
	}
}

export class GatewayUnauthorizedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GatewayUnauthorizedError';
	}
}

export class GatewayProtocolError extends Error {
	readonly code?: string;
	constructor(message: string, code?: string) {
		super(message);
		this.name = 'GatewayProtocolError';
		if (code !== undefined) this.code = code;
	}
}

export type ControlRequestOptions = {
	/** Override the per-client default timeout for this single request. */
	timeoutMs?: number;
};

export type ControlClient = {
	request<TPayload, TResponse>(
		kind: string,
		payload: TPayload,
		opts?: ControlRequestOptions,
	): Promise<TResponse>;
	onPush: (
		kind: string,
		cb: (envelope: ControlPushEnvelope) => void,
	) => () => void;
	onClose: (cb: () => void) => () => void;
	close: () => void;
};

type PendingResolver = {
	resolve: (env: ControlResponseEnvelope) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
};

export async function connect(
	opts: ControlClientOptions,
): Promise<ControlClient> {
	const timeoutMs = opts.timeoutMs ?? 5_000;
	const transport =
		opts.transport ??
		createUdsClientTransport({socketPath: opts.socketPath, timeoutMs});
	let connection;
	try {
		connection = await transport.connect();
	} catch (err) {
		if (err instanceof TransportUnreachableError) {
			throw new GatewayUnreachableError(err.message);
		}
		throw err;
	}

	const helloWaiters: Array<(frame: unknown) => void> = [];
	const pending = new Map<string, PendingResolver>();
	const pushSubs = new Map<string, Set<(env: ControlPushEnvelope) => void>>();
	const closeSubs = new Set<() => void>();
	let helloAcked = false;

	const handleFrame = (parsed: unknown): void => {
		if (!helloAcked) {
			const w = helloWaiters.shift();
			if (w) w(parsed);
			return;
		}
		if (!isStringRecord(parsed)) return;
		if (typeof parsed['request_id'] === 'string') {
			const requestId = parsed['request_id'] as string;
			const entry = pending.get(requestId);
			if (!entry) return;
			pending.delete(requestId);
			clearTimeout(entry.timer);
			entry.resolve(parsed as ControlResponseEnvelope);
			return;
		}
		if (typeof parsed['push_id'] === 'string') {
			const env = parsed as ControlPushEnvelope;
			const subs = pushSubs.get(env.kind);
			if (!subs) return;
			for (const cb of subs) {
				try {
					cb(env);
				} catch {
					// listener errors must not crash the client
				}
			}
		}
	};

	connection.onFrame(handleFrame);

	connection.onClose(() => {
		for (const [, p] of pending) {
			clearTimeout(p.timer);
			p.reject(
				new GatewayProtocolError('connection closed', 'connection_closed'),
			);
		}
		pending.clear();
		for (const cb of closeSubs) {
			try {
				cb();
			} catch {
				// listener errors must not crash the client
			}
		}
	});

	const helloFramePromise = new Promise<unknown>(resolve =>
		helloWaiters.push(resolve),
	);
	connection.send({kind: 'connect', token: opts.token});
	const hello = await helloFramePromise;
	if (!isStringRecord(hello) || hello['ok'] !== true) {
		connection.close();
		const errPayload =
			isStringRecord(hello) && isStringRecord(hello['error'])
				? hello['error']
				: undefined;
		const code = errPayload?.['code'];
		const msg = errPayload?.['message'] ?? 'unauthorized';
		if (code === 'unauthorized') {
			throw new GatewayUnauthorizedError(String(msg));
		}
		throw new GatewayProtocolError(String(msg));
	}
	helloAcked = true;

	const request = async <TPayload, TResponse>(
		kind: string,
		payload: TPayload,
		reqOpts?: ControlRequestOptions,
	): Promise<TResponse> => {
		const requestId = crypto.randomUUID();
		const envelope: ControlEnvelope<string, TPayload> = {
			request_id: requestId,
			ts: Date.now(),
			kind,
			payload,
		};
		const effectiveTimeoutMs = reqOpts?.timeoutMs ?? timeoutMs;
		const responsePromise = new Promise<ControlResponseEnvelope>(
			(resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(requestId);
					reject(new GatewayProtocolError(`request ${kind} timed out`));
				}, effectiveTimeoutMs);
				pending.set(requestId, {resolve, reject, timer});
			},
		);
		connection.send(envelope);
		const res = await responsePromise;
		if (res.request_id !== requestId) {
			throw new GatewayProtocolError('response request_id mismatch');
		}
		if (!res.ok) {
			throw new GatewayProtocolError(
				`${res.error.code}: ${res.error.message}`,
				res.error.code,
			);
		}
		return res.payload as TResponse;
	};

	const onPush = (
		kind: string,
		cb: (env: ControlPushEnvelope) => void,
	): (() => void) => {
		let subs = pushSubs.get(kind);
		if (!subs) {
			subs = new Set();
			pushSubs.set(kind, subs);
		}
		subs.add(cb);
		const ownSubs = subs;
		return () => {
			ownSubs.delete(cb);
		};
	};

	return {
		request,
		onPush,
		onClose: cb => {
			closeSubs.add(cb);
			return () => closeSubs.delete(cb);
		},
		close: () => {
			connection.close();
		},
	};
}

function isStringRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
