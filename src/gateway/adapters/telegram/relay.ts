/**
 * Telegram-specific permission/question relay implementation.
 *
 * Owns the rendering of relay prompts (MarkdownV2 + inline keyboards), the
 * pending-prompt registry, and the dispatch of inbound callback queries /
 * verdict-shaped text replies into pending entries.
 *
 * The adapter delegates `requestPermissionVerdict` / `requestQuestionAnswer`
 * to this module; the poll loop forwards every `TelegramUpdate` to
 * `handleUpdate` so the module can detect verdicts/answers regardless of
 * which UI surface produced them (button tap vs. plaintext reply).
 */

import {
	TelegramBot,
	type InlineKeyboardMarkup,
	type SendMessageOptions,
	type TelegramUpdate,
} from '../../../shared/telegram/bot';
import {
	escapeMarkdownV2,
	escapeMarkdownV2CodeBlock,
} from '../../../shared/telegram/markdown';
import type {
	PermissionRelayRequest,
	PermissionRelayResult,
	QuestionRelayRequest,
	QuestionRelayResult,
	RelayQuestion,
} from '../../../shared/gateway-protocol';
import {
	buildPermissionCallbackData,
	buildPlainTextQuestionAnswer,
	buildQuestionCallbackData,
	parseCallbackData,
	parseQuestionAnswer,
	parseQuestionAnswerId,
	parseVerdict,
} from './verdict';

const MD_OPTIONS = {
	parse_mode: 'MarkdownV2',
} as const satisfies SendMessageOptions;
const TELEGRAM_MAX_TEXT = 4096;
const TELEGRAM_TEXT_SAFE_MARGIN = 96;

type ChatTarget = {
	chatId: number | string;
	threadId?: number;
};

type PendingPermission = {
	kind: 'permission';
	channelRequestId: string;
	chatId: number | string;
	messageId: number;
	headline: string;
	resolve: (result: PermissionRelayResult) => void;
	abortListener: () => void;
	signal: AbortSignal;
};

type PendingQuestion = {
	kind: 'question';
	channelRequestId: string;
	chatId: number | string;
	messageId: number;
	headline: string;
	questionKeys: string[];
	buttonOptions: Array<{key: string; label: string}> | null;
	resolve: (result: QuestionRelayResult) => void;
	abortListener: () => void;
	signal: AbortSignal;
};

type PendingEntry = PendingPermission | PendingQuestion;

export type TelegramRelayOptions = {
	resolveTarget: () => ChatTarget | null;
	log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
};

export class TelegramRelay {
	private readonly pending = new Map<string, PendingEntry>();
	private readonly resolveTarget: TelegramRelayOptions['resolveTarget'];
	private readonly log: TelegramRelayOptions['log'];
	private bot: TelegramBot | null = null;

	constructor(opts: TelegramRelayOptions) {
		this.resolveTarget = opts.resolveTarget;
		this.log = opts.log;
	}

	bindBot(bot: TelegramBot | null): void {
		this.bot = bot;
	}

	async requestPermission(
		req: PermissionRelayRequest,
		signal: AbortSignal,
	): Promise<PermissionRelayResult> {
		const bot = this.bot;
		const target = this.resolveTarget();
		if (!bot || !target) {
			return {kind: 'no_relay'};
		}
		if (signal.aborted) {
			return {kind: 'cancelled', reason: 'auto_resolved'};
		}
		const headline = `${req.toolName} — ${req.description}`;
		const text = buildPromptMarkdown(
			req.toolName,
			req.description,
			req.inputPreview,
			req.channelRequestId,
		);
		const reply_markup = buildPermissionKeyboard(req.channelRequestId);
		const sent = await bot.sendMessage(target.chatId, text, {
			...MD_OPTIONS,
			reply_markup,
			...(target.threadId !== undefined
				? {message_thread_id: target.threadId}
				: {}),
		});
		if (!sent) {
			return {kind: 'no_relay'};
		}
		return new Promise<PermissionRelayResult>(resolve => {
			const abortListener = (): void => {
				const entry = this.pending.get(req.channelRequestId);
				if (!entry || entry.kind !== 'permission') return;
				this.pending.delete(req.channelRequestId);
				void this.editToCancelled(entry);
				resolve({kind: 'cancelled', reason: 'resolved_by_other_channel'});
			};
			signal.addEventListener('abort', abortListener);
			this.pending.set(req.channelRequestId, {
				kind: 'permission',
				channelRequestId: req.channelRequestId,
				chatId: sent.chat.id,
				messageId: sent.message_id,
				headline,
				resolve,
				abortListener,
				signal,
			});
		});
	}

