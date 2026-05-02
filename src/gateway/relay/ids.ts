import {randomInt} from 'node:crypto';

/**
 * 25-letter alphabet: a..k (11) + m..z (14), excluding `l` to avoid
 * confusion with `1` and `I` on phone keyboards. Matches Claude Code's
 * channel-request-id alphabet so a portability shim stays straightforward.
 */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyz';

export const CHANNEL_REQUEST_ID_LENGTH = 5;

export const CHANNEL_REQUEST_ID_REGEX = /^[a-km-z]{5}$/;

export function generateChannelRequestId(): string {
	let id = '';
	for (let i = 0; i < CHANNEL_REQUEST_ID_LENGTH; i++) {
		id += ALPHABET[randomInt(ALPHABET.length)];
	}
	return id;
}

export function isValidChannelRequestId(value: string): boolean {
	return CHANNEL_REQUEST_ID_REGEX.test(value);
}
