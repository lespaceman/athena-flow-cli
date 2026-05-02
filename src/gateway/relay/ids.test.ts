import {describe, expect, it} from 'vitest';
import {
	CHANNEL_REQUEST_ID_LENGTH,
	generateChannelRequestId,
	isValidChannelRequestId,
} from './ids';

describe('channel request ids', () => {
	it('generates lowercase 5-char ids in the [a-km-z] alphabet', () => {
		for (let i = 0; i < 200; i++) {
			const id = generateChannelRequestId();
			expect(id).toHaveLength(CHANNEL_REQUEST_ID_LENGTH);
			expect(id).toMatch(/^[a-km-z]{5}$/);
			expect(id.toLowerCase()).toBe(id);
		}
	});

	it('rejects invalid forms', () => {
		expect(isValidChannelRequestId('')).toBe(false);
		expect(isValidChannelRequestId('abcde')).toBe(true);
		expect(isValidChannelRequestId('abcd')).toBe(false);
		expect(isValidChannelRequestId('abcdef')).toBe(false);
		expect(isValidChannelRequestId('Abcde')).toBe(false); // uppercase
		expect(isValidChannelRequestId('abcd1')).toBe(false); // digit
		expect(isValidChannelRequestId('lloyd')).toBe(false); // 'l' excluded
		expect(isValidChannelRequestId('hello')).toBe(false); // 'l' excluded
	});

	it('produces ids without the excluded letter l', () => {
		for (let i = 0; i < 500; i++) {
			expect(generateChannelRequestId()).not.toContain('l');
		}
	});
});
