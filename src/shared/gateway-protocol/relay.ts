/**
 * Relay surface — permission verdict + question answer requests dispatched
 * across registered channel adapters.
 *
 * The gateway daemon owns a `RelayCoordinator` that broadcasts each request
 * to every adapter advertising the relevant capability. Whoever produces the
 * first answer wins; losers are aborted via the supplied AbortSignal. The
 * coordinator times out internally and returns a `timeout` result rather
 * than rejecting, so callers always get a structured outcome.
 */

export type RelayCancelReason =
	| 'resolved_locally'
	| 'resolved_by_other_channel'
	| 'auto_resolved'
	| 'timeout';

export type RelayQuestionOption = {
	label: string;
	description: string;
};

export type RelayQuestion = {
	key: string;
	header: string;
	question: string;
	multi_select: boolean;
	options: RelayQuestionOption[];
};

export type PermissionRelayRequest = {
	channelRequestId: string;
	toolName: string;
	description: string;
	inputPreview: string;
};

export type PermissionRelayResult =
	| {kind: 'verdict'; behavior: 'allow' | 'deny'; channelId: string}
	| {kind: 'cancelled'; reason: RelayCancelReason}
	| {kind: 'no_relay'};

export type QuestionRelayRequest = {
	channelRequestId: string;
	title: string;
	questions: RelayQuestion[];
};

export type QuestionRelayResult =
	| {kind: 'answer'; answers: Record<string, string>; channelId: string}
	| {kind: 'cancelled'; reason: RelayCancelReason}
	| {kind: 'no_relay'};
