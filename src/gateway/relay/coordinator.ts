/**
 * RelayCoordinator — broadcasts permission/question relay requests to every
 * registered channel adapter that advertises the corresponding capability,
 * races the per-adapter promises, and propagates cancellation to losers.
 *
 * Replaces the legacy in-host PermissionRelay/QuestionRelay/ChannelRegistry
 * trio. The coordinator does not own the adapters; the gateway daemon's
 * `ChannelManager` does. We accept an iterator factory so the coordinator
 * picks up adapters added after construction.
 *
 * Cancellation semantics:
 *   - Each broadcast spawns one AbortController per relay-capable adapter
 *     and awaits the first promise to resolve with a `verdict`/`answer`.
 *     All other controllers are aborted with the cancel reason; results
 *     coming back from those adapters after abort are ignored.
 *   - `cancel(channelRequestId, reason)` looks up the broadcast and aborts
 *     every controller. The pending request resolves with
 *     `{kind: 'cancelled', reason}`.
 *   - The internal TTL timer aborts all controllers and resolves the
 *     request with `{kind: 'cancelled', reason: 'timeout'}`.
 *
 * No relay-capable adapters? `request*` resolves with `{kind: 'no_relay'}`
 * so the caller can fall back to local-only resolution.
 */

import type {
	ChannelAdapter,
	PermissionRelayRequest,
	PermissionRelayResult,
	QuestionRelayRequest,
	QuestionRelayResult,
	RelayCancelReason,
} from '../../shared/gateway-protocol';
import {generateChannelRequestId} from './ids';

export const DEFAULT_RELAY_TTL_MS = 5 * 60_000;

export type AdapterSource = () => ReadonlyArray<ChannelAdapter>;

export type RelayCoordinatorOptions = {
	adapters: AdapterSource;
	defaultTtlMs?: number;
	now?: () => number;
	idFactory?: () => string;
	log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
};

type PendingPermissionEntry = {
	kind: 'permission';
	channelRequestId: string;
	fingerprint: string;
	runtimeId?: string;
	controllers: AbortController[];
	timer: NodeJS.Timeout;
	resolve: (result: PermissionRelayResult) => void;
	result: Promise<PermissionRelayResult>;
	settled: boolean;
};

type PendingQuestionEntry = {
	kind: 'question';
	channelRequestId: string;
	fingerprint: string;
	runtimeId?: string;
	controllers: AbortController[];
	timer: NodeJS.Timeout;
	resolve: (result: QuestionRelayResult) => void;
	result: Promise<QuestionRelayResult>;
	settled: boolean;
};

type PendingEntry = PendingPermissionEntry | PendingQuestionEntry;

export type PermissionBroadcast = {
	channelRequestId: string;
	result: Promise<PermissionRelayResult>;
};

export type QuestionBroadcast = {
	channelRequestId: string;
	result: Promise<QuestionRelayResult>;
};

export class RelayCoordinator {
	private readonly adapters: AdapterSource;
	private readonly defaultTtlMs: number;
	private readonly idFactory: () => string;
	private readonly log: RelayCoordinatorOptions['log'];
	private readonly pending = new Map<string, PendingEntry>();

	constructor(opts: RelayCoordinatorOptions) {
		this.adapters = opts.adapters;
		this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_RELAY_TTL_MS;
		this.idFactory = opts.idFactory ?? generateChannelRequestId;
		this.log = opts.log;
	}

