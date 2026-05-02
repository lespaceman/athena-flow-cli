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
import net from 'node:net';
import type {
	ControlEnvelope,
	ControlPushEnvelope,
	ControlResponseEnvelope,
} from '../../shared/gateway-protocol';
import {encodeLine, LineReader, LineReaderOverflowError} from './lineReader';

export type ControlClientOptions = {
	socketPath: string;
	token: string;
	timeoutMs?: number;
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
	constructor(message: string) {
		super(message);
		this.name = 'GatewayProtocolError';
	}
}

export type ControlClient = {
	request<TPayload, TResponse>(
		kind: string,
		payload: TPayload,
	): Promise<TResponse>;
	onPush: (
		kind: string,
		cb: (envelope: ControlPushEnvelope) => void,
	) => () => void;
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
	const socket = net.createConnection({path: opts.socketPath});

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.destroy();
			reject(
				new GatewayUnreachableError(`connect timed out after ${timeoutMs}ms`),
			);
		}, timeoutMs);
		socket.once('connect', () => {
			clearTimeout(timer);
			resolve();
		});
		socket.once('error', err => {
			clearTimeout(timer);
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ECONNREFUSED') {
				reject(
					new GatewayUnreachableError(
						`gateway not reachable at ${opts.socketPath}: ${err.message}`,
					),
				);
			} else {
				reject(err);
			}
		});
	});

	const reader = new LineReader();
	const helloWaiters: Array<(line: string) => void> = [];
	const pending = new Map<string, PendingResolver>();
	const pushSubs = new Map<string, Set<(env: ControlPushEnvelope) => void>>();
	let helloAcked = false;

	const handleLine = (line: string): void => {
		if (!helloAcked) {
			const w = helloWaiters.shift();
			if (w) w(line);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
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

	socket.on('data', chunk => {
		let lines: string[];
		try {
			lines = reader.push(chunk);
		} catch (err) {
			if (err instanceof LineReaderOverflowError) {
				socket.destroy();
				return;
			}
			throw err;
		}
		for (const line of lines) handleLine(line);
	});

	socket.on('close', () => {
		for (const [, p] of pending) {
			clearTimeout(p.timer);
			p.reject(new GatewayProtocolError('connection closed'));
		}
		pending.clear();
	});

	const helloLinePromise = new Promise<string>(resolve =>
		helloWaiters.push(resolve),
	);
	socket.write(encodeLine({kind: 'connect', token: opts.token}));
	const helloLine = await helloLinePromise;
	let hello: unknown;
	try {
		hello = JSON.parse(helloLine);
	} catch {
		socket.destroy();
		throw new GatewayProtocolError('invalid hello frame');
	}
	if (!isStringRecord(hello) || hello['ok'] !== true) {
		socket.destroy();
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
	): Promise<TResponse> => {
		const requestId = crypto.randomUUID();
		const envelope: ControlEnvelope<string, TPayload> = {
			request_id: requestId,
			ts: Date.now(),
			kind,
			payload,
		};
		const responsePromise = new Promise<ControlResponseEnvelope>(
			(resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(requestId);
					reject(new GatewayProtocolError(`request ${kind} timed out`));
				}, timeoutMs);
				pending.set(requestId, {resolve, reject, timer});
			},
		);
		socket.write(encodeLine(envelope));
		const res = await responsePromise;
		if (res.request_id !== requestId) {
			throw new GatewayProtocolError('response request_id mismatch');
		}
		if (!res.ok) {
			throw new GatewayProtocolError(`${res.error.code}: ${res.error.message}`);
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
		close: () => {
			socket.end();
			socket.destroy();
		},
	};
}

function isStringRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