	async requestQuestion(
		req: QuestionRelayRequest,
		signal: AbortSignal,
	): Promise<QuestionRelayResult> {
		const bot = this.bot;
		const target = this.resolveTarget();
		if (!bot || !target) {
			return {kind: 'no_relay'};
		}
		if (signal.aborted) {
			return {kind: 'cancelled', reason: 'auto_resolved'};
		}
		const headline = req.title.trim() || 'Question';
		const keyboard = buildQuestionKeyboard(req.channelRequestId, req.questions);
		const text = buildQuestionMarkdown(
			headline,
			req.questions,
			req.channelRequestId,
			keyboard !== null,
		);
		const sent = await bot.sendMessage(target.chatId, text, {
			...MD_OPTIONS,
			...(keyboard !== null ? {reply_markup: keyboard.markup} : {}),
			...(target.threadId !== undefined
				? {message_thread_id: target.threadId}
				: {}),
		});
		if (!sent) {
			return {kind: 'no_relay'};
		}
		return new Promise<QuestionRelayResult>(resolve => {
			const abortListener = (): void => {
				const entry = this.pending.get(req.channelRequestId);
				if (!entry || entry.kind !== 'question') return;
				this.pending.delete(req.channelRequestId);
				void this.editToCancelled(entry);
				resolve({kind: 'cancelled', reason: 'resolved_by_other_channel'});
			};
			signal.addEventListener('abort', abortListener);
			this.pending.set(req.channelRequestId, {
				kind: 'question',
				channelRequestId: req.channelRequestId,
				chatId: sent.chat.id,
				messageId: sent.message_id,
				headline,
				questionKeys: req.questions.map(q => q.key),
				buttonOptions: keyboard?.options ?? null,
				resolve,
				abortListener,
				signal,
			});
		});
	}

	/** Returns true if the update was consumed by a relay (verdict/answer). */
	handleUpdate(update: TelegramUpdate): boolean {
		const bot = this.bot;
		if (!bot) return false;
		const cb = update.callback_query;
		if (cb?.data) {
			const parsed = parseCallbackData(cb.data);
			if (!parsed) return false;
			const entry = this.pending.get(parsed.channelRequestId);
			if (!entry) {
				void bot.answerCallbackQuery(cb.id, 'request expired');
				return true;
			}
			if (parsed.kind === 'permission' && entry.kind === 'permission') {
				this.settlePermission(entry, parsed.behavior);
				void bot.answerCallbackQuery(cb.id, parsed.behavior);
				return true;
			}
			if (parsed.kind === 'question' && entry.kind === 'question') {
				const opt = entry.buttonOptions?.[parsed.optionIndex];
				if (!opt) {
					void bot.answerCallbackQuery(cb.id, 'unknown option');
					return true;
				}
				this.settleQuestion(entry, {[opt.key]: opt.label});
				void bot.answerCallbackQuery(cb.id, opt.label);
				return true;
			}
			return false;
		}

		const message = update.message ?? update.edited_message;
		const text = message?.text;
		if (typeof text !== 'string' || text.length === 0) return false;

		const verdict = parseVerdict(text);
		if (verdict) {
			const entry = this.pending.get(verdict.channelRequestId);
			if (entry?.kind === 'permission') {
				this.settlePermission(entry, verdict.behavior);
				return true;
			}
			return false;
		}

		const answerId = parseQuestionAnswerId(text);
		if (answerId) {
			const entry = this.pending.get(answerId);
			if (entry?.kind === 'question') {
				const parsed = parseQuestionAnswer(text, entry.questionKeys);
				if (!parsed) return false;
				this.settleQuestion(entry, parsed.answers);
				return true;
			}
			return false;
		}

		// Handle plain-text reply for a single-question prompt where the user
		// just types the answer. Only consumed if the message is a reply to
		// our question prompt — otherwise it's a chat inbound.
		if (
			message &&
			'reply_to_message' in message &&
			(message as {reply_to_message?: {message_id: number}}).reply_to_message
		) {
			const replyTo = (message as {reply_to_message?: {message_id: number}})
				.reply_to_message!.message_id;
			for (const entry of this.pending.values()) {
				if (entry.kind !== 'question') continue;
				if (entry.messageId !== replyTo) continue;
				const parsed = buildPlainTextQuestionAnswer(
					entry.channelRequestId,
					text,
					entry.questionKeys,
				);
				if (!parsed) return false;
				this.settleQuestion(entry, parsed.answers);
				return true;
			}
		}

		return false;
	}

	disposeAll(): void {
		for (const entry of [...this.pending.values()]) {
			this.pending.delete(entry.channelRequestId);
			entry.signal.removeEventListener('abort', entry.abortListener);
			if (entry.kind === 'permission') {
				entry.resolve({kind: 'cancelled', reason: 'auto_resolved'});
			} else {
				entry.resolve({kind: 'cancelled', reason: 'auto_resolved'});
			}
		}
	}

	private settlePermission(
		entry: PendingPermission,
		behavior: 'allow' | 'deny',
	): void {
		this.pending.delete(entry.channelRequestId);
		entry.signal.removeEventListener('abort', entry.abortListener);
		void this.editToResolved(
			entry,
			behavior === 'allow' ? 'Allowed' : 'Denied',
		);
		entry.resolve({kind: 'verdict', behavior, channelId: 'telegram'});
	}

	private settleQuestion(
		entry: PendingQuestion,
		answers: Record<string, string>,
	): void {
		this.pending.delete(entry.channelRequestId);
		entry.signal.removeEventListener('abort', entry.abortListener);
		const summary = Object.values(answers).join(', ').slice(0, 120);
		void this.editToResolved(entry, summary || 'Answered');
		entry.resolve({kind: 'answer', answers, channelId: 'telegram'});
	}

