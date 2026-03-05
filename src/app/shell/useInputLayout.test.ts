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
			'Done — send a follow-up',
		);
	});

	it('returns failed message on failed run', () => {
		expect(deriveInputPlaceholder('normal', 'failed')).toBe(
			'Run failed — retry or adjust prompt',
		);
	});

	it('returns failed message on aborted run', () => {
		expect(deriveInputPlaceholder('normal', 'aborted')).toBe(
			'Run failed — retry or adjust prompt',
		);
	});

	it('uses ASCII-safe separator in ascii mode', () => {
		expect(deriveInputPlaceholder('normal', 'completed', true)).toBe(
			'Done - send a follow-up',
		);
	});

	it('returns default prompt for normal mode without status', () => {
		expect(deriveInputPlaceholder('normal', null)).toBe(
			'Type a prompt to begin',
		);
	});

	it('returns default prompt for normal mode with working status', () => {
		expect(deriveInputPlaceholder('normal', 'working')).toBe(
			'Type a prompt to begin',
		);
	});
});

describe('deriveTextInputPlaceholder', () => {
	it('returns input placeholder when dialog is not active', () => {
		expect(
			deriveTextInputPlaceholder(false, undefined, 'Type a prompt to begin'),
		).toBe('Type a prompt to begin');
	});

	it('returns question message for question dialog', () => {
		expect(
			deriveTextInputPlaceholder(true, 'question', 'Type a prompt to begin'),
		).toBe('Answer question in dialog...');
	});

	it('returns permission message for permission dialog', () => {
		expect(
			deriveTextInputPlaceholder(true, 'permission', 'Type a prompt to begin'),
		).toBe('Respond to permission dialog...');
	});

	it('returns permission message for other dialog types', () => {
		expect(
			deriveTextInputPlaceholder(true, 'working', 'Type a prompt to begin'),
		).toBe('Respond to permission dialog...');
	});
});
