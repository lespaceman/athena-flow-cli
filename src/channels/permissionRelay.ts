/**
 * Authoritative pending-permission tracker.
 *
 * Every path that wants to resolve a permission (local UI dialog, channel
 * verdict, runtime auto/timeout/rule decision) must call `tryClaim` first.
 * Only the winning claimant proceeds; everyone else is a no-op. This is the
 * single defence against double-`sendDecision` races identified in review.
 */

import type {Runtime, RuntimeEvent} from '../core/runtime/types';
import {isDev} from '../shared/utils/env';
import {PENDING_TTL_MS, SWEEP_INTERVAL_MS} from './relayConstants';
import type {ClaimBehavior, ClaimSource, PendingRelay} from './types';

export type ClaimContext = {
	behavior: ClaimBehavior | null;
	resolvingChannelName: string | null;
};

export type OnClaimedHandler = (
	entry: PendingRelay,
	source: ClaimSource,
	context: ClaimContext,
) => void;

export class PermissionRelay {
	private pending = new Map<string, PendingRelay>();
	private byChannelId = new Map<string, string>();
	private onClaimed?: OnClaimedHandler;
	private unsubDecision: (() => void) | undefined;
	private sweepTimer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(opts: {runtime: Runtime}) {
		this.unsubDecision = opts.runtime.onDecision((eventId, decision) => {
			if (this.disposed) return;
			const source: ClaimSource =
				decision.source === 'rule'
					? 'rule'
					: decision.source === 'timeout'
						? 'timeout'
						: 'local';
			this.tryClaim(eventId, source, {
				behavior: decisionBehavior(decision),
				resolvingChannelName: null,
			});
		});
		this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
		// Don't keep the event loop alive just for the sweep timer.
		this.sweepTimer.unref();
	}

	private sweep(): void {
		if (this.disposed) return;
		const cutoff = Date.now() - PENDING_TTL_MS;
		for (const [eventId, entry] of this.pending) {
			if (entry.createdAt < cutoff) {
				this.pending.delete(eventId);
				this.byChannelId.delete(entry.channelRequestId);
			}
		}
	}

	setOnClaimed(handler: OnClaimedHandler): void {
		if (this.onClaimed && isDev()) {
			throw new Error(
				'PermissionRelay.setOnClaimed called twice — concurrent registration would silently lose the previous handler. ' +
					'Call clearOnClaimed() on the prior owner first.',
			);
		}
		this.onClaimed = handler;
	}

	clearOnClaimed(): void {
		this.onClaimed = undefined;
	}

	register(
		event: RuntimeEvent,
		channelRequestId: string,
		toolName: string,
	): PendingRelay {
		if (this.byChannelId.has(channelRequestId)) {
			// Should be vanishingly rare given the 25^5 alphabet, but defend
			// against silent shadowing of an outstanding entry.
			throw new Error(
				`PermissionRelay: channelRequestId collision: ${channelRequestId}`,
			);
		}
		const entry: PendingRelay = {
			runtimeEventId: event.id,
			channelRequestId,
			toolName,
			createdAt: Date.now(),
		};
		this.pending.set(event.id, entry);
		this.byChannelId.set(channelRequestId, entry.runtimeEventId);
		return entry;
	}

	resolveByChannelId(channelRequestId: string): PendingRelay | undefined {
		const eventId = this.byChannelId.get(channelRequestId);
		if (!eventId) return undefined;
		return this.pending.get(eventId);
	}

	isPending(runtimeEventId: string): boolean {
		return this.pending.has(runtimeEventId);
	}

	/** Returns true iff this caller successfully claimed the request. */
	tryClaim(
		runtimeEventId: string,
		source: ClaimSource,
		context: ClaimContext = {behavior: null, resolvingChannelName: null},
	): boolean {
		const entry = this.pending.get(runtimeEventId);
		if (!entry) return false;
		this.pending.delete(runtimeEventId);
		this.byChannelId.delete(entry.channelRequestId);
		try {
			this.onClaimed?.(entry, source, context);
		} catch {
			// onClaimed must not propagate — broadcasting cancels is
			// best-effort; a thrown handler must not corrupt relay state.
		}
		return true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubDecision?.();
		this.unsubDecision = undefined;
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = undefined;
		this.pending.clear();
		this.byChannelId.clear();
	}
}

function decisionBehavior(decision: {
	intent?: {kind: string};
}): ClaimBehavior | null {
	const kind = decision.intent?.kind;
	if (kind === 'permission_allow' || kind === 'pre_tool_allow') return 'allow';
	if (kind === 'permission_deny' || kind === 'pre_tool_deny') return 'deny';
	return null;
}
