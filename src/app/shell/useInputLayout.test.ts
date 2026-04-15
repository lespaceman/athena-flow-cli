import {describe, it, expect} from 'vitest';
import {
	deriveInputPlaceholder,
	deriveTextInputPlaceholder,
} from './useInputLayout';

describe('deriveInputPlaceholder', () => {
	it('returns :search for search mode', () => {
		expect(deriveInputPlaceholder('search', null)).toBe(':search');
	});

	it('returns follow-up message on completed run', () => {
		expect(deriveInputPlaceholder('normal', 'completed')).toBe(
			'Write a message',
		);
	});

	it('returns startup failure message when startup failed', () => {
		expect(deriveInputPlaceholder('normal', null, 'Socket path too long')).toBe(
			'Write a message',
		);
	});

	it('returns failed message on failed run', () => {
		expect(deriveInputPlaceholder('normal', 'failed')).toBe('Write a message');
	});

	it('returns failed message on aborted run', () => {
		expect(deriveInputPlaceholder('normal', 'aborted')).toBe('Write a message');
	});

	it('returns default prompt for normal mode without status', () => {
		expect(deriveInputPlaceholder('normal', null)).toBe('Write a message');
	});

	it('returns default prompt for normal mode with working status', () => {
		expect(deriveInputPlaceholder('normal', 'working')).toBe('Write a message');
	});
});

describe('deriveTextInputPlaceholder', () => {
	it('returns input placeholder when dialog is not active', () => {
		expect(
			deriveTextInputPlaceholder(false, undefined, 'Write a message'),
		).toBe('Write a message');
	});

	it('returns question message for question dialog', () => {
		expect(
			deriveTextInputPlaceholder(true, 'question', 'Write a message'),
		).toBe('Answer question in dialog...');
	});

	it('returns permission message for permission dialog', () => {
		expect(
			deriveTextInputPlaceholder(true, 'permission', 'Write a message'),
		).toBe('Respond to permission dialog...');
	});

	it('returns diagnostics message for diagnostics dialog', () => {
		expect(
			deriveTextInputPlaceholder(true, 'diagnostics', 'Write a message'),
		).toBe('Respond to diagnostics dialog...');
	});

	it('returns permission message for other dialog types', () => {
		expect(deriveTextInputPlaceholder(true, 'working', 'Write a message')).toBe(
			'Respond to permission dialog...',
		);
	});
});
