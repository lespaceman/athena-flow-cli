#!/usr/bin/env node
/**
 * Telegram channel subprocess entry point.
 *
 * Speaks Athena's NDJSON channel protocol on stdio. Long-polls Telegram
 * for messages + callback queries, gates senders against the allowlist
 * supplied in `init`, and routes verdict-shaped replies to
 * `permission.verdict` / `question.answer` events.
 */

import process from 'node:process';
import {encodeLine, LineReader, parseMethodMessage} from '../protocol';
import {CHANNEL_BROADCAST_SESSION_ID} from '../types';
import type {
	ChannelEventMessage,
	ChannelMethodMessage,
	ChannelLogLevel,
	ChannelQuestion,
} from '../types';
import {
	TelegramBot,
	type InlineKeyboardMarkup,
	type ReplyMarkup,
	type SendMessageOptions,
	type TelegramCallbackQuery,
	type TelegramMessage,
} from './bot';
import {
	agentMarkdownToTelegramV2,
	escapeMarkdownV2,
	escapeMarkdownV2CodeBlock,
} from './markdown';
import {TELEGRAM_CHANNEL_NAME} from './name';
import {
	buildPermissionCallbackData,
	buildPlainTextQuestionAnswer,
	buildQuestionCallbackData,
	parseCallbackData,
	parseQuestionAnswer,
	parseQuestionAnswerId,
	parseVerdict,
} from './verdict';

type PendingPermission = {
	kind: 'permission';
	sessionId: string;
	channelRequestId: string;
	chatId: number | string;
	messageId: number;
	headline: string;
};

type PendingQuestion = {
	kind: 'question';
	sessionId: string;
	channelRequestId: string;
	chatId: number | string;
	messageId: number;
	headline: string;
	questionKeys: string[];
	/** Flat option lookup; only populated when the prompt has a button keyboard. */
	buttonOptions: Array<{key: string; label: string}> | null;
};

type PendingMessage = PendingPermission | PendingQuestion;

type RuntimeState = {
	bot: TelegramBot | null;
	allowedUserIds: Set<string>;
	defaultChatId: string | number | null;
	pendingMessages: Map<string, PendingMessage>;
	/** channel_request_ids whose `sendMessage` is in flight. */
	inFlightSends: Set<string>;
	/** Cancel reasons that arrived while a `sendMessage` was in flight. */
	cancelDuringSend: Map<string, string>;
};

const VERSION = '0.2.0';
const NAME = TELEGRAM_CHANNEL_NAME;

function send(event: ChannelEventMessage): void {
	process.stdout.write(encodeLine(event));
}

function keyFor(sessionId: string, channelRequestId: string): string {
	return `${sessionId}:${channelRequestId}`;
}

function log(sessionId: string, level: ChannelLogLevel, message: string): void {
	send({session_id: sessionId, event: 'log', params: {level, message}});
}

function sendError(sessionId: string, message: string, fatal = false): void {
	send({session_id: sessionId, event: 'error', params: {message, fatal}});
}

// ── Rendering helpers (MarkdownV2) ───────────────────────────────────

const MD_OPTIONS = {
	parse_mode: 'MarkdownV2',
} as const satisfies SendMessageOptions;
const EMPTY_KEYBOARD: InlineKeyboardMarkup = {inline_keyboard: []};

const TAP_BUTTON_BELOW = escapeMarkdownV2('Tap an option below.');

