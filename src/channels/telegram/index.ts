#!/usr/bin/env node
/**
 * Telegram channel subprocess entry point.
 *
 * Speaks Athena's NDJSON channel protocol on stdio. Long-polls Telegram
 * for messages + callback queries, gates senders against the allowlist
 * supplied in `init`, and routes verdict-shaped replies to
 * `permission.verdict` / `question.answer` events.
 *
 * Forum mode (opt-in via `options.forum_mode: true`): each Athena session
 * gets its own Forum Topic in a supergroup. Messages within a topic are
 * routed to the owning session instead of broadcast. State is persisted to
 * ~/.config/athena/channel-state/telegram-{chatId}.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {channelStateDir} from '../config';
import {encodeLine, LineReader, parseMethodMessage} from '../protocol';
import {CHANNEL_BROADCAST_SESSION_ID, MAX_SESSION_LABEL_LEN} from '../types';
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

	// Forum mode fields (only meaningful when forumMode === true)
	forumMode: boolean;
	/** session_id → message_thread_id */
	sessionTopics: Map<string, number>;
	/** message_thread_id → session_id (reverse index) */
	topicSessions: Map<number, string>;
	/** Pre-created topic thread IDs not yet claimed by any session */
	pendingTopics: number[];
	/** Absolute path to the persisted state JSON file */
	statePath: string | null;
};

// ── Persisted state ──────────────────────────────────────────────────

type PersistedState = {
	version: 1;
	forum_chat_id: number | string;
	session_topics: Record<string, number>;
	pending_topics: number[];
};

function loadState(state: RuntimeState): void {
	if (!state.statePath) return;
	let raw: PersistedState;
	try {
		raw = JSON.parse(
			fs.readFileSync(state.statePath, 'utf8'),
		) as PersistedState;
	} catch {
		// Missing or corrupted — start fresh.
		return;
	}
	if (raw.version !== 1) return;
	for (const [sid, tid] of Object.entries(raw.session_topics ?? {})) {
		state.sessionTopics.set(sid, tid);
		state.topicSessions.set(tid, sid);
	}
	state.pendingTopics = Array.isArray(raw.pending_topics)
		? raw.pending_topics
		: [];
}

