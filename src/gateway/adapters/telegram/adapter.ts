/**
 * In-daemon Telegram channel adapter.
 *
 * Conforms to `ChannelAdapter`. Long-polls Telegram via `TelegramBot` from
 * `shared/telegram/bot`, normalizes inbound messages, and posts outbound text
 * via `sendMessage`. Permission/question relay flows remain in the legacy
 * channel daemon (`src/channels/telegram/index.ts`) until M6.
 *
 * Idempotency keys for inbound use the Telegram `update_id` (per-bot stable
 * monotonic counter); outbound idempotency is the caller's responsibility —
 * we forward `text` straight to `sendMessage` and surface the assigned
 * `message_id` as `providerMessageId`.
 */

import {TelegramBot, type TelegramUpdate} from '../../../shared/telegram/bot';
import type {
	AdapterContext,
	ChannelAdapter,
	ChannelCapabilities,
	ChannelHealthListener,
	ChannelInboundListener,
	HealthSample,
	NormalizedInbound,
	OutboundMessage,
	ProbeResult,
	SendResult,
	StopReason,
} from '../../../shared/gateway-protocol';

export type TelegramAdapterOptions = {
	/** Bot token from BotFather. Required. */
	token: string;
	/** Sender allowlist (Telegram numeric user ids as strings). Empty = closed. */
	allowedUserIds: ReadonlyArray<string>;
	/** Override base URL for tests. */
	apiBase?: string;
	/** Long-poll timeout seconds. */
	pollTimeoutSec?: number;
	/** Override bot factory for tests. */
	botFactory?: (opts: {
		token: string;
		apiBase?: string;
		pollTimeoutSec?: number;
		log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
	}) => TelegramBot;
};

const TELEGRAM_ID = 'telegram';

export class TelegramAdapter implements ChannelAdapter {
	readonly id = TELEGRAM_ID;
	readonly capabilities: ChannelCapabilities = {
		chat: true,
		threads: true,
		// Telegram caps text at 4096 chars; we leave chunking to the manager.
		maxMessageBytes: 4096,
	};

	private bot: TelegramBot | null = null;
	private readonly opts: TelegramAdapterOptions;
	private readonly inboundListeners = new Set<ChannelInboundListener>();
	private readonly healthListeners = new Set<ChannelHealthListener>();
	private pollTask: Promise<void> | null = null;
	private lastInboundAt: number | undefined;
	private lastTransportOk = true;
	private ctx: AdapterContext | null = null;

	constructor(opts: TelegramAdapterOptions) {
		this.opts = opts;
	}

	async start(ctx: AdapterContext): Promise<void> {
		if (this.bot) {
			throw new Error('telegram adapter already started');
		}
		this.ctx = ctx;
		const factory =
			this.opts.botFactory ??
			((o): TelegramBot =>
				new TelegramBot(
					{
						token: o.token,
						apiBase: o.apiBase,
						pollTimeoutSec: o.pollTimeoutSec,
					},
					o.log,
				));
		this.bot = factory({
			token: this.opts.token,
			apiBase: this.opts.apiBase,
			pollTimeoutSec: this.opts.pollTimeoutSec,
			log: ctx.log,
		});
		this.pollTask = this.runPollLoop();
		ctx.signal.addEventListener('abort', () => {
			this.bot?.stop();
		});
	}

	async stop(_reason: StopReason): Promise<void> {
		this.bot?.stop();
		const task = this.pollTask;
		this.pollTask = null;
		if (task) {
			try {
				await task;
			} catch {
				// poll loop logs its own errors; nothing to add here
			}
		}
		this.bot = null;
		this.ctx = null;
	}

	async send(msg: OutboundMessage): Promise<SendResult> {
		const bot = this.bot;
		if (!bot) {
			throw new Error('telegram adapter: send called before start');
		}
		const chatId = msg.location.peer?.id ?? msg.location.room?.id;
		if (!chatId) {
			throw new Error(
				'telegram adapter: outbound location has no peer or room',
			);
		}
		const threadId = msg.location.thread?.id
			? Number(msg.location.thread.id)
			: undefined;
		const result = await bot.sendMessage(chatId, msg.text, {
			...(threadId !== undefined && Number.isFinite(threadId)
				? {message_thread_id: threadId}
				: {}),
		});
		if (!result) {
			throw new Error('telegram adapter: sendMessage returned null');
		}
		return {
			providerMessageId: String(result.message_id),
			deliveredAt: Date.now(),
		};
	}

