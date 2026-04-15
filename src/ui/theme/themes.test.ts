import {describe, it, expect} from 'vitest';
import {darkTheme, lightTheme, highContrastTheme, resolveTheme} from './themes';
import {type Theme} from './types';

/** Verify a theme has all required tokens with valid hex strings. */
function assertValidTheme(theme: Theme) {
	const hexPattern = /^#[0-9a-f]{6}$/i;
	const flat = [
		theme.text,
		theme.textMuted,
		theme.textInverse,
		theme.border,
		theme.accent,
		theme.accentSecondary,
		theme.status.success,
		theme.status.error,
		theme.status.warning,
		theme.status.info,
		theme.status.working,
		theme.status.neutral,
		theme.contextBar.low,
		theme.contextBar.medium,
		theme.contextBar.high,
		theme.dialog.borderPermission,
		theme.dialog.borderQuestion,
		theme.inputPrompt,
		theme.inputChevron,
		theme.inputBackground,
		theme.feed.headerLabel,
		theme.userMessage.text,
		theme.userMessage.background,
		theme.userMessage.border,
	];
	if (theme.feed.stripeBackground !== null) {
		flat.push(theme.feed.stripeBackground);
	}
	for (const hex of flat) {
		expect(hex).toMatch(hexPattern);
	}
}

describe('themes', () => {
	it('dark theme has all valid hex tokens', () => {
		assertValidTheme(darkTheme);
	});

	it('light theme has all valid hex tokens', () => {
		assertValidTheme(lightTheme);
	});

	it('high-contrast theme has all valid hex tokens', () => {
		assertValidTheme(highContrastTheme);
	});

	it('each theme has a distinct name', () => {
		const names = [darkTheme.name, lightTheme.name, highContrastTheme.name];
		expect(new Set(names).size).toBe(3);
	});
});

describe('resolveTheme', () => {
	it('returns dark by default', () => {
		expect(resolveTheme(undefined).name).toBe('dark');
		expect(resolveTheme('dark').name).toBe('dark');
	});

	it('returns light when requested', () => {
		expect(resolveTheme('light').name).toBe('light');
	});

	it('returns high-contrast when requested', () => {
		expect(resolveTheme('high-contrast').name).toBe('high-contrast');
	});

	it('falls back to dark for invalid values', () => {
		expect(resolveTheme('neon').name).toBe('dark');
	});
});