function saveState(state: RuntimeState): void {
	if (!state.statePath) return;
	const data: PersistedState = {
		version: 1,
		forum_chat_id: state.defaultChatId ?? 0,
		session_topics: Object.fromEntries(state.sessionTopics),
		pending_topics: state.pendingTopics,
	};
	const tmp = `${state.statePath}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
		fs.renameSync(tmp, state.statePath);
	} catch {
		// Non-fatal — worst case we recreate topics on next boot
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

const VERSION = '0.3.0';
const NAME = TELEGRAM_CHANNEL_NAME;

/** Thread ID used in Telegram for the "General" topic of a forum group. */
const GENERAL_TOPIC_THREAD_ID = 1;

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

/** Returns the forum thread ID for a session, or undefined in flat-chat mode. */
function threadIdForSession(
	state: RuntimeState,
	sessionId: string,
): number | undefined {
	return state.forumMode ? state.sessionTopics.get(sessionId) : undefined;
}

type SlashCommand = 'help' | 'status' | 'cancel' | 'newsession';

/** Match `/cmd` or `/cmd@bot` (Telegram appends `@<bot_username>` in groups). */
function parseCommand(text: string): SlashCommand | null {
	const m = /^\/([a-z]+)(?:@\S*)?$/i.exec(text);
	if (!m) return null;
	const cmd = m[1]!.toLowerCase();
	if (
		cmd === 'help' ||
		cmd === 'status' ||
		cmd === 'cancel' ||
		cmd === 'newsession'
	) {
		return cmd;
	}
	return null;
}

function mdOptsForThread(threadId: number | undefined): SendMessageOptions {
	return threadId === undefined
		? MD_OPTIONS
		: {...MD_OPTIONS, message_thread_id: threadId};
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

const BOT_COMMANDS_BASE = [
	{command: 'status', description: 'Show current Athena session status'},
	{
		command: 'cancel',
		description: 'Cancel the pending permission or question prompt',
	},
	{command: 'help', description: 'How to use this bot'},
];

const BOT_COMMANDS_FORUM = [
	...BOT_COMMANDS_BASE,
	{
		command: 'newsession',
		description: 'Pre-create a topic for the next Athena session',
	},
];

const HELP_TEXT = [
	'Athena Telegram channel:',
	'• Permission prompts come with Allow / Deny buttons — just tap.',
	'• Questions with options come with one button per option.',
	'• Free-text questions: reply directly to the message.',
	'• Multi-question replies: answer <id> {"Q1":"A1","Q2":"A2"}',
	'• /cancel — cancel a pending permission or question prompt.',
].join('\n');

const HELP_TEXT_FORUM = [
	'Athena Telegram channel (forum mode):',
	'• /newsession — pre-create a topic for the next Athena session.',
	'• /cancel — cancel pending prompts in this topic.',
	'• /status — see all sessions and their topics.',
	"• Permission / question prompts appear in the session's topic.",
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

	state.forumMode = options['forum_mode'] === true;

	if (state.forumMode) {
		const stateDir = channelStateDir();
		try {
			fs.mkdirSync(stateDir, {recursive: true});
		} catch {
			// Non-fatal
		}
		state.statePath = path.join(
			stateDir,
			`telegram-${state.defaultChatId}.json`,
		);
		loadState(state);
	}

	state.bot = new TelegramBot({token}, (level, message) =>
		log(sessionId, level, message),
	);
	void state.bot.setMyCommands(
		state.forumMode ? BOT_COMMANDS_FORUM : BOT_COMMANDS_BASE,
	);
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

// ── Forum topic management ───────────────────────────────────────────

async function ensureTopicForSession(
	state: RuntimeState,
	sessionId: string,
	label?: string,
): Promise<number | null> {
	if (!state.forumMode || !state.bot || state.defaultChatId === null)
		return null;

	const existing = state.sessionTopics.get(sessionId);
	if (existing !== undefined) return existing;

	const topicName = label ?? `Session ${sessionId.slice(0, 8)}`;
	let threadId: number;

	if (state.pendingTopics.length > 0) {
		threadId = state.pendingTopics.shift()!;
		await state.bot.editForumTopic(state.defaultChatId, threadId, topicName);
	} else {
		const result = await state.bot.createForumTopic(
			state.defaultChatId,
			topicName,
		);
		if (!result) return null;
		threadId = result.message_thread_id;
	}

	state.sessionTopics.set(sessionId, threadId);
	state.topicSessions.set(threadId, sessionId);
	saveState(state);

	await state.bot.sendMessage(
		state.defaultChatId,
		escapeMarkdownV2('✅ Session connected'),
		mdOptsForThread(threadId),
	);

	return threadId;
}

// ── Incoming events ──────────────────────────────────────────────────

function findPendingQuestion(
	state: RuntimeState,
	sessionId?: string,
): {id: string; pending: PendingQuestion} | null {
	let only: {id: string; pending: PendingQuestion} | null = null;
	for (const [id, pending] of state.pendingMessages) {
		if (pending.kind !== 'question') continue;
		if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
		if (only) return null;
		only = {id, pending};
	}
	return only;
}

function findPendingByRequestId(
	state: RuntimeState,
	channelRequestId: string,
	sessionId?: string,
): {key: string; pending: PendingMessage} | null {
	let only: {key: string; pending: PendingMessage} | null = null;
	for (const [key, pending] of state.pendingMessages) {
		if (pending.channelRequestId !== channelRequestId) continue;
		if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
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

	if (state.forumMode) {
		await handleForumMessage(state, message, text);
	} else {
		await handleFlatMessage(state, message, text);
	}
}

async function handleForumMessage(
	state: RuntimeState,
	message: TelegramMessage,
	text: string,
): Promise<void> {
	const threadId = message.message_thread_id;
	const chatId = message.chat.id;

	if (threadId === undefined || threadId === GENERAL_TOPIC_THREAD_ID) {
		await handleGeneralTopicMessage(state, chatId, text, threadId);
		return;
	}

	const sessionId = state.topicSessions.get(threadId);

	if (sessionId === undefined) {
		if (state.bot) {
			await state.bot.sendMessage(
				chatId,
				escapeMarkdownV2(
					'⚠️ This topic is not linked to any session. Use /status to see active sessions.',
				),
				mdOptsForThread(threadId),
			);
		}
		return;
	}

	const command = parseCommand(text);
	if (command === 'help') {
		await state.bot?.sendMessage(chatId, HELP_TEXT_FORUM, {
			message_thread_id: threadId,
		});
		return;
	}
	if (command === 'status') {
		await sendStatusInTopic(state, chatId, threadId, sessionId);
		return;
	}
	if (command === 'cancel') {
		await cancelSessionPrompts(state, chatId, threadId, sessionId);
		return;
	}

	const verdict = parseVerdict(text);
	if (verdict) {
		const target = findPendingByRequestId(
			state,
			verdict.channelRequestId,
			sessionId,
		);
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
		const target = findPendingByRequestId(state, answerId, sessionId);
		const answer =
			target?.pending.kind === 'question'
				? parseQuestionAnswer(text, target.pending.questionKeys)
				: null;
		if (answer) {
			send({
				session_id: target!.pending.sessionId,
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

	const onlyQuestion = findPendingQuestion(state, sessionId);
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
		session_id: sessionId,
		event: 'chat.message',
		params: {
			content: text,
			meta: {
				sender_id: String(message.from!.id),
				chat_id: String(chatId),
				thread_id: String(threadId),
			},
		},
	});
}

async function handleGeneralTopicMessage(
	state: RuntimeState,
	chatId: number,
	text: string,
	threadId: number | undefined,
): Promise<void> {
	const replyOpts = mdOptsForThread(threadId);
	const command = parseCommand(text);

	if (command === 'help') {
		await state.bot?.sendMessage(chatId, HELP_TEXT_FORUM, {
			message_thread_id: threadId,
		});
		return;
	}
	if (command === 'status') {
		await sendGlobalStatus(state, chatId, threadId);
		return;
	}
	if (command === 'cancel') {
		await state.bot?.sendMessage(
			chatId,
			escapeMarkdownV2(
				'Use /cancel within a session topic to cancel its prompts.',
			),
			replyOpts,
		);
		return;
	}
	if (command === 'newsession') {
		await handleNewSession(state, chatId, threadId);
		return;
	}

	await state.bot?.sendMessage(
		chatId,
		escapeMarkdownV2(
			'Please use a session topic to send messages. Tap /status to see active sessions.',
		),
		replyOpts,
	);
}

async function sendStatusInTopic(
	state: RuntimeState,
	chatId: number,
	threadId: number,
	sessionId: string,
): Promise<void> {
	if (!state.bot) return;
	const pending = [...state.pendingMessages.values()].filter(
		p => p.sessionId === sessionId,
	);
	const replyOpts = mdOptsForThread(threadId);
	if (pending.length === 0) {
		await state.bot.sendMessage(
			chatId,
			escapeMarkdownV2('No pending prompts for this session.'),
			replyOpts,
		);
		return;
	}
	const noun = pending.length === 1 ? 'prompt' : 'prompts';
	const lines = [`*${pending.length} pending ${escapeMarkdownV2(noun)}:*`];
	for (const p of pending) {
		const icon = p.kind === 'permission' ? '🔐' : '❓';
		lines.push(
			`${icon} \`${p.channelRequestId}\` — ${escapeMarkdownV2(p.headline)}`,
		);
	}
	await state.bot.sendMessage(chatId, lines.join('\n'), replyOpts);
}

