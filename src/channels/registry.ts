/**
 * Composes a `PermissionRelay` with one or more `ChannelHost`s, fanning
 * permission requests out and routing verdicts back through the relay.
 */

import type {
	Runtime,
	RuntimeDecision,
	RuntimeEvent,
} from '../core/runtime/types';
import {generateChannelRequestId} from './ids';
import {ChannelDaemonClient} from './daemonClient';
import type {PermissionRelay} from './permissionRelay';
import type {QuestionRelay} from './questionRelay';
import type {PushChannelFeedEvent} from './feedEvents';
import type {
	ChannelCancelReason,
	ChannelQuestion,
	ChannelDefinition,
	ChannelEventMessage,
	ClaimSource,
	QuestionClaimSource,
} from './types';

/** Telegram caps messages at 4096 chars; leave room for an ellipsis. */
const MAX_NOTIFICATION_LEN = 4000;

export type InboundChatMessage = {
	channel_name: string;
	sender_id: string;
	content: string;
};

export type InboundChatHandler = (msg: InboundChatMessage) => void;

export type ChannelRegistryOptions = {
	sessionId: string;
	relay: PermissionRelay;
	questionRelay?: QuestionRelay;
	runtime: Runtime;
	channels: ChannelDefinition[];
	pushFeedEvent?: PushChannelFeedEvent;
	logError?: (channelName: string, message: string) => void;
};

function reasonForSource(source: ClaimSource): ChannelCancelReason {
	switch (source) {
		case 'local':
			return 'resolved_locally';
		case 'channel':
			return 'resolved_by_other_channel';
		case 'timeout':
			return 'timeout';
		case 'rule':
			return 'auto_resolved';
	}
}

function reasonForQuestionSource(
	source: QuestionClaimSource,
): ChannelCancelReason {
	switch (source) {
		case 'local':
			return 'resolved_locally';
		case 'channel':
			return 'resolved_by_other_channel';
		case 'timeout':
			return 'timeout';
	}
}

export class ChannelRegistry {
	private readonly clients: ChannelDaemonClient[] = [];
	private readonly sessionId: string;
	private readonly relay: PermissionRelay;
	private readonly questionRelay: QuestionRelay | undefined;
	private readonly runtime: Runtime;
	private pushFeedEvent: PushChannelFeedEvent | undefined;
	private onChatMessage: InboundChatHandler | undefined;
	private readonly logError:
		| ((channelName: string, message: string) => void)
		| undefined;
	private disposed = false;

	constructor(opts: ChannelRegistryOptions) {
		this.sessionId = opts.sessionId;
		this.relay = opts.relay;
		this.questionRelay = opts.questionRelay;
		this.runtime = opts.runtime;
		this.pushFeedEvent = opts.pushFeedEvent;
		this.logError = opts.logError;

		this.relay.setOnClaimed((entry, source, context) => {
			if (this.clients.length === 0) return;
			const reason = reasonForSource(source);
			for (const client of this.clients) {
				client.send({
					session_id: this.sessionId,
					method: 'permission.cancel',
					params: {channel_request_id: entry.channelRequestId, reason},
				});
			}
			this.pushFeedEvent?.({
				kind: 'channel.permission.resolved',
				data: {
					channel_name:
						source === 'channel' ? (context.resolvingChannelName ?? '') : '',
					channel_request_id: entry.channelRequestId,
					source,
					tool_name: entry.toolName,
					behavior: context.behavior,
				},
			});
		});

		this.questionRelay?.setOnClaimed((entry, source, context) => {
			if (this.clients.length === 0) return;
			const reason = reasonForQuestionSource(source);
			for (const client of this.clients) {
				client.send({
					session_id: this.sessionId,
					method: 'question.cancel',
					params: {channel_request_id: entry.channelRequestId, reason},
				});
			}
			this.pushFeedEvent?.({
				kind: 'channel.question.resolved',
				data: {
					channel_name:
						source === 'channel' ? (context.resolvingChannelName ?? '') : '',
					channel_request_id: entry.channelRequestId,
					source,
					title: entry.title,
					answers: context.answers,
				},
			});
		});

		for (const def of opts.channels) {
			const client = new ChannelDaemonClient({
				definition: def,
				sessionId: this.sessionId,
				handlers: {
					onEvent: ev => this.handleEvent(def.name, ev),
					onExit: (code, signal) => {
						this.logError?.(
							def.name,
							`channel exited (code=${code} signal=${signal})`,
						);
					},
					onError: msg => this.logError?.(def.name, msg),
				},
			});
			this.clients.push(client);
		}
	}