function buildPromptMarkdown(
	toolName: string,
	description: string,
	inputPreview: string,
	channelRequestId: string,
): string {
	const lines: string[] = [
		`*${escapeMarkdownV2(toolName)}* — ${escapeMarkdownV2(description)}`,
	];
	const trimmedPreview = inputPreview.trim();
	if (trimmedPreview.length > 0) {
		lines.push('', '```', escapeMarkdownV2CodeBlock(trimmedPreview), '```');
	}
	lines.push('');
	lines.push(
		escapeMarkdownV2(
			`Tap a button below, or reply "yes ${channelRequestId}" / "no ${channelRequestId}".`,
		),
	);
	return lines.join('\n');
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

function questionTrailer(
	hasButtons: boolean,
	questionCount: number,
	channelRequestId: string,
): string {
	if (hasButtons) return TAP_BUTTON_BELOW;
	if (questionCount <= 1) {
		return escapeMarkdownV2(
			`Reply with your answer, or "answer ${channelRequestId} your response".`,
		);
	}
	return escapeMarkdownV2(
		`Reply 'answer ${channelRequestId} {"Question":"Answer"}' to respond.`,
	);
}

function buildQuestionMarkdown(
	title: string,
	questions: ChannelQuestion[],
	channelRequestId: string,
	hasButtons: boolean,
): string {
	const lines: string[] = [`*${escapeMarkdownV2(title.trim() || 'Question')}*`];
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
	lines.push(
		'',
		questionTrailer(hasButtons, questions.length, channelRequestId),
	);
	return lines.join('\n');
}

/**
 * Build a button keyboard for a single-question prompt with options. Returns
 * null when the question shape doesn't fit (multi-question, multi-select,
 * no options, or callback_data > 64 bytes).
 */
function buildQuestionKeyboard(
	channelRequestId: string,
	questions: ChannelQuestion[],
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

// ── Bot lifecycle ────────────────────────────────────────────────────

const BOT_COMMANDS = [
	{command: 'status', description: 'Show current Athena session status'},
	{command: 'cancel', description: 'Cancel the pending prompt'},
	{command: 'help', description: 'How to use this bot'},
];

const HELP_TEXT = [
	'Athena Telegram channel:',
	'• Permission prompts come with Allow / Deny buttons — just tap.',
	'• Questions with options come with one button per option.',
	'• Free-text questions: reply directly to the message.',
	'• Multi-question replies: answer <id> {"Q1":"A1","Q2":"A2"}',
	'• Power users: "yes <id>" / "no <id>" still works.',
].join('\n');

async function startBot(
	state: RuntimeState,
	sessionId: string,
	options: Record<string, unknown>,
): Promise<void> {
	const token =
		typeof options['bot_token'] === 'string' ? options['bot_token'] : '';
	if (!token) {
		sendError(
			sessionId,
			'telegram channel: bot_token missing in sidecar config',
			true,
		);
		process.exit(1);
	}
	const defaultChat = options['default_chat_id'];
	if (typeof defaultChat === 'string' || typeof defaultChat === 'number') {
		state.defaultChatId = defaultChat;
	} else {
		sendError(
			sessionId,
			'telegram channel: default_chat_id missing or invalid in sidecar config',
			true,
		);
		process.exit(1);
	}

	state.bot = new TelegramBot({token}, (level, message) =>
		log(sessionId, level, message),
	);
	void state.bot.setMyCommands(BOT_COMMANDS);
	send({
		session_id: sessionId,
		event: 'ready',
		params: {name: NAME, version: VERSION},
	});

	for await (const update of state.bot.poll()) {
		if (update.callback_query) {
			await handleCallbackQuery(state, update.callback_query);
			continue;
		}
		const message = update.message;
		if (!message) continue;
		await handleIncomingMessage(state, message);
	}
}

// ── Incoming events ──────────────────────────────────────────────────

function findPendingQuestion(
	state: RuntimeState,
): {id: string; pending: PendingQuestion} | null {
	let only: {id: string; pending: PendingQuestion} | null = null;
	for (const [id, pending] of state.pendingMessages) {
		if (pending.kind !== 'question') continue;
		if (only) return null;
		only = {id, pending};
	}
	return only;
}

function findPendingByRequestId(
	state: RuntimeState,
	channelRequestId: string,
): {key: string; pending: PendingMessage} | null {
	let only: {key: string; pending: PendingMessage} | null = null;
	for (const [key, pending] of state.pendingMessages) {
		if (pending.channelRequestId !== channelRequestId) continue;
		if (only) return null;
		only = {key, pending};
	}
	return only;
}

function findPendingByKeyOrRequestId(
	state: RuntimeState,
	keyOrChannelRequestId: string,
): {key: string; pending: PendingMessage} | null {
	const direct = state.pendingMessages.get(keyOrChannelRequestId);
	if (direct) return {key: keyOrChannelRequestId, pending: direct};
	return findPendingByRequestId(state, keyOrChannelRequestId);
}

async function handleIncomingMessage(
	state: RuntimeState,
	message: TelegramMessage,
): Promise<void> {
	const senderId = message.from?.id;
	if (senderId === undefined) return;
	if (!state.allowedUserIds.has(String(senderId))) {
		log(
			'unknown',
			'debug',
			`dropping message from non-allowlisted sender: ${senderId}`,
		);
		return;
	}
	const text = message.text?.trim() ?? '';
	if (text.length === 0) return;

	if (text === '/help' || text.startsWith('/help@')) {
		if (state.bot) await state.bot.sendMessage(message.chat.id, HELP_TEXT);
		return;
	}

	if (text === '/status' || text.startsWith('/status@')) {
		if (!state.bot) return;
		const pending = [...state.pendingMessages.entries()];
		if (pending.length === 0) {
			await state.bot.sendMessage(
				message.chat.id,
				escapeMarkdownV2('No pending prompts.'),
				MD_OPTIONS,
			);
		} else {
			const noun = pending.length === 1 ? 'prompt' : 'prompts';
			const lines = [`*${pending.length} pending ${escapeMarkdownV2(noun)}:*`];
			for (const [, p] of pending) {
				const icon = p.kind === 'permission' ? '🔐' : '❓';
				lines.push(
					`${icon} \`${p.sessionId}/${p.channelRequestId}\` — ${escapeMarkdownV2(p.headline)}`,
				);
			}
			await state.bot.sendMessage(
				message.chat.id,
				lines.join('\n'),
				MD_OPTIONS,
			);
		}
		return;
	}

	if (text === '/cancel' || text.startsWith('/cancel@')) {
		if (!state.bot) return;
		const all = [...state.pendingMessages.keys()];
		if (all.length === 0) {
			await state.bot.sendMessage(
				message.chat.id,
				escapeMarkdownV2('Nothing pending to cancel.'),
				MD_OPTIONS,
			);
			return;
		}
		await Promise.all(
			all.map(async id => {
				const p = state.pendingMessages.get(id);
				if (p?.kind === 'permission') {
					send({
						session_id: p.sessionId,
						event: 'permission.verdict',
						params: {channel_request_id: p.channelRequestId, behavior: 'deny'},
					});
				}
				await applyCancelEdit(state, id, 'cancelled');
			}),
		);
		return;
	}

	const verdict = parseVerdict(text);
	if (verdict) {
		const target = findPendingByRequestId(state, verdict.channelRequestId);
		if (!target) return;
		send({
			session_id: target.pending.sessionId,
			event: 'permission.verdict',
			params: {
				channel_request_id: verdict.channelRequestId,
				behavior: verdict.behavior,
			},
		});
		await markResolved(
			state,
			verdict.channelRequestId,
			verdict.behavior === 'allow' ? 'allowed via reply' : 'denied via reply',
		);
		return;
	}

	const answerId = parseQuestionAnswerId(text);
	if (answerId) {
		const target = findPendingByRequestId(state, answerId);
		if (target?.pending.kind === 'question') {
			const answer = parseQuestionAnswer(text, target.pending.questionKeys);
			if (answer) {
				send({
					session_id: target.pending.sessionId,
					event: 'question.answer',
					params: {
						channel_request_id: answer.channelRequestId,
						answers: answer.answers,
					},
				});
				await markResolved(state, answer.channelRequestId, 'answered');
				return;
			}
		}
	}

	const onlyQuestion = findPendingQuestion(state);
	if (onlyQuestion) {
		const answer = buildPlainTextQuestionAnswer(
			onlyQuestion.pending.channelRequestId,
			text,
			onlyQuestion.pending.questionKeys,
		);
		if (answer) {
			send({
				session_id: onlyQuestion.pending.sessionId,
				event: 'question.answer',
				params: {
					channel_request_id: answer.channelRequestId,
					answers: answer.answers,
				},
			});
			await markResolved(state, answer.channelRequestId, 'answered');
			return;
		}
	}

	send({
		session_id: CHANNEL_BROADCAST_SESSION_ID,
		event: 'chat.message',
		params: {
			content: text,
			meta: {
				sender_id: String(senderId),
				chat_id: String(message.chat.id),
			},
		},
	});
}

async function handleCallbackQuery(
	state: RuntimeState,
	cb: TelegramCallbackQuery,
): Promise<void> {
	const ack = (text?: string): Promise<void> =>
		state.bot ? state.bot.answerCallbackQuery(cb.id, text) : Promise.resolve();

	const senderId = cb.from.id;
	if (!state.allowedUserIds.has(String(senderId))) {
		await ack('Not allowed');
		return;
	}
	const parsed = parseCallbackData(cb.data ?? '');
	if (!parsed) {
		await ack();
		return;
	}

	if (parsed.kind === 'permission') {
		const target = findPendingByRequestId(state, parsed.channelRequestId);
		if (!target) {
			await ack();
			return;
		}
		send({
			session_id: target.pending.sessionId,
			event: 'permission.verdict',
			params: {
				channel_request_id: parsed.channelRequestId,
				behavior: parsed.behavior,
			},
		});
		const label = parsed.behavior === 'allow' ? 'Allowed' : 'Denied';
		await Promise.all([
			ack(label),
			markResolved(state, parsed.channelRequestId, label),
		]);
		return;
	}

	const target = findPendingByRequestId(state, parsed.channelRequestId);
	const pending = target?.pending;
	if (
		pending?.kind !== 'question' ||
		!pending.buttonOptions ||
		parsed.optionIndex >= pending.buttonOptions.length
	) {
		await ack();
		return;
	}
	const option = pending.buttonOptions[parsed.optionIndex]!;
	send({
		session_id: pending.sessionId,
		event: 'question.answer',
		params: {
			channel_request_id: parsed.channelRequestId,
			answers: {[option.key]: option.label},
		},
	});
	await Promise.all([
		ack(option.label),
		markResolved(state, parsed.channelRequestId, `Answered: ${option.label}`),
	]);
}

/**
 * Edit the original message to show resolution and strip the inline
 * keyboard. Cleans up pending state for this request id. Bundling the
 * empty-keyboard into the same `editMessageText` call avoids a second
 * round-trip to Telegram.
 */
async function markResolved(
	state: RuntimeState,
	channelRequestId: string,
	label: string,
): Promise<void> {
	const target = findPendingByKeyOrRequestId(state, channelRequestId);
	if (target) state.pendingMessages.delete(target.key);
	const resolved = target?.pending;
	if (!resolved || !state.bot) return;
	await state.bot.editMessageText(
		resolved.chatId,
		resolved.messageId,
		buildResolvedText(resolved.headline, label),
		{...MD_OPTIONS, reply_markup: EMPTY_KEYBOARD},
	);
}

async function applyCancelEdit(
	state: RuntimeState,
	id: string,
	reason: string,
): Promise<void> {
	const target = findPendingByKeyOrRequestId(state, id);
	const ref = target?.pending;
	if (!ref || !state.bot) return;
	state.pendingMessages.delete(target.key);
	await state.bot.editMessageText(
		ref.chatId,
		ref.messageId,
		buildCancelText(reason),
		{...MD_OPTIONS, reply_markup: EMPTY_KEYBOARD},
	);
}

// ── Method handlers (Athena → channel) ───────────────────────────────

/**
 * Send a prompt and wire up the cancel-during-send race: if a cancel
 * arrived while `sendMessage` was in flight, we apply it once the message
 * id is known. If the send itself failed, we drop any queued cancel —
 * there's no message to edit.
 */
async function sendAndTrack(
	state: RuntimeState,
	sessionId: string,
	id: string,
	text: string,
	replyMarkup: ReplyMarkup,
	makePending: (chatId: number | string, messageId: number) => PendingMessage,
): Promise<void> {
	if (!state.bot || state.defaultChatId === null) return;
	const key = keyFor(sessionId, id);
	state.inFlightSends.add(key);
	const result = await state.bot.sendMessage(state.defaultChatId, text, {
		...MD_OPTIONS,
		reply_markup: replyMarkup,
	});
	state.inFlightSends.delete(key);
	if (!result) {
		state.cancelDuringSend.delete(key);
		return;
	}
	state.pendingMessages.set(
		key,
		makePending(result.chat.id, result.message_id),
	);
	const queuedCancel = state.cancelDuringSend.get(key);
	if (queuedCancel !== undefined) {
		state.cancelDuringSend.delete(key);
		await applyCancelEdit(state, id, queuedCancel);
	}
}

async function handleMethod(
	state: RuntimeState,
	message: ChannelMethodMessage,
): Promise<void> {
	switch (message.method) {
		case 'init': {
			state.allowedUserIds = new Set(
				message.params.allowed_user_ids.map(id => String(id)),
			);
			if (!state.bot)
				void startBot(state, message.session_id, message.params.options);
			return;
		}
		case 'permission.request': {
			const id = message.params.channel_request_id;
			const text = buildPromptMarkdown(
				message.params.tool_name,
				message.params.description,
				message.params.input_preview,
				id,
			);
			await sendAndTrack(
				state,
				message.session_id,
				id,
				text,
				buildPermissionKeyboard(id),
				(chatId, messageId) => ({
					kind: 'permission',
					sessionId: message.session_id,
					channelRequestId: id,
					chatId,
					messageId,
					headline: message.params.tool_name,
				}),
			);
			return;
		}
		case 'permission.cancel': {
			const id = message.params.channel_request_id;
			const key = keyFor(message.session_id, id);
			if (state.pendingMessages.has(key)) {
				await applyCancelEdit(state, key, message.params.reason);
				return;
			}
			if (state.inFlightSends.has(key)) {
				state.cancelDuringSend.set(key, message.params.reason);
			}
			return;
		}
		case 'question.request': {
			const id = message.params.channel_request_id;
			const keyboard = buildQuestionKeyboard(id, message.params.questions);
			const text = buildQuestionMarkdown(
				message.params.title,
				message.params.questions,
				id,
				keyboard !== null,
			);
			const replyMarkup: ReplyMarkup = keyboard?.markup ?? {
				force_reply: true,
				input_field_placeholder: 'Type your answer…',
			};
			const headline = message.params.title.trim() || 'Question';
			const questionKeys = message.params.questions.map(q => q.key);
			const buttonOptions = keyboard?.options ?? null;
			await sendAndTrack(
				state,
				message.session_id,
				id,
				text,
				replyMarkup,
				(chatId, messageId) => ({
					kind: 'question',
					sessionId: message.session_id,
					channelRequestId: id,
					chatId,
					messageId,
					headline,
					questionKeys,
					buttonOptions,
				}),
			);
			return;
		}
		case 'question.cancel': {
			const id = message.params.channel_request_id;
			const key = keyFor(message.session_id, id);
			if (state.pendingMessages.has(key)) {
				await applyCancelEdit(state, key, message.params.reason);
				return;
			}
			if (state.inFlightSends.has(key)) {
				state.cancelDuringSend.set(key, message.params.reason);
			}
			return;
		}
		case 'notification': {
			if (!state.bot || state.defaultChatId === null) return;
			const rendered = agentMarkdownToTelegramV2(message.params.content);
			const result = await state.bot.sendMessage(
				state.defaultChatId,
				rendered,
				MD_OPTIONS,
			);
			if (!result) {
				await state.bot.sendMessage(
					state.defaultChatId,
					message.params.content,
				);
			}
			return;
		}
		case 'shutdown': {
			state.bot?.stop();
			process.exit(0);
		}
	}
}

function main(): void {
	const state: RuntimeState = {
		bot: null,
		allowedUserIds: new Set(),
		defaultChatId: null,
		pendingMessages: new Map(),
		inFlightSends: new Set(),
		cancelDuringSend: new Map(),
	};

	const reader = new LineReader();
	process.stdin.setEncoding('utf-8');
	process.stdin.on('data', chunk => {
		for (const line of reader.push(chunk)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				sendError('unknown', `invalid JSON line: ${line.slice(0, 100)}`);
				continue;
			}
			const result = parseMethodMessage(parsed);
			if (!result.ok) {
				sendError('unknown', `invalid method message: ${result.reason}`);
				continue;
			}
			void handleMethod(state, result.value).catch(err => {
				sendError(
					result.value.session_id,
					`method handler failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}
	});

	process.stdin.on('end', () => {
		state.bot?.stop();
		process.exit(0);
	});

	process.on('SIGTERM', () => {
		state.bot?.stop();
		process.exit(0);
	});
}

main();
