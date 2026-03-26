import {type Theme, type ThemeName} from './types';

export const darkTheme: Theme = {
	name: 'dark',

	// ── Text hierarchy ──────────────────────────────────────
	text: '#c9d1d9', // Primary text. Warm gray, not pure white.
	textMuted: '#848d97', // Dim text. Bumped from #6e7681 for AA compliance (~4.8:1).
	textInverse: '#0d1117', // Text on colored backgrounds.

	// ── Accent ──────────────────────────────────────────────
	border: '#2d333b', // Bumped from #1e2a38 for visibility (~2.2:1 vs bg).
	accent: '#58a6ff', // Blue. Focus bar, branding, selection, links.
	accentSecondary: '#bc8cff', // Soft purple. Permission events.

	// ── Status ──────────────────────────────────────────────
	status: {
		success: '#3fb950', // Green. Completion, done glyphs.
		error: '#f85149', // Red. Failures, blocks, Tool Fail.
		warning: '#d29922', // Amber. Active stage, zero-result tint, caution.
		info: '#58a6ff', // Blue. Agent messages, Run OK.
		working: '#d29922', // Amber. Spinner state (same as warning).
		neutral: '#9da5ae', // Mid gray. Bumped from #8b949e for AA (~4.8:1).
	},

	// ── Context bar ─────────────────────────────────────────
	contextBar: {
		track: '#1e2a38', // Empty segment track.
		low: '#3fb950', // Green.  0–50% budget used.
		medium: '#d29922', // Amber. 50–80% budget used.
		high: '#f85149', // Red.   80–100% budget used.
	},

	// ── Dialog borders ──────────────────────────────────────
	dialog: {
		borderPermission: '#d29922', // Amber border for permission prompts.
		borderQuestion: '#58a6ff', // Blue border for question prompts.
	},

	// ── Input ───────────────────────────────────────────────
	inputPrompt: '#388bfd', // Blue "input" keyword in prompt.
	inputChevron: '#484f58', // Bumped from #30363d for visibility (~2.8:1).

	// ── Feed ────────────────────────────────────────────────
	feed: {
		headerLabel: '#848d97', // Matches textMuted.
		stripeBackground: '#161b22', // Bumped from #0d1521 for visible alternation.
		focusBackground: '#1b2a3f', // Blue tint for focused row.
	},

	// ── User messages ───────────────────────────────────────
	userMessage: {
		text: '#c9d1d9', // Same as primary text.
		background: '#161b22', // Slightly lifted from terminal bg.
		border: '#30363d', // Subtle border.
	},

	// ── Badges ──────────────────────────────────────────────
	badge: {
		error: {bg: '#4b1014', fg: '#ff7b72'},
		running: {bg: '#4a3a0c', fg: '#fbbf24'},
		idle: {bg: '#10321d', fg: '#3fb950'},
		search: {bg: '#1b2a3f'},
		command: {bg: '#2a1b3f'},
	},

	// ── Detail view ─────────────────────────────────────────
	detail: {
		title: '#c9d1d9',
		subject: '#58a6ff',
	},

	// ── Tool pills ──────────────────────────────────────────
	toolPill: {
		safe: {bg: '#0e2233', fg: '#5ba3cc'},
		mutating: {bg: '#2a1d0a', fg: '#d4a44a'},
		browser: {bg: '#0b2625', fg: '#5cc4ba'},
		neutral: {bg: '#141a22', fg: '#7d8590'},
		skill: {bg: '#2a0f24', fg: '#c98ab8'},
		'subagent.spawn': {bg: '#0a2e22', fg: '#5cc4a0'},
		'subagent.return': {bg: '#0a2e22', fg: '#56b492'},
	},
};

