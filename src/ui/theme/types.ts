export type ThemeName = 'dark' | 'light' | 'high-contrast';

export type ToolPillPalette = {
	bg: string;
	fg: string;
};

export type Theme = {
	name: ThemeName;
	border: string;
	text: string;
	textMuted: string;
	textInverse: string;
	status: {
		success: string;
		error: string;
		warning: string;
		info: string;
		working: string;
		neutral: string;
	};
	accent: string;
	accentSecondary: string;
	contextBar: {
		track: string;
		low: string;
		medium: string;
		high: string;
	};
	dialog: {
		borderPermission: string;
		borderQuestion: string;
	};
	inputPrompt: string;
	inputChevron: string;
	inputBackground: string;
	feed: {
		headerLabel: string;
		stripeBackground: string | null;
		focusBackground: string;
	};
	userMessage: {
		text: string;
		background: string;
		border: string;
	};
	badge: {
		error: {bg: string; fg: string};
		running: {bg: string; fg: string};
		idle: {bg: string; fg: string};
		search: {bg: string};
		command: {bg: string};
	};
	detail: {
		title: string;
		subject: string;
	};
	toolPill: {
		safe: ToolPillPalette;
		mutating: ToolPillPalette;
		browser: ToolPillPalette;
		neutral: ToolPillPalette;
		skill: ToolPillPalette;
		'subagent.spawn': ToolPillPalette;
		'subagent.return': ToolPillPalette;
	};
};