	async probe(): Promise<ProbeResult> {
		// `getMe` would be cleanest, but the bot client doesn't expose it; the
		// long-poll loop's last error is the most accurate signal we have. A
		// dedicated probe RPC arrives with the gateway probe surface in M3+.
		return {
			ok: this.lastTransportOk,
			detail: this.lastTransportOk ? 'long-poll healthy' : 'long-poll erroring',
			checkedAt: Date.now(),
		};
	}

	on(event: 'inbound', cb: ChannelInboundListener): void;
	on(event: 'health', cb: ChannelHealthListener): void;
	on(event: 'inbound' | 'health', cb: unknown): void {
		if (event === 'inbound') {
			this.inboundListeners.add(cb as ChannelInboundListener);
		} else {
			this.healthListeners.add(cb as ChannelHealthListener);
		}
	}

	off(event: 'inbound', cb: ChannelInboundListener): void;
	off(event: 'health', cb: ChannelHealthListener): void;
	off(event: 'inbound' | 'health', cb: unknown): void {
		if (event === 'inbound') {
			this.inboundListeners.delete(cb as ChannelInboundListener);
		} else {
			this.healthListeners.delete(cb as ChannelHealthListener);
		}
	}

	private async runPollLoop(): Promise<void> {
		const bot = this.bot;
		const ctx = this.ctx;
		if (!bot || !ctx) return;
		const allow =
			this.opts.allowedUserIds.length === 0
				? null
				: new Set(this.opts.allowedUserIds.map(String));
		try {
			for await (const update of bot.poll()) {
				const inbound = normalizeInbound(update, allow);
				if (!inbound) continue;
				this.lastInboundAt = inbound.receivedAt;
				this.markHealth(true);
				for (const cb of this.inboundListeners) {
					try {
						cb(inbound);
					} catch (err) {
						ctx.log(
							'warn',
							`telegram inbound listener threw: ${
								err instanceof Error ? err.message : String(err)
							}`,
						);
					}
				}
			}
		} catch (err) {
			this.markHealth(false, err instanceof Error ? err.message : String(err));
			ctx.log(
				'error',
				`telegram poll loop terminated: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			throw err;
		}
	}

	private markHealth(ok: boolean, note?: string): void {
		this.lastTransportOk = ok;
		const sample: HealthSample = {
			at: Date.now(),
			transportOk: ok,
			...(this.lastInboundAt !== undefined
				? {lastInboundAt: this.lastInboundAt}
				: {}),
			...(note !== undefined ? {note} : {}),
		};
		for (const cb of this.healthListeners) {
			try {
				cb(sample);
			} catch {
				// listener errors must not break the poll loop
			}
		}
	}
}

function normalizeInbound(
	update: TelegramUpdate,
	allow: Set<string> | null,
): NormalizedInbound | null {
	const message = update.message ?? update.edited_message;
	if (!message) return null;
	const text = message.text;
	if (typeof text !== 'string' || text.length === 0) return null;
	const sender = message.from;
	if (!sender) return null;
	const senderId = String(sender.id);
	if (allow && !allow.has(senderId)) return null;

	const accountId = String(sender.is_bot ? `bot:${sender.id}` : 'user');
	const chatId = String(message.chat.id);
	const isPrivate = message.chat.type === 'private';
	const threadId =
		typeof message.message_thread_id === 'number'
			? String(message.message_thread_id)
			: undefined;

	return {
		location: {
			channelId: TELEGRAM_ID,
			accountId,
			...(isPrivate
				? {peer: {id: chatId, kind: 'user' as const}}
				: {
						room: {
							id: chatId,
							kind:
								message.chat.type === 'channel'
									? ('channel' as const)
									: ('group' as const),
						},
					}),
			...(threadId !== undefined ? {thread: {id: threadId}} : {}),
		},
		sender: {
			id: senderId,
			...(sender.username !== undefined
				? {displayName: sender.username}
				: sender.first_name !== undefined
					? {displayName: sender.first_name}
					: {}),
		},
		text,
		receivedAt: Date.now(),
		idempotencyKey: `tg:${update.update_id}`,
		providerMessageId: String(message.message_id),
	};
}