	requestPermission(
		req: Omit<PermissionRelayRequest, 'channelRequestId'> & {
			channelRequestId?: string;
			ttlMs?: number;
			runtimeId?: string;
		},
	): PermissionBroadcast {
		const channelRequestId = req.channelRequestId ?? this.idFactory();
		const ttlMs = req.ttlMs ?? this.defaultTtlMs;
		const targets = this.adapters().filter(
			a =>
				a.capabilities.relayPermission &&
				typeof a.requestPermissionVerdict === 'function',
		);
		if (targets.length === 0) {
			return {
				channelRequestId,
				result: Promise.resolve({kind: 'no_relay'}),
			};
		}
		const fingerprint = permissionFingerprint(req);
		const existing = this.pending.get(channelRequestId);
		if (existing) {
			if (existing.kind !== 'permission') {
				throw new Error(
					`channel_request_id_collision: ${channelRequestId} is bound to a question relay`,
				);
			}
			if (existing.fingerprint !== fingerprint) {
				throw new Error(
					`channel_request_id_collision: ${channelRequestId} payload mismatch`,
				);
			}
			return {channelRequestId, result: existing.result};
		}

		const controllers = targets.map(() => new AbortController());
		let resolveFn!: (result: PermissionRelayResult) => void;
		const result = new Promise<PermissionRelayResult>(resolve => {
			resolveFn = resolve;
		});
		const timer = setTimeout(() => {
			this.settlePermission(channelRequestId, {
				kind: 'cancelled',
				reason: 'timeout',
			});
		}, ttlMs);
		if (typeof timer.unref === 'function') timer.unref();
		const entry: PendingPermissionEntry = {
			kind: 'permission',
			channelRequestId,
			fingerprint,
			...(req.runtimeId !== undefined ? {runtimeId: req.runtimeId} : {}),
			controllers,
			timer,
			resolve: resolveFn,
			result,
			settled: false,
		};
		this.pending.set(channelRequestId, entry);

		const fullReq: PermissionRelayRequest = {
			channelRequestId,
			toolName: req.toolName,
			description: req.description,
			inputPreview: req.inputPreview,
		};

		targets.forEach((adapter, idx) => {
			const ctrl = controllers[idx]!;
			Promise.resolve()
				.then(() => adapter.requestPermissionVerdict!(fullReq, ctrl.signal))
				.then(res => {
					if (res.kind === 'verdict') {
						this.settlePermission(channelRequestId, {
							...res,
							channelId: adapter.id,
						});
					}
				})
				.catch(err => {
					this.log?.(
						'warn',
						`adapter ${adapter.id} permission relay failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				});
		});

		return {channelRequestId, result};
	}

	requestQuestion(
		req: Omit<QuestionRelayRequest, 'channelRequestId'> & {
			channelRequestId?: string;
			ttlMs?: number;
			runtimeId?: string;
		},
	): QuestionBroadcast {
		const channelRequestId = req.channelRequestId ?? this.idFactory();
		const ttlMs = req.ttlMs ?? this.defaultTtlMs;
		const targets = this.adapters().filter(
			a =>
				a.capabilities.relayQuestion &&
				typeof a.requestQuestionAnswer === 'function',
		);
		if (targets.length === 0) {
			return {
				channelRequestId,
				result: Promise.resolve({kind: 'no_relay'}),
			};
		}
		const fingerprint = questionFingerprint(req);
		const existing = this.pending.get(channelRequestId);
		if (existing) {
			if (existing.kind !== 'question') {
				throw new Error(
					`channel_request_id_collision: ${channelRequestId} is bound to a permission relay`,
				);
			}
			if (existing.fingerprint !== fingerprint) {
				throw new Error(
					`channel_request_id_collision: ${channelRequestId} payload mismatch`,
				);
			}
			return {channelRequestId, result: existing.result};
		}

		const controllers = targets.map(() => new AbortController());
		let resolveFn!: (result: QuestionRelayResult) => void;
		const result = new Promise<QuestionRelayResult>(resolve => {
			resolveFn = resolve;
		});
		const timer = setTimeout(() => {
			this.settleQuestion(channelRequestId, {
				kind: 'cancelled',
				reason: 'timeout',
			});
		}, ttlMs);
		if (typeof timer.unref === 'function') timer.unref();
		const entry: PendingQuestionEntry = {
			kind: 'question',
			channelRequestId,
			fingerprint,
			...(req.runtimeId !== undefined ? {runtimeId: req.runtimeId} : {}),
			controllers,
			timer,
			resolve: resolveFn,
			result,
			settled: false,
		};
		this.pending.set(channelRequestId, entry);

		const fullReq: QuestionRelayRequest = {
			channelRequestId,
			title: req.title,
			questions: req.questions,
		};

		targets.forEach((adapter, idx) => {
			const ctrl = controllers[idx]!;
			Promise.resolve()
				.then(() => adapter.requestQuestionAnswer!(fullReq, ctrl.signal))
				.then(res => {
					if (res.kind === 'answer') {
						this.settleQuestion(channelRequestId, {
							...res,
							channelId: adapter.id,
						});
					}
				})
				.catch(err => {
					this.log?.(
						'warn',
						`adapter ${adapter.id} question relay failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				});
		});

		return {channelRequestId, result};
	}

	cancel(
		channelRequestId: string,
		reason: RelayCancelReason,
		expectedRuntimeId?: string,
	): boolean {
		const entry = this.pending.get(channelRequestId);
		if (!entry) return false;
		if (
			expectedRuntimeId !== undefined &&
			entry.runtimeId !== undefined &&
			entry.runtimeId !== expectedRuntimeId
		) {
			return false;
		}
		if (entry.kind === 'permission') {
			this.settlePermission(channelRequestId, {kind: 'cancelled', reason});
		} else {
			this.settleQuestion(channelRequestId, {kind: 'cancelled', reason});
		}
		return true;
	}

	pendingCount(): number {
		return this.pending.size;
	}

	disposeAll(reason: RelayCancelReason = 'auto_resolved'): void {
		for (const id of [...this.pending.keys()]) {
			this.cancel(id, reason);
		}
	}

	private settlePermission(
		channelRequestId: string,
		result: PermissionRelayResult,
	): void {
		const entry = this.pending.get(channelRequestId);
		if (!entry || entry.kind !== 'permission' || entry.settled) return;
		entry.settled = true;
		this.pending.delete(channelRequestId);
		clearTimeout(entry.timer);
		for (const ctrl of entry.controllers) {
			if (!ctrl.signal.aborted) ctrl.abort();
		}
		entry.resolve(result);
	}

	private settleQuestion(
		channelRequestId: string,
		result: QuestionRelayResult,
	): void {
		const entry = this.pending.get(channelRequestId);
		if (!entry || entry.kind !== 'question' || entry.settled) return;
		entry.settled = true;
		this.pending.delete(channelRequestId);
		clearTimeout(entry.timer);
		for (const ctrl of entry.controllers) {
			if (!ctrl.signal.aborted) ctrl.abort();
		}
		entry.resolve(result);
	}
}

function permissionFingerprint(req: {
	toolName: string;
	description: string;
	inputPreview: string;
}): string {
	return JSON.stringify([req.toolName, req.description, req.inputPreview]);
}

function questionFingerprint(req: {
	title: string;
	questions: QuestionRelayRequest['questions'];
}): string {
	return JSON.stringify([req.title, req.questions]);
}
