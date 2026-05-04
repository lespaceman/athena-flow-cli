/**
 * Parsers for Telegram channel replies.
 *
 * Text replies (legacy / power-user path):
 *   "yes abcde" / "y abcde" → allow
 *   "no abcde"  / "n abcde" → deny
 *   "answer abcde ..."      → question answer
 *
 * Inline-keyboard callback_data (preferred path):
 *   "v:abcde:a" / "v:abcde:d"   → permission verdict
 *   "q:abcde:<optIdx>"          → question option pick (single-question only)
 *
 * Case-insensitive for text (phone autocorrect frequently capitalizes the
 * first letter). The 5-letter ID alphabet matches the Athena/Claude Code
 * channel-request-id alphabet, sourced from `../ids`.
 */

import {
	CHANNEL_REQUEST_ID_REGEX,
	isValidChannelRequestId,
} from '../../../shared/gateway-protocol/channelRequestId';

export type ParsedVerdict = {
	channelRequestId: string;
	behavior: 'allow' | 'deny';
};

export type ParsedQuestionAnswer = {
	channelRequestId: string;
	answers: Record<string, string>;
};

export type ParsedPermissionCallback = {
	kind: 'permission';
	channelRequestId: string;
	behavior: 'allow' | 'deny';
};

export type ParsedQuestionCallback = {
	kind: 'question';
	channelRequestId: string;
	optionIndex: number;
};

export type ParsedCallback = ParsedPermissionCallback | ParsedQuestionCallback;

const CB_PERMISSION = 'v';
const CB_QUESTION = 'q';
const CB_ALLOW = 'a';
const CB_DENY = 'd';

const CB_VERDICT: Record<'allow' | 'deny', string> = {
	allow: CB_ALLOW,
	deny: CB_DENY,
};

const ID_PATTERN = CHANNEL_REQUEST_ID_REGEX.source.replace(/^\^|\$$/g, '');
const VERDICT_RE = new RegExp(`^\\s*(y|yes|n|no)\\s+(${ID_PATTERN})\\s*$`, 'i');
const ANSWER_RE = new RegExp(
	`^\\s*(a|answer)\\s+(${ID_PATTERN})\\s+([\\s\\S]+?)\\s*$`,
	'i',
);
const ANSWER_ID_RE = new RegExp(`^\\s*(a|answer)\\s+(${ID_PATTERN})\\s+`, 'i');
const NON_NEG_INT_RE = /^\d+$/;
const MAX_JSON_ANSWER_BYTES = 8 * 1024;

export function parseVerdict(text: string): ParsedVerdict | null {
	const m = VERDICT_RE.exec(text);
	if (!m) return null;
	const verdictWord = m[1]!.toLowerCase();
	const id = m[2]!.toLowerCase();
	return {
		channelRequestId: id,
		behavior: verdictWord.startsWith('y') ? 'allow' : 'deny',
	};
}

export function parseQuestionAnswer(
	text: string,
	questionKeys: readonly string[],
): ParsedQuestionAnswer | null {
	const m = ANSWER_RE.exec(text);
	if (!m) return null;
	const channelRequestId = m[2]!.toLowerCase();
	const rawAnswer = m[3]!.trim();
	if (rawAnswer.length === 0) return null;

	if (rawAnswer.startsWith('{')) {
		if (rawAnswer.length > MAX_JSON_ANSWER_BYTES) return null;
		try {
			const parsed = JSON.parse(rawAnswer) as unknown;
			if (
				typeof parsed !== 'object' ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				return null;
			}
			const answers: Record<string, string> = {};
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value !== 'string') return null;
				answers[key] = value;
			}
			return {channelRequestId, answers};
		} catch {
			return null;
		}
	}

	const firstKey = questionKeys[0];
	if (!firstKey) return null;
	return {
		channelRequestId,
		answers: {[firstKey]: rawAnswer},
	};
}

export function parseQuestionAnswerId(text: string): string | null {
	const m = ANSWER_ID_RE.exec(text);
	return m ? m[2]!.toLowerCase() : null;
}

export function buildPlainTextQuestionAnswer(
	channelRequestId: string,
	text: string,
	questionKeys: readonly string[],
): ParsedQuestionAnswer | null {
	const answer = text.trim();
	const firstKey = questionKeys[0];
	if (!firstKey || answer.length === 0) return null;
	return {
		channelRequestId,
		answers: {[firstKey]: answer},
	};
}

export function parseCallbackData(data: string): ParsedCallback | null {
	const parts = data.split(':');
	const kind = parts[0];
	const id = parts[1];
	if (!id || !isValidChannelRequestId(id)) return null;

	if (kind === CB_PERMISSION && parts.length === 3) {
		const verb = parts[2]!;
		if (verb !== CB_ALLOW && verb !== CB_DENY) return null;
		return {
			kind: 'permission',
			channelRequestId: id,
			behavior: verb === CB_ALLOW ? 'allow' : 'deny',
		};
	}
	if (kind === CB_QUESTION && parts.length === 3) {
		const idxStr = parts[2]!;
		if (!NON_NEG_INT_RE.test(idxStr)) return null;
		const optionIndex = Number.parseInt(idxStr, 10);
		return {kind: 'question', channelRequestId: id, optionIndex};
	}
	return null;
}

export function buildPermissionCallbackData(
	channelRequestId: string,
	behavior: 'allow' | 'deny',
): string {
	return `${CB_PERMISSION}:${channelRequestId}:${CB_VERDICT[behavior]}`;
}

export function buildQuestionCallbackData(
	channelRequestId: string,
	optionIndex: number,
): string {
	return `${CB_QUESTION}:${channelRequestId}:${optionIndex}`;
}
