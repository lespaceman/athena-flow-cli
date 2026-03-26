/**
 * Visual theme preview — renders every theme against simulated
 * dark and light terminal backgrounds.
 *
 * Run: npx tsx scripts/theme-preview.ts [dark|light|high-contrast]
 */
import chalk from 'chalk';
import {darkTheme, lightTheme, highContrastTheme} from '../src/ui/theme/themes';
import type {Theme} from '../src/ui/theme/types';

const THEMES: Record<string, Theme> = {
	dark: darkTheme,
	light: lightTheme,
	'high-contrast': highContrastTheme,
};

// Simulated terminal backgrounds for visual testing
const TERM_BACKGROUNDS: Array<{name: string; bg: string}> = [
	{name: 'Dark terminal  (#0d1117)', bg: '#0d1117'},
	{name: 'Medium terminal (#1e1e2e)', bg: '#1e1e2e'},
	{name: 'Light terminal (#ffffff)', bg: '#ffffff'},
	{name: 'Warm light     (#fdf6e3)', bg: '#fdf6e3'},
];

const W = 62;

function hr(ch: string, width: number): string {
	return ch.repeat(width);
}

function pad(s: string, width: number): string {
	// eslint-disable-next-line no-control-regex
	const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
	const diff = width - stripped.length;
	return diff > 0 ? s + ' '.repeat(diff) : s;
}

function renderSection(theme: Theme, bg: string): void {
	const bgFn = (s: string) => chalk.bgHex(bg)(s);
	const row = (content: string) => {
		console.log(bgFn(pad(`  ${content}`, W)));
	};
	const blank = () => console.log(bgFn(' '.repeat(W)));

	const c = (hex: string) => chalk.hex(hex);
	const cb = (hex: string) => chalk.hex(hex).bold;

	blank();

	// ── Header ──────────────────────────────────────────
	row(
		cb(theme.text)('ATHENA FLOW') +
			'  ' +
			c(theme.textMuted)('│') +
			'  ' +
			c(theme.textMuted)('Harness: ') +
			c(theme.status.neutral)('Claude Code'),
	);
	blank();

	// ── Context bar ─────────────────────────────────────
	const barW = 20;
	const filled = Math.round(barW * 0.35);
	const bar =
		chalk.bgHex(theme.contextBar.low).hex(bg)('█'.repeat(filled)) +
		chalk.hex(theme.contextBar.track)('░'.repeat(barW - filled));
	row(c(theme.textMuted)('Context ') + bar + c(theme.textMuted)(' 35%'));
	blank();

	// ── Border line ─────────────────────────────────────
	row(c(theme.border)(hr('─', W - 4)));

	// ── Feed rows ───────────────────────────────────────
	const pills: Array<{
		cat: keyof Theme['toolPill'];
		label: string;
		detail: string;
	}> = [
		{cat: 'safe', label: 'Read', detail: 'src/app/shell/AppShell.tsx'},
		{cat: 'mutating', label: 'Write', detail: 'src/config.ts'},
		{cat: 'browser', label: 'WebFetch', detail: 'https://api.example.com'},
		{cat: 'skill', label: 'Skill', detail: '/commit'},
		{cat: 'subagent.spawn', label: 'Agent', detail: 'explore codebase'},
		{cat: 'neutral', label: 'Task', detail: 'json_output'},
	];

	for (let i = 0; i < pills.length; i++) {
		const p = pills[i];
		const pal = theme.toolPill[p.cat];
		const stripe =
			i % 2 === 1 && theme.feed.stripeBackground
				? chalk.bgHex(theme.feed.stripeBackground)
				: (s: string) => s;

		const pill =
			chalk.bgHex(pal.bg).hex(pal.fg)(` ${p.label} `) +
			'  ' +
			c(theme.textMuted)(p.detail);

		// Show one row with focus highlight
		if (i === 1) {
			const focused = chalk.bgHex(theme.feed.focusBackground)(
				pad(`  ${c(theme.accent)('▎')} ${pill}`, W),
			);
			console.log(bgFn(focused));
		} else {
			console.log(bgFn(stripe(pad(`    ${pill}`, W))));
		}
	}

	blank();

	// ── Badges ──────────────────────────────────────────
	const errBadge = chalk.bgHex(theme.badge.error.bg).hex(theme.badge.error.fg)(
		' ERR ',
	);
	const runBadge = chalk
		.bgHex(theme.badge.running.bg)
		.hex(theme.badge.running.fg)(' RUN ');
	const idleBadge = chalk.bgHex(theme.badge.idle.bg).hex(theme.badge.idle.fg)(
		' IDLE ',
	);
	const searchBadge = chalk.bgHex(theme.badge.search.bg).hex(theme.accent)(
		' SEARCH ',
	);
	const cmdBadge = chalk.bgHex(theme.badge.command.bg).hex(theme.accent)(
		' CMD ',
	);
	row(
		`Badges: ${errBadge} ${runBadge} ${idleBadge} ${searchBadge} ${cmdBadge}`,
	);
	blank();

	// ── Status colors ───────────────────────────────────
	row(
		c(theme.status.success)('success ') +
			c(theme.status.error)('error ') +
			c(theme.status.warning)('warning ') +
			c(theme.status.info)('info ') +
			c(theme.status.neutral)('neutral'),
	);
	blank();

	// ── Detail view ─────────────────────────────────────
	row(
		cb(theme.detail.title)('Read') +
			chalk.dim('(') +
			c(theme.detail.subject)('src/config.ts') +
			chalk.dim(')'),
	);
	blank();

	// ── User message ────────────────────────────────────
	row(c(theme.userMessage.border)('╭' + hr('─', 40) + '╮'));
	row(
		c(theme.userMessage.border)('│') +
			chalk.bgHex(theme.userMessage.background).hex(theme.userMessage.text)(
				pad(' fix the bug in auth', 40),
			) +
			c(theme.userMessage.border)('│'),
	);
	row(c(theme.userMessage.border)('╰' + hr('─', 40) + '╯'));
	blank();

	// ── Input ───────────────────────────────────────────
	row(
		c(theme.inputPrompt)('input') +
			' ' +
			c(theme.inputChevron)('❯') +
			' ' +
			c(theme.textMuted)('type a message...'),
	);
	blank();

	// ── Accent ──────────────────────────────────────────
	row(
		c(theme.accent)('accent') +
			'  ' +
			c(theme.accentSecondary)('accentSecondary'),
	);
	blank();
}

// ── Main ────────────────────────────────────────────────
const filter = process.argv[2];
const themesToShow = filter ? {[filter]: THEMES[filter]} : THEMES;

if (filter && !THEMES[filter]) {
	console.error(`Unknown theme: ${filter}. Use: dark, light, high-contrast`);
	process.exit(1);
}

for (const [name, theme] of Object.entries(themesToShow)) {
	console.log(chalk.bold(`\n${'═'.repeat(W)}`));
	console.log(chalk.bold(`  THEME: ${name.toUpperCase()}`));
	console.log(chalk.bold(`${'═'.repeat(W)}`));

	for (const termBg of TERM_BACKGROUNDS) {
		console.log(chalk.dim(`\n  ▸ ${termBg.name}`));
		renderSection(theme, termBg.bg);
	}
}

console.log();