	private async editToResolved(
		entry: PendingEntry,
		label: string,
	): Promise<void> {
		const bot = this.bot;
		if (!bot) return;
		try {
			await bot.editMessageText(
				entry.chatId,
				entry.messageId,
				buildResolvedText(entry.headline, label),
				MD_OPTIONS,
			);
		} catch (err) {
			this.log(
				'debug',
				`telegram relay: edit-to-resolved failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	private async editToCancelled(entry: PendingEntry): Promise<void> {
		const bot = this.bot;
		if (!bot) return;
		try {
			await bot.editMessageText(
				entry.chatId,
				entry.messageId,
				buildCancelText('resolved elsewhere'),
				MD_OPTIONS,
			);
		} catch (err) {
			this.log(
				'debug',
				`telegram relay: edit-to-cancelled failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
}

// ── Render helpers (MarkdownV2) ────────────────────────────────────────

function clampToTelegramLimit(text: string): string {
	if (text.length <= TELEGRAM_MAX_TEXT) return text;
	return text.slice(0, TELEGRAM_MAX_TEXT - 1) + '…';
}

function buildPromptMarkdown(
	toolName: string,
	description: string,
	inputPreview: string,
	channelRequestId: string,
): string {
	const trimmedPreview = inputPreview.trim();
	const render = (preview: string): string => {
		const lines = [
			`*${escapeMarkdownV2(toolName)}* — ${escapeMarkdownV2(description)}`,
		];
		if (preview.length > 0) {
			lines.push('', '```', escapeMarkdownV2CodeBlock(preview), '```');
		}
		lines.push(
			'',
			escapeMarkdownV2(
				`Tap a button below, or reply "yes ${channelRequestId}" / "no ${channelRequestId}".`,
			),
		);
		return lines.join('\n');
	};
	const first = render(trimmedPreview);
	const budget = TELEGRAM_MAX_TEXT - TELEGRAM_TEXT_SAFE_MARGIN;
	if (first.length <= budget) return first;
	const overflow = first.length - budget;
	const safePreview =
		trimmedPreview.length > overflow
			? trimmedPreview.slice(0, Math.max(0, trimmedPreview.length - overflow)) +
				'…'
			: '';
	return clampToTelegramLimit(render(safePreview));
}

function buildPermissionKeyboard(
	channelRequestId: string,
): InlineKeyboardMarkup {
	return {
		inline_keyboard: [
			[
				{
					text: '✅ Allow',
					callback_data: buildPermissionCallbackData(channelRequestId, 'allow'),
				},
				{
					text: '❌ Deny',
					callback_data: buildPermissionCallbackData(channelRequestId, 'deny'),
				},
			],
		],
	};
}

function buildQuestionMarkdown(
	title: string,
	questions: RelayQuestion[],
	channelRequestId: string,
	hasButtons: boolean,
): string {
	const lines: string[] = [`*${escapeMarkdownV2(title)}*`];
	for (const [index, q] of questions.entries()) {
		lines.push('');
		lines.push(
			`${index + 1}\\. *${escapeMarkdownV2(q.header)}*: ${escapeMarkdownV2(q.question)}`,
		);
		if (q.options.length > 0 && !hasButtons) {
			for (const option of q.options) {
				const suffix = option.description ? ` — ${option.description}` : '';
				lines.push(`   • ${escapeMarkdownV2(option.label + suffix)}`);
			}
		}
	}
	const trailer = hasButtons
		? escapeMarkdownV2('Tap an option below.')
		: questions.length <= 1
			? escapeMarkdownV2(
					`Reply with your answer, or "answer ${channelRequestId} your response".`,
				)
			: escapeMarkdownV2(
					`Reply 'answer ${channelRequestId} {"Question":"Answer"}' to respond.`,
				);
	lines.push('', trailer);
	return clampToTelegramLimit(lines.join('\n'));
}

function buildQuestionKeyboard(
	channelRequestId: string,
	questions: RelayQuestion[],
): {
	markup: InlineKeyboardMarkup;
	options: Array<{key: string; label: string}>;
} | null {
	if (questions.length !== 1) return null;
	const q = questions[0]!;
	if (q.multi_select || q.options.length === 0) return null;
	const rows: InlineKeyboardMarkup['inline_keyboard'] = [];
	const options: Array<{key: string; label: string}> = [];
	for (const [optIdx, option] of q.options.entries()) {
		const data = buildQuestionCallbackData(channelRequestId, optIdx);
		if (Buffer.byteLength(data, 'utf8') > 64) return null;
		rows.push([{text: option.label, callback_data: data}]);
		options.push({key: q.key, label: option.label});
	}
	return {markup: {inline_keyboard: rows}, options};
}

function buildResolvedText(headline: string, label: string): string {
	return `*${escapeMarkdownV2(headline)}*\n\n${escapeMarkdownV2(`✓ ${label}`)}`;
}

function buildCancelText(reason: string): string {
	return escapeMarkdownV2(`~ resolved (${reason}) ~`);
}
