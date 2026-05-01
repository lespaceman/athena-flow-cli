/**
 * Minimal Telegram Bot API client for the Athena channel.
 *
 * Long-polls `getUpdates` to receive messages and callback queries. Exposes
 * `sendMessage`, `editMessageText`, `editMessageReplyMarkup`,
 * `answerCallbackQuery`, and `setMyCommands` — only the surface needed by
 * the channel is implemented; no third-party Telegram SDK.
 */

export type TelegramUser = {
	id: number;
	is_bot?: boolean;
	first_name?: string;
	last_name?: string;
	username?: string;
};

export type TelegramChat = {
	id: number;
	type: 'private' | 'group' | 'supergroup' | 'channel';
};

export type TelegramMessage = {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	date: number;
	text?: string;
	/** Set for messages sent to a forum topic thread. */
	message_thread_id?: number;
};

export type TelegramCallbackQuery = {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
};

export type TelegramUpdate = {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
};

export type SendMessageResult = {
	message_id: number;
	chat: {id: number};
};

export type InlineKeyboardButton = {
	text: string;
	callback_data?: string;
};

export type InlineKeyboardMarkup = {
	inline_keyboard: InlineKeyboardButton[][];
};

export type ForceReplyMarkup = {
	force_reply: true;
	input_field_placeholder?: string;
	selective?: boolean;
};

export type ReplyMarkup = InlineKeyboardMarkup | ForceReplyMarkup;

export type ParseMode = 'MarkdownV2' | 'HTML';

export type SendMessageOptions = {
	parse_mode?: ParseMode;
	reply_markup?: ReplyMarkup;
	message_thread_id?: number;
};

export type BotCommand = {
	command: string;
	description: string;
};

export type BotOptions = {
	token: string;
	apiBase?: string;
	pollTimeoutSec?: number;
};

export type BotLogger = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

export class TelegramBot {
	private readonly token: string;
	private readonly apiBase: string;
	private readonly pollTimeoutSec: number;
	private offset = 0;
	private stopped = false;
	private readonly log: BotLogger;
	private consecutiveAuthFailures = 0;

	constructor(opts: BotOptions, log: BotLogger) {
		this.token = opts.token;
		this.apiBase = opts.apiBase ?? 'https://api.telegram.org';
		this.pollTimeoutSec = opts.pollTimeoutSec ?? 25;
		this.log = log;
	}

	/** Strip the bot token from any string before logging or surfacing. */
	private redact(text: string): string {
		if (!this.token) return text;
		return text.split(this.token).join('<redacted>');
	}

	stop(): void {
		this.stopped = true;
	}

	async *poll(): AsyncIterable<TelegramUpdate> {
		while (!this.stopped) {
			try {
				const updates = await this.getUpdates();
				this.consecutiveAuthFailures = 0;
				for (const update of updates) {
					// `stopped` may have flipped during the await above (consumer
					// called `stop()`), so re-check explicitly. Cast through
					// `unknown` to keep TS from narrowing the field after the
					// loop guard.
					if ((this as unknown as {stopped: boolean}).stopped) return;
					if (update.update_id >= this.offset) {
						this.offset = update.update_id + 1;
					}
					yield update;
				}
			} catch (err) {
				const raw = err instanceof Error ? err.message : String(err);
				const message = this.redact(raw);
				const status = (err as {status?: number} | undefined)?.status;
				if (status === 401 || status === 409) {
					this.consecutiveAuthFailures++;
					this.log(
						'error',
						`getUpdates failed (HTTP ${status}, attempt ${this.consecutiveAuthFailures}): ${message}`,
					);
					if (this.consecutiveAuthFailures >= 3) {
						// Hot-spinning on a bad token / dual consumer is worse
						// than failing fast; signal the host and stop.
						this.stopped = true;
						throw new Error(
							`telegram channel: persistent HTTP ${status} from getUpdates after 3 attempts`,
						);
					}
				} else {
					this.log('warn', `getUpdates failed: ${message}`);
				}
				await sleep(1500);
			}
		}
	}

	async sendMessage(
		chatId: number | string,
		text: string,
		options: SendMessageOptions = {},
	): Promise<SendMessageResult | null> {
		try {
			const params: Record<string, unknown> = {chat_id: chatId, text};
			if (options.parse_mode) params['parse_mode'] = options.parse_mode;
			if (options.reply_markup) params['reply_markup'] = options.reply_markup;
			if (options.message_thread_id !== undefined)
				params['message_thread_id'] = options.message_thread_id;
			const result = await this.call<SendMessageResult>('sendMessage', params);
			return result;
		} catch (err) {
			this.log(
				'warn',
				`sendMessage failed: ${this.redact(
					err instanceof Error ? err.message : String(err),
				)}`,
			);
			return null;
		}
	}

