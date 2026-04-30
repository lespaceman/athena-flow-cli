/**
 * NDJSON framing + hand-rolled validators for the Athena ⇄ channel protocol.
 *
 * Validators are intentionally structural and minimal — the protocol surface
 * is small (5 methods, 5 events) and we don't pull in a runtime schema lib.
 */

import {Buffer} from 'node:buffer';
import {isValidChannelRequestId} from './ids';
import type {
	ChannelEventMessage,
	ChannelMethodMessage,
	ChannelLogLevel,
	ChannelCancelReason,
	ChannelQuestion,
} from './types';

export type ParseResult<T> = {ok: true; value: T} | {ok: false; reason: string};

const CANCEL_REASONS: readonly ChannelCancelReason[] = [
	'resolved_locally',
	'resolved_by_other_channel',
	'auto_resolved',
	'timeout',
];

const LOG_LEVELS: readonly ChannelLogLevel[] = [
	'debug',
	'info',
	'warn',
	'error',
];

function isStringRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every(item => typeof item === 'string');
}

function isStringMap(v: unknown): v is Record<string, string> {
	if (!isStringRecord(v)) return false;
	for (const value of Object.values(v)) {
		if (typeof value !== 'string') return false;
	}
	return true;
}

function parseQuestions(v: unknown): ChannelQuestion[] | null {
	if (!Array.isArray(v)) return null;
	const questions: ChannelQuestion[] = [];
	for (const item of v) {
		if (!isStringRecord(item)) return null;
		const {key, header, question, multi_select, options} = item;
		if (
			typeof key !== 'string' ||
			typeof header !== 'string' ||
			typeof question !== 'string' ||
			typeof multi_select !== 'boolean' ||
			!Array.isArray(options)
		) {
			return null;
		}
		const parsedOptions = [];
		for (const option of options) {
			if (!isStringRecord(option)) return null;
			if (
				typeof option['label'] !== 'string' ||
				typeof option['description'] !== 'string'
			) {
				return null;
			}
			parsedOptions.push({
				label: option['label'],
				description: option['description'],
			});
		}
		questions.push({
			key,
			header,
			question,
			multi_select,
			options: parsedOptions,
		});
	}
	return questions;
}

export function parseMethodMessage(
	raw: unknown,
): ParseResult<ChannelMethodMessage> {
	if (!isStringRecord(raw)) return {ok: false, reason: 'not an object'};
	const {session_id, method, params} = raw;
	if (typeof session_id !== 'string' || session_id.length === 0) {
		return {ok: false, reason: 'session_id must be non-empty string'};
	}
	if (typeof method !== 'string') return {ok: false, reason: 'method missing'};
	if (!isStringRecord(params))
		return {ok: false, reason: 'params missing or not an object'};

	switch (method) {
		case 'init': {
			if (!isStringArray(params['allowed_user_ids']))
				return {ok: false, reason: 'allowed_user_ids must be string[]'};
			if (!isStringRecord(params['options']))
				return {ok: false, reason: 'options must be an object'};
			return {
				ok: true,
				value: {
					session_id,
					method,
					params: {
						allowed_user_ids: params['allowed_user_ids'],
						options: params['options'],
					},
				},
			};
		}
		case 'permission.request': {
			const {channel_request_id, tool_name, description, input_preview} =
				params;
			if (
				typeof channel_request_id !== 'string' ||
				!isValidChannelRequestId(channel_request_id)
			)
				return {ok: false, reason: 'channel_request_id invalid'};
			if (typeof tool_name !== 'string')
				return {ok: false, reason: 'tool_name must be string'};
			if (typeof description !== 'string')
				return {ok: false, reason: 'description must be string'};
			if (typeof input_preview !== 'string')
				return {ok: false, reason: 'input_preview must be string'};
			return {
				ok: true,
				value: {
					session_id,
					method,
					params: {channel_request_id, tool_name, description, input_preview},
				},
			};
		}
		case 'permission.cancel': {
			const {channel_request_id, reason} = params;
			if (
				typeof channel_request_id !== 'string' ||
				!isValidChannelRequestId(channel_request_id)
			)
				return {ok: false, reason: 'channel_request_id invalid'};
			if (
				typeof reason !== 'string' ||
				!(CANCEL_REASONS as readonly string[]).includes(reason)
			)
				return {ok: false, reason: 'reason invalid'};
			return {
				ok: true,
				value: {
					session_id,
					method,
					params: {channel_request_id, reason: reason as ChannelCancelReason},
				},
			};
		}
		case 'question.request': {
			const {channel_request_id, title} = params;
			if (
				typeof channel_request_id !== 'string' ||
				!isValidChannelRequestId(channel_request_id)
			)
				return {ok: false, reason: 'channel_request_id invalid'};
			if (typeof title !== 'string')
				return {ok: false, reason: 'title must be string'};
			const questions = parseQuestions(params['questions']);
			if (!questions) return {ok: false, reason: 'questions invalid'};
			return {
				ok: true,
				value: {
					session_id,
					method,
					params: {channel_request_id, title, questions},
				},
			};
		}
		case 'question.cancel': {
			const {channel_request_id, reason} = params;
			if (
				typeof channel_request_id !== 'string' ||
				!isValidChannelRequestId(channel_request_id)
			)
				return {ok: false, reason: 'channel_request_id invalid'};
			if (
				typeof reason !== 'string' ||
				!(CANCEL_REASONS as readonly string[]).includes(reason)
			)
				return {ok: false, reason: 'reason invalid'};
			return {
				ok: true,
				value: {
					session_id,
					method,
					params: {channel_request_id, reason: reason as ChannelCancelReason},
				},
			};
		}
		case 'notification': {
			if (typeof params['content'] !== 'string')
				return {ok: false, reason: 'content must be string'};
			if (!isStringMap(params['meta']))
				return {ok: false, reason: 'meta must be Record<string,string>'};
			return {
				ok: true,
				value: {
					session_id,
					method,
					params: {content: params['content'], meta: params['meta']},
				},
			};
		}
		case 'shutdown':
			return {ok: true, value: {session_id, method, params: {}}};
		default:
			return {ok: false, reason: `unknown method: ${method}`};
	}
}