	setPushFeedEvent(handler: PushChannelFeedEvent | undefined): void {
		this.pushFeedEvent = handler;
	}

	/**
	 * Register a handler to receive inbound chat messages (free-text remote
	 * messages that aren't permission verdicts or question answers). The
	 * handler typically forwards the message into the agent as a new user
	 * turn. Pass `undefined` to clear.
	 */
	setOnChatMessage(handler: InboundChatHandler | undefined): void {
		this.onChatMessage = handler;
	}

	/**
	 * Atomic claim from the local UI path. Returns true if the caller may
	 * proceed to call `runtime.sendDecision`; false means another path
	 * (channel verdict, rule, timeout) already resolved the request.
	 */
	tryClaimLocal(runtimeEventId: string, behavior: 'allow' | 'deny'): boolean {
		return this.relay.tryClaim(runtimeEventId, 'local', {
			behavior,
			resolvingChannelName: null,
		});
	}

	tryClaimLocalQuestion(
		runtimeEventId: string,
		answers: Record<string, string>,
	): boolean {
		if (!this.questionRelay) return true;
		return this.questionRelay.tryClaim(runtimeEventId, 'local', {
			answers,
			resolvingChannelName: null,
		});
	}

	startAll(): void {
		for (const client of this.clients) {
			void client.start().catch(err => {
				this.logError?.(
					client.name,
					`start failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}
	}

	requestPermission(event: RuntimeEvent): void {
		if (this.disposed) return;
		const toolName = event.toolName ?? extractToolName(event) ?? 'unknown';
		const channelRequestId = generateChannelRequestId();
		// Always register on the relay so resolvePermission can distinguish
		// "another path claimed first" from "no relay was active". The relay
		// is authoritative regardless of host count.
		this.relay.register(event, channelRequestId, toolName);
		if (this.clients.length === 0) return;
		const description = event.display?.title ?? toolName;
		const inputPreview = buildInputPreview(event);

		for (const client of this.clients) {
			client.send({
				session_id: this.sessionId,
				method: 'permission.request',
				params: {
					channel_request_id: channelRequestId,
					tool_name: toolName,
					description,
					input_preview: inputPreview,
				},
			});
			this.pushFeedEvent?.({
				kind: 'channel.permission.relayed',
				data: {
					channel_name: client.name,
					channel_request_id: channelRequestId,
					tool_name: toolName,
				},
			});
		}
	}

	/**
	 * Notify all channels that the session has been assigned a human-readable
	 * label (e.g. the first user message). Channels may use this to rename
	 * UI elements such as Telegram forum topics.
	 */
	notifySessionLabel(label: string): void {
		if (this.disposed) return;
		if (this.clients.length === 0) return;
		for (const client of this.clients) {
			client.send({
				session_id: this.sessionId,
				method: 'session.update',
				params: {label},
			});
		}
	}

	/**
	 * Fan a one-shot text notification out to all attached channels. Used to
	 * mirror agent assistant messages to remote channels (so the user can read
	 * the conversation on their phone). No relay tracking, no cancellation —
	 * fire-and-forget. Empty/whitespace input is dropped.
	 */
	notify(content: string, meta: Record<string, string> = {}): void {
		if (this.disposed) return;
		if (this.clients.length === 0) return;
		const trimmed = content.trim();
		if (trimmed.length === 0) return;
		const truncated =
			trimmed.length > MAX_NOTIFICATION_LEN
				? trimmed.slice(0, MAX_NOTIFICATION_LEN - 1) + '…'
				: trimmed;
		for (const client of this.clients) {
			client.send({
				session_id: this.sessionId,
				method: 'notification',
				params: {content: truncated, meta},
			});
		}
	}

	requestQuestion(event: RuntimeEvent): void {
		if (this.disposed || !this.questionRelay) return;
		const questions = extractQuestions(event);
		const title = event.display?.title ?? 'Question';
		const channelRequestId = generateChannelRequestId();
		this.questionRelay.register(
			event,
			channelRequestId,
			questions.map(q => q.key),
			title,
		);
		if (this.clients.length === 0) return;

		for (const client of this.clients) {
			client.send({
				session_id: this.sessionId,
				method: 'question.request',
				params: {
					channel_request_id: channelRequestId,
					title,
					questions,
				},
			});
			this.pushFeedEvent?.({
				kind: 'channel.question.relayed',
				data: {
					channel_name: client.name,
					channel_request_id: channelRequestId,
					title,
				},
			});
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const client of this.clients) client.dispose();
		this.clients.length = 0;
		this.relay.dispose();
		this.questionRelay?.dispose();
	}

	private handleEvent(channelName: string, ev: ChannelEventMessage): void {
		if (this.disposed) return;
		if (ev.session_id !== this.sessionId) return;
		switch (ev.event) {
			case 'ready':
				return;
			case 'permission.verdict': {
				const {channel_request_id, behavior} = ev.params;
				const entry = this.relay.resolveByChannelId(channel_request_id);
				if (!entry) return;
				const claimed = this.relay.tryClaim(entry.runtimeEventId, 'channel', {
					behavior,
					resolvingChannelName: channelName,
				});
				if (!claimed) return;
				const decision: RuntimeDecision = {
					type: 'json',
					source: 'user',
					intent:
						behavior === 'allow'
							? {kind: 'permission_allow'}
							: {
									kind: 'permission_deny',
									reason: `Denied via channel: ${channelName}`,
								},
				};
				this.runtime.sendDecision(entry.runtimeEventId, decision);
				return;
			}
			case 'question.answer': {
				const {channel_request_id, answers} = ev.params;
				const entry =
					this.questionRelay?.resolveByChannelId(channel_request_id);
				if (!entry) return;
				const claimed = this.questionRelay!.tryClaim(
					entry.runtimeEventId,
					'channel',
					{answers, resolvingChannelName: channelName},
				);
				if (!claimed) return;
				const decision: RuntimeDecision = {
					type: 'json',
					source: 'user',
					intent: {kind: 'question_answer', answers},
				};
				this.runtime.sendDecision(entry.runtimeEventId, decision);
				return;
			}
			case 'chat.message': {
				const senderId = ev.params.meta['sender_id'] ?? 'unknown';
				this.pushFeedEvent?.({
					kind: 'channel.chat.inbound',
					data: {
						channel_name: channelName,
						sender_id: senderId,
						content: ev.params.content,
					},
				});
				this.onChatMessage?.({
					channel_name: channelName,
					sender_id: senderId,
					content: ev.params.content,
				});
				return;
			}
			case 'error': {
				this.logError?.(channelName, ev.params.message);
				return;
			}
			case 'log': {
				if (ev.params.level === 'error' || ev.params.level === 'warn') {
					this.logError?.(
						channelName,
						`[${ev.params.level}] ${ev.params.message}`,
					);
				}
				return;
			}
		}
	}
}

function extractToolName(event: RuntimeEvent): string | undefined {
	const data = event.data as Record<string, unknown> | undefined;
	const value = data?.['tool_name'];
	return typeof value === 'string' ? value : undefined;
}

function buildInputPreview(event: RuntimeEvent): string {
	const data = event.data as Record<string, unknown> | undefined;
	const toolInput = data?.['tool_input'];
	if (toolInput === undefined) return '';
	try {
		const json = JSON.stringify(toolInput);
		return json.length > 200 ? json.slice(0, 200) + '…' : json;
	} catch {
		return '';
	}
}

function extractQuestions(event: RuntimeEvent): ChannelQuestion[] {
	const data = event.data as Record<string, unknown> | undefined;
	const toolInput =
		typeof data?.['tool_input'] === 'object' && data['tool_input'] !== null
			? (data['tool_input'] as Record<string, unknown>)
			: {};
	const rawQuestions = toolInput['questions'];
	if (!Array.isArray(rawQuestions)) return [];
	return rawQuestions
		.map((raw): ChannelQuestion | null => {
			if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
				return null;
			}
			const q = raw as Record<string, unknown>;
			const question =
				typeof q['question'] === 'string' ? q['question'] : 'Question';
			const header = typeof q['header'] === 'string' ? q['header'] : 'Question';
			const multiSelect =
				typeof q['multiSelect'] === 'boolean'
					? q['multiSelect']
					: typeof q['multi_select'] === 'boolean'
						? q['multi_select']
						: false;
			const options = Array.isArray(q['options'])
				? q['options']
						.map(option => {
							if (
								typeof option !== 'object' ||
								option === null ||
								Array.isArray(option)
							) {
								return null;
							}
							const o = option as Record<string, unknown>;
							return {
								label: typeof o['label'] === 'string' ? o['label'] : '',
								description:
									typeof o['description'] === 'string' ? o['description'] : '',
							};
						})
						.filter(
							(o): o is {label: string; description: string} => o !== null,
						)
				: [];
			return {
				key: question,
				header,
				question,
				multi_select: multiSelect,
				options,
			};
		})
		.filter((q): q is ChannelQuestion => q !== null);
}