async function sendGlobalStatus(
	state: RuntimeState,
	chatId: number,
	threadId: number | undefined,
): Promise<void> {
	if (!state.bot) return;
	const replyOpts = mdOptsForThread(threadId);

	if (state.sessionTopics.size === 0 && state.pendingTopics.length === 0) {
		await state.bot.sendMessage(
			chatId,
			escapeMarkdownV2('No active or pending sessions.'),
			replyOpts,
		);
		return;
	}

	const lines: string[] = ['*Athena Sessions:*', ''];
	for (const [sid, tid] of state.sessionTopics) {
		lines.push(`🟢 \`${sid.slice(0, 8)}\` — topic thread ${tid}`);
	}
	for (const tid of state.pendingTopics) {
		lines.push(`⏳ Pending topic thread ${tid} — waiting for session`);
	}
	await state.bot.sendMessage(chatId, lines.join('\n'), replyOpts);
}

async function cancelSessionPrompts(
	state: RuntimeState,
	chatId: number,
	threadId: number,
	sessionId: string,
): Promise<void> {
	if (!state.bot) return;

	const sessionKeys = [...state.pendingMessages.entries()]
		.filter(([, p]) => p.sessionId === sessionId)
		.map(([key]) => key);

	if (sessionKeys.length === 0) {
		await state.bot.sendMessage(
			chatId,
			escapeMarkdownV2('Nothing pending to cancel for this session.'),
			mdOptsForThread(threadId),
		);
		return;
	}

	await Promise.all(
		sessionKeys.map(async id => {
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
}

async function handleNewSession(
	state: RuntimeState,
	chatId: number,
	replyThreadId: number | undefined,
): Promise<void> {
	if (!state.bot) return;
	const replyOpts = mdOptsForThread(replyThreadId);

	const result = await state.bot.createForumTopic(chatId, 'New Session');
	if (!result) {
		await state.bot.sendMessage(
			chatId,
			escapeMarkdownV2(
				'⚠️ Failed to create topic. Is the bot an admin with Manage Topics permission?',
			),
			replyOpts,
		);
		return;
	}

	state.pendingTopics.push(result.message_thread_id);
	saveState(state);
	await state.bot.sendMessage(
		chatId,
		escapeMarkdownV2(
			'Topic created. Run `athena` on your machine to connect it.',
		),
		mdOptsForThread(result.message_thread_id),
	);
	await state.bot.sendMessage(
		chatId,
		escapeMarkdownV2(
			`✅ New topic created (thread ${result.message_thread_id}). Start Athena to connect.`,
		),
		replyOpts,
	);
}

async function handleFlatMessage(
	state: RuntimeState,
	message: TelegramMessage,
	text: string,
): Promise<void> {
	const chatId = message.chat.id;
	const senderId = message.from!.id;

	const command = parseCommand(text);
	if (command === 'help') {
		if (state.bot) await state.bot.sendMessage(chatId, HELP_TEXT);
		return;
	}

	if (command === 'status') {
		if (!state.bot) return;
		const pending = [...state.pendingMessages.values()];
		if (pending.length === 0) {
			await state.bot.sendMessage(
				chatId,
				escapeMarkdownV2('No pending prompts.'),
				MD_OPTIONS,
			);
			return;
		}
		const noun = pending.length === 1 ? 'prompt' : 'prompts';
		const lines = [`*${pending.length} pending ${escapeMarkdownV2(noun)}:*`];
		for (const p of pending) {
			const icon = p.kind === 'permission' ? '🔐' : '❓';
			lines.push(
				`${icon} \`${p.sessionId}/${p.channelRequestId}\` — ${escapeMarkdownV2(p.headline)}`,
			);
		}
		await state.bot.sendMessage(chatId, lines.join('\n'), MD_OPTIONS);
		return;
	}

	if (command === 'cancel') {
		if (!state.bot) return;
		const all = [...state.pendingMessages.keys()];
		if (all.length === 0) {
			await state.bot.sendMessage(
				chatId,
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
		const answer =
			target?.pending.kind === 'question'
				? parseQuestionAnswer(text, target.pending.questionKeys)
				: null;
		if (answer) {
			send({
				session_id: target!.pending.sessionId,
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
				chat_id: String(chatId),
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
	const threadId = threadIdForSession(state, sessionId);
	const result = await state.bot.sendMessage(state.defaultChatId, text, {
		...mdOptsForThread(threadId),
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
			// Union-merge allowedUserIds — never overwrite (multi-session correctness)
			for (const id of message.params.allowed_user_ids) {
				state.allowedUserIds.add(String(id));
			}
			if (!state.bot) {
				void startBot(state, message.session_id, message.params.options);
			} else if (state.forumMode) {
				// Bot already running — ensure this session has a topic
				const label =
					typeof message.params.options['session_label'] === 'string'
						? message.params.options['session_label']
						: undefined;
				void ensureTopicForSession(state, message.session_id, label);
			}
			return;
		}
		case 'permission.request': {
			if (state.forumMode) {
				// Ensure topic exists before posting the prompt
				await ensureTopicForSession(state, message.session_id);
			}
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
			if (state.forumMode) {
				await ensureTopicForSession(state, message.session_id);
			}
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
			const threadId = threadIdForSession(state, message.session_id);
			const rendered = agentMarkdownToTelegramV2(message.params.content);
			const result = await state.bot.sendMessage(
				state.defaultChatId,
				rendered,
				mdOptsForThread(threadId),
			);
			if (!result) {
				await state.bot.sendMessage(
					state.defaultChatId,
					message.params.content,
					{message_thread_id: threadId},
				);
			}
			return;
		}
		case 'session.update': {
			if (!state.forumMode || !state.bot || state.defaultChatId === null)
				return;
			const threadId = state.sessionTopics.get(message.session_id);
			if (threadId === undefined) return;
			const label = message.params.label.slice(0, MAX_SESSION_LABEL_LEN);
			await state.bot.editForumTopic(state.defaultChatId, threadId, label);
			return;
		}
		case 'shutdown': {
			if (state.forumMode && state.bot && state.defaultChatId !== null) {
				const threadId = state.sessionTopics.get(message.session_id);
				if (threadId !== undefined) {
					void state.bot.closeForumTopic(state.defaultChatId, threadId);
				}
			}
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
		forumMode: false,
		sessionTopics: new Map(),
		topicSessions: new Map(),
		pendingTopics: [],
		statePath: null,
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