export function parseEventMessage(
	raw: unknown,
): ParseResult<ChannelEventMessage> {
	if (!isStringRecord(raw)) return {ok: false, reason: 'not an object'};
	const {session_id, event, params} = raw;
	if (typeof session_id !== 'string' || session_id.length === 0) {
		return {ok: false, reason: 'session_id must be non-empty string'};
	}
	if (typeof event !== 'string') return {ok: false, reason: 'event missing'};
	if (!isStringRecord(params))
		return {ok: false, reason: 'params missing or not an object'};

	switch (event) {
		case 'ready': {
			if (typeof params['name'] !== 'string')
				return {ok: false, reason: 'name must be string'};
			if (typeof params['version'] !== 'string')
				return {ok: false, reason: 'version must be string'};
			return {
				ok: true,
				value: {
					session_id,
					event,
					params: {name: params['name'], version: params['version']},
				},
			};
		}
		case 'permission.verdict': {
			const {channel_request_id, behavior} = params;
			if (
				typeof channel_request_id !== 'string' ||
				!isValidChannelRequestId(channel_request_id)
			)
				return {ok: false, reason: 'channel_request_id invalid'};
			if (behavior !== 'allow' && behavior !== 'deny')
				return {ok: false, reason: 'behavior must be allow|deny'};
			return {
				ok: true,
				value: {session_id, event, params: {channel_request_id, behavior}},
			};
		}
		case 'question.answer': {
			const {channel_request_id} = params;
			if (
				typeof channel_request_id !== 'string' ||
				!isValidChannelRequestId(channel_request_id)
			)
				return {ok: false, reason: 'channel_request_id invalid'};
			if (!isStringMap(params['answers']))
				return {ok: false, reason: 'answers must be Record<string,string>'};
			return {
				ok: true,
				value: {
					session_id,
					event,
					params: {channel_request_id, answers: params['answers']},
				},
			};
		}
		case 'chat.message': {
			if (typeof params['content'] !== 'string')
				return {ok: false, reason: 'content must be string'};
			if (!isStringMap(params['meta']))
				return {ok: false, reason: 'meta must be Record<string,string>'};
			if (
				typeof params['meta']['sender_id'] !== 'string' ||
				params['meta']['sender_id'].length === 0
			)
				return {ok: false, reason: 'meta.sender_id required'};
			return {
				ok: true,
				value: {
					session_id,
					event,
					params: {content: params['content'], meta: params['meta']},
				},
			};
		}
		case 'error': {
			if (typeof params['message'] !== 'string')
				return {ok: false, reason: 'message must be string'};
			const fatal = params['fatal'];
			if (fatal !== undefined && typeof fatal !== 'boolean')
				return {ok: false, reason: 'fatal must be boolean if present'};
			return {
				ok: true,
				value: {
					session_id,
					event,
					params: {
						message: params['message'],
						...(typeof fatal === 'boolean' ? {fatal} : {}),
					},
				},
			};
		}
		case 'log': {
			const {level, message} = params;
			if (
				typeof level !== 'string' ||
				!(LOG_LEVELS as readonly string[]).includes(level)
			)
				return {ok: false, reason: 'level invalid'};
			if (typeof message !== 'string')
				return {ok: false, reason: 'message must be string'};
			return {
				ok: true,
				value: {
					session_id,
					event,
					params: {level: level as ChannelLogLevel, message},
				},
			};
		}
		default:
			return {ok: false, reason: `unknown event: ${event}`};
	}
}

export function encodeLine(value: unknown): string {
	return JSON.stringify(value) + '\n';
}

/**
 * Stateful line splitter. Feed chunks via `push`; consumer drains with
 * `drain()` after each push. Splits on \n and tolerates \r\n.
 */
export class LineReader {
	private buffer = '';
	push(chunk: Buffer | string): string[] {
		this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
		const lines: string[] = [];
		let idx = this.buffer.indexOf('\n');
		while (idx !== -1) {
			let line = this.buffer.slice(0, idx);
			if (line.endsWith('\r')) line = line.slice(0, -1);
			if (line.length > 0) lines.push(line);
			this.buffer = this.buffer.slice(idx + 1);
			idx = this.buffer.indexOf('\n');
		}
		return lines;
	}
	flush(): string[] {
		const remainder = this.buffer.trim();
		this.buffer = '';
		return remainder.length > 0 ? [remainder] : [];
	}
}