	async createForumTopic(
		chatId: number | string,
		name: string,
	): Promise<{message_thread_id: number} | null> {
		try {
			return await this.call<{message_thread_id: number}>('createForumTopic', {
				chat_id: chatId,
				name,
			});
		} catch (err) {
			this.log(
				'warn',
				`createForumTopic failed: ${this.redact(
					err instanceof Error ? err.message : String(err),
				)}`,
			);
			return null;
		}
	}

	async editForumTopic(
		chatId: number | string,
		messageThreadId: number,
		name: string,
	): Promise<void> {
		try {
			await this.call('editForumTopic', {
				chat_id: chatId,
				message_thread_id: messageThreadId,
				name,
			});
		} catch (err) {
			this.log(
				'debug',
				`editForumTopic failed: ${this.redact(
					err instanceof Error ? err.message : String(err),
				)}`,
			);
		}
	}

	async closeForumTopic(
		chatId: number | string,
		messageThreadId: number,
	): Promise<void> {
		try {
			await this.call('closeForumTopic', {
				chat_id: chatId,
				message_thread_id: messageThreadId,
			});
		} catch (err) {
			this.log(
				'debug',
				`closeForumTopic failed: ${this.redact(
					err instanceof Error ? err.message : String(err),
				)}`,
			);
		}
	}

	async editMessageText(
		chatId: number | string,
		messageId: number,
		text: string,
		options: SendMessageOptions = {},
	): Promise<void> {
		try {
			const params: Record<string, unknown> = {
				chat_id: chatId,
				message_id: messageId,
				text,
			};
			if (options.parse_mode) params['parse_mode'] = options.parse_mode;
			if (options.reply_markup) params['reply_markup'] = options.reply_markup;
			await this.call('editMessageText', params);
		} catch (err) {
			this.log(
				'debug',
				`editMessageText failed: ${this.redact(
					err instanceof Error ? err.message : String(err),
				)}`,
			);
		}
	}

	async editMessageReplyMarkup(
		chatId: number | string,
		messageId: number,
		replyMarkup: InlineKeyboardMarkup | null,
	): Promise<void> {
		try {
			await this.call('editMessageReplyMarkup', {
				chat_id: chatId,
				message_id: messageId,
				reply_markup: replyMarkup ?? {inline_keyboard: []},
			});
		} catch (err) {
			this.log(
				'debug',
				`editMessageReplyMarkup failed: ${this.redact(
					err instanceof Error ? err.message : String(err),
				)}`,
			);
		}
	}

	async answerCallbackQuery(
		callbackQueryId: string,
		text?: string,
	): Promise<void> {
		try {
			const params: Record<string, unknown> = {
				callback_query_id: callbackQueryId,
			};
			if (text) params['text'] = text;
			await this.call('answerCallbackQuery', params);
		} catch (err) {
			this.log(
				'debug',
				`answerCallbackQuery failed: ${this.redact(
					err instanceof Error ? err.message : String(err),
				)}`,
			);
		}
	}

	async setMyCommands(commands: BotCommand[]): Promise<void> {
		try {
			await this.call('setMyCommands', {commands});
		} catch (err) {
			this.log(
				'debug',
				`setMyCommands failed: ${this.redact(
					err instanceof Error ? err.message : String(err),
				)}`,
			);
		}
	}

	private async getUpdates(): Promise<TelegramUpdate[]> {
		const result = await this.call<TelegramUpdate[]>('getUpdates', {
			offset: this.offset,
			timeout: this.pollTimeoutSec,
			allowed_updates: ['message', 'callback_query'],
		});
		return result;
	}

	private async call<T>(method: string, params: unknown): Promise<T> {
		const url = `${this.apiBase}/bot${this.token}/${method}`;
		const res = await fetch(url, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(params),
		});
		if (!res.ok) {
			const err = new Error(`HTTP ${res.status}`) as Error & {status?: number};
			err.status = res.status;
			throw err;
		}
		const json = (await res.json()) as {
			ok: boolean;
			result?: T;
			description?: string;
		};
		if (!json.ok) {
			throw new Error(json.description ?? 'telegram api returned ok=false');
		}
		return json.result as T;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
