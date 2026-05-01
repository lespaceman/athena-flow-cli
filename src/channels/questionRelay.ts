/**
 * Authoritative pending-question tracker.
 *
 * Mirrors PermissionRelay for AskUserQuestion / Codex user_input prompts.
 * Local UI answers, channel answers, and runtime timeout decisions must claim
 * before sending a response so only one path resolves the harness request.
 */

import type {Runtime, RuntimeEvent} from '../core/runtime/types';
import {isDev} from '../shared/utils/env';
import {PENDING_TTL_MS, SWEEP_INTERVAL_MS} from './relayConstants';
import type {PendingQuestionRelay, QuestionClaimSource} from './types';

export type QuestionClaimContext = {
	answers: Record<string, string> | null;
	resolvingChannelName: string | null;
};

export type OnQuestionClaimedHandler = (
	entry: PendingQuestionRelay,
	source: QuestionClaimSource,
	context: QuestionClaimContext,
) => void;

export class QuestionRelay {
	private pending = new Map<string, PendingQuestionRelay>();
	private byChannelId = new Map<string, string>();
	private onClaimed?: OnQuestionClaimedHandler;
	private unsubDecision: (() => void) | undefined;
	private sweepTimer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(opts: {runtime: Runtime}) {
		this.unsubDecision = opts.runtime.onDecision((eventId, decision) => {
			if (this.disposed) return;
			if (
				decision.source !== 'timeout' &&
				decision.intent?.kind !== 'question_answer'
			) {
				return;
			}
			this.tryClaim(
				eventId,
				decision.source === 'timeout' ? 'timeout' : 'local',
				{
					answers:
						decision.intent?.kind === 'question_answer'
							? decision.intent.answers
							: null,
					resolvingChannelName: null,
				},
			);
		});
		this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
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

	setOnClaimed(handler: OnQuestionClaimedHandler): void {
		if (this.onClaimed && isDev()) {
			throw new Error(
				'QuestionRelay.setOnClaimed called twice — concurrent registration would silently lose the previous handler. ' +
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
		questionKeys: string[],
		title = 'Question',
	): PendingQuestionRelay {
		if (this.byChannelId.has(channelRequestId)) {
			throw new Error(
				`QuestionRelay: channelRequestId collision: ${channelRequestId}`,
			);
		}
		const entry: PendingQuestionRelay = {
			runtimeEventId: event.id,
			channelRequestId,
			questionKeys,
			title,
			createdAt: Date.now(),
		};
		this.pending.set(event.id, entry);
		this.byChannelId.set(channelRequestId, event.id);
		return entry;
	}

	resolveByChannelId(
		channelRequestId: string,
	): PendingQuestionRelay | undefined {
		const eventId = this.byChannelId.get(channelRequestId);
		if (!eventId) return undefined;
		return this.pending.get(eventId);
	}

	isPending(runtimeEventId: string): boolean {
		return this.pending.has(runtimeEventId);
	}

	tryClaim(
		runtimeEventId: string,
		source: QuestionClaimSource,
		context: QuestionClaimContext = {
			answers: null,
			resolvingChannelName: null,
		},
	): boolean {
		const entry = this.pending.get(runtimeEventId);
		if (!entry) return false;
		this.pending.delete(runtimeEventId);
		this.byChannelId.delete(entry.channelRequestId);
		try {
			this.onClaimed?.(entry, source, context);
		} catch {
			// Cancellation fan-out is best-effort and must not corrupt relay state.
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