export const lightTheme: Theme = {
	name: 'light',

	// ── Text hierarchy ──────────────────────────────────────
	text: '#1f2328', // Near-black. Strong contrast.
	textMuted: '#656d76', // Medium gray. Same role as dark textMuted.
	textInverse: '#ffffff', // White on colored backgrounds.

	// ── Accent ──────────────────────────────────────────────
	border: '#d0d7de', // Light border, not accent-colored.
	accent: '#0969da', // Darker blue for light backgrounds.
	accentSecondary: '#8250df', // Purple, darkened for readability.

	// ── Status ──────────────────────────────────────────────
	status: {
		success: '#1a7f37', // Dark green. Readable on white.
		error: '#cf222e', // Dark red.
		warning: '#9a6700', // Dark amber.
		info: '#0969da', // Dark blue. Matches accent.
		working: '#9a6700', // Dark amber.
		neutral: '#656d76', // Mid gray.
	},

	// ── Context bar ─────────────────────────────────────────
	contextBar: {
		track: '#d0d7de', // Light gray track.
		low: '#1a7f37',
		medium: '#9a6700',
		high: '#cf222e',
	},

	// ── Dialog borders ──────────────────────────────────────
	dialog: {
		borderPermission: '#9a6700',
		borderQuestion: '#0969da',
	},

	// ── Input ───────────────────────────────────────────────
	inputPrompt: '#0969da',
	inputChevron: '#656d76',

	// ── Feed ────────────────────────────────────────────────
	feed: {
		headerLabel: '#656d76',
		stripeBackground: '#f6f8fa',
		focusBackground: '#ddf4ff', // Light blue tint for focused row.
	},

	// ── User messages ───────────────────────────────────────
	userMessage: {
		text: '#1f2328',
		background: '#f6f8fa',
		border: '#d0d7de',
	},

	// ── Badges ──────────────────────────────────────────────
	badge: {
		error: {bg: '#ffebe9', fg: '#cf222e'},
		running: {bg: '#fff8c5', fg: '#9a6700'},
		idle: {bg: '#dafbe1', fg: '#1a7f37'},
		search: {bg: '#ddf4ff'},
		command: {bg: '#fbefff'},
	},

	// ── Detail view ─────────────────────────────────────────
	detail: {
		title: '#1f2328',
		subject: '#0969da',
	},

	// ── Tool pills ──────────────────────────────────────────
	toolPill: {
		safe: {bg: '#ddf4ff', fg: '#0550ae'},
		mutating: {bg: '#fff8c5', fg: '#7c5200'},
		browser: {bg: '#dafbe1', fg: '#116329'},
		neutral: {bg: '#f6f8fa', fg: '#424a53'},
		skill: {bg: '#fbefff', fg: '#6639ba'},
		'subagent.spawn': {bg: '#dafbe1', fg: '#116329'},
		'subagent.return': {bg: '#dafbe1', fg: '#1a7f37'},
	},
};

/**
 * High-contrast theme — maximum differentiation for accessibility.
 * Brighter values, wider gaps between hierarchy levels.
 */
export const highContrastTheme: Theme = {
	name: 'high-contrast',

	// ── Text hierarchy ──────────────────────────────────────
	text: '#f0f6fc', // Near-white. Maximum brightness.
	textMuted: '#9ea7b3', // Bumped from #7d8590 for better contrast (~5.2:1).
	textInverse: '#010409', // Near-black.

	// ── Accent ──────────────────────────────────────────────
	border: '#71b7ff',
	accent: '#71b7ff', // Brighter blue. Punches through.
	accentSecondary: '#d2a8ff', // Bright purple.

	// ── Status ──────────────────────────────────────────────
	status: {
		success: '#56d364', // Bright green. Higher saturation.
		error: '#ff7b72', // Bright red. Softened for readability.
		warning: '#e3b341', // Bright amber.
		info: '#71b7ff', // Bright blue.
		working: '#e3b341', // Bright amber.
		neutral: '#b1bac4', // Bumped from #9ea7b3 for HC (~6.0:1).
	},

	// ── Context bar ─────────────────────────────────────────
	contextBar: {
		track: '#3d444d', // HC track — brighter than dark.
		low: '#56d364',
		medium: '#e3b341',
		high: '#ff7b72',
	},

	// ── Dialog borders ──────────────────────────────────────
	dialog: {
		borderPermission: '#e3b341',
		borderQuestion: '#71b7ff',
	},

	// ── Input ───────────────────────────────────────────────
	inputPrompt: '#71b7ff',
	inputChevron: '#9ea7b3', // Bumped from #7d8590 for visibility.

	// ── Feed ────────────────────────────────────────────────
	feed: {
		headerLabel: '#9ea7b3', // Matches textMuted.
		stripeBackground: '#0d1521', // Bumped from #0b141f for visible alternation.
		focusBackground: '#1a3350', // Brighter blue tint for HC.
	},

	// ── User messages ───────────────────────────────────────
	userMessage: {
		text: '#f0f6fc',
		background: '#1c2128', // Bumped from #161b22 for visible distinction.
		border: '#444c56', // Bumped from #3d444d for HC visibility.
	},

	// ── Badges ──────────────────────────────────────────────
	badge: {
		error: {bg: '#6e1b16', fg: '#ff7b72'},
		running: {bg: '#5c4813', fg: '#e3b341'},
		idle: {bg: '#154228', fg: '#56d364'},
		search: {bg: '#1a3350'},
		command: {bg: '#301e50'},
	},

	// ── Detail view ─────────────────────────────────────────
	detail: {
		title: '#f0f6fc',
		subject: '#71b7ff',
	},

	// ── Tool pills ──────────────────────────────────────────
	toolPill: {
		safe: {bg: '#122d42', fg: '#a2d2ff'},
		mutating: {bg: '#3a2e10', fg: '#f0d070'},
		browser: {bg: '#0f3520', fg: '#7ee28b'},
		neutral: {bg: '#1c2128', fg: '#b1bac4'},
		skill: {bg: '#2b1a40', fg: '#e0c0ff'},
		'subagent.spawn': {bg: '#0f3520', fg: '#7ee28b'},
		'subagent.return': {bg: '#0f3520', fg: '#6bcc79'},
	},
};

const THEMES: Record<ThemeName, Theme> = {
	dark: darkTheme,
	light: lightTheme,
	'high-contrast': highContrastTheme,
};

export function resolveTheme(name: string | undefined): Theme {
	if (name && name in THEMES) {
		return THEMES[name as ThemeName];
	}
	return darkTheme;
}
