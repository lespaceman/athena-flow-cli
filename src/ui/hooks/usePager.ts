import process from 'node:process';
import {useState, useCallback, useRef, useEffect} from 'react';
import {useInput} from 'ink';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import {copyToClipboard} from '../../shared/utils/clipboard';
import {
	renderDetailLines,
	renderMarkdownToLines,
} from '../layout/renderDetailLines';
import {type TimelineEntry} from '../../core/feed/timeline';

const PAGER_MARGIN = 3;
const PAGER_PAD_TOP = 1;
const PAGER_PAD_BOTTOM = 1; // blank line above the footer
const PAGER_MOUSE_SCROLL_LINES = 3;

/** Visible content rows in the pager viewport. */
function pagerContentRows(): number {
	const rows = process.stdout.rows ?? 24;
	return rows - PAGER_PAD_TOP - PAGER_PAD_BOTTOM - 1;
}

export type UsePagerOptions = {
	filteredEntriesRef: React.RefObject<TimelineEntry[]>;
	feedCursor: number;
};

export function usePager({filteredEntriesRef, feedCursor}: UsePagerOptions): {
	pagerActive: boolean;
	handleExpandForPager: () => void;
} {
	const [pagerActive, setPagerActive] = useState(false);

	const pendingPagerEntryRef = useRef<TimelineEntry | null>(null);
	const pagerLinesRef = useRef<string[]>([]);
	const pagerScrollRef = useRef(0);
	const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pagerActiveRef = useRef(false);

	const clearCopyToastTimer = useCallback(() => {
		if (copyToastTimerRef.current) {
			clearTimeout(copyToastTimerRef.current);
			copyToastTimerRef.current = null;
		}
	}, []);

	const paintPager = useCallback(() => {
		const lines = pagerLinesRef.current;
		const scroll = pagerScrollRef.current;
		const contentRows = pagerContentRows();
		const visible = lines.slice(scroll, scroll + contentRows);
		const margin = ' '.repeat(PAGER_MARGIN);

		// Clear alternate buffer and move cursor home
		process.stdout.write('\x1B[2J\x1B[H');

		// Top padding
		for (let i = 0; i < PAGER_PAD_TOP; i++) {
			process.stdout.write('\n');
		}

		// Write visible lines, pad to fill viewport
		for (let i = 0; i < contentRows; i++) {
			process.stdout.write((visible[i] ?? '') + '\n');
		}

		// Bottom padding
		for (let i = 0; i < PAGER_PAD_BOTTOM; i++) {
			process.stdout.write('\n');
		}

		// Footer: scroll position + exit hint
		const total = lines.length;
		const end = Math.min(scroll + contentRows, total);
		const pos = total > 0 ? `${scroll + 1}-${end}/${total}` : '0/0';
		process.stdout.write(
			margin +
				chalk.dim(`${pos}  ↑/↓ j/k scroll  PgUp/PgDn page  y copy  q exit`),
		);
	}, []);

	const scrollPager = useCallback(
		(delta: number) => {
			const contentRows = pagerContentRows();
			const maxScroll = Math.max(0, pagerLinesRef.current.length - contentRows);
			const prev = pagerScrollRef.current;
			pagerScrollRef.current = Math.max(0, Math.min(maxScroll, prev + delta));
			if (pagerScrollRef.current !== prev) {
				paintPager();
			}
		},
		[paintPager],
	);

	const handleExpandForPager = useCallback(() => {
		const entry = filteredEntriesRef.current[feedCursor];
		if (!entry?.expandable) return;
		pendingPagerEntryRef.current = entry;
		setPagerActive(true);
	}, [filteredEntriesRef, feedCursor]);

	// Render pager content AFTER Ink has committed the empty <Box />.
	useEffect(() => {
		if (!pagerActive || !pendingPagerEntryRef.current) return;
		const entry = pendingPagerEntryRef.current;
		pendingPagerEntryRef.current = null;

		const contentWidth = Math.max(
			10,
			(process.stdout.columns ?? 80) - PAGER_MARGIN * 2,
		);
		const margin = ' '.repeat(PAGER_MARGIN);

		const lines = entry.feedEvent
			? renderDetailLines(entry.feedEvent, contentWidth, entry.pairedPostEvent)
					.lines
			: renderMarkdownToLines(entry.details || entry.summary, contentWidth);

		pagerLinesRef.current = lines.map(line => margin + line);
		pagerScrollRef.current = 0;

		// Enter alternate screen and enable SGR mouse tracking for wheel events
		process.stdout.write('\x1B[?1049h');
		process.stdout.write('\x1B[?1000h\x1B[?1006h');
		paintPager();
	}, [pagerActive, paintPager]);

	// While pager is active, AppShell still re-renders as feed events arrive.
	// Ink can repaint an empty frame over the alternate-screen content, so
	// repaint the pager after every active render to keep the detail view visible.
	useEffect(() => {
		if (!pagerActive) return;
		if (pagerLinesRef.current.length === 0) return;
		paintPager();
	});

	useEffect(() => {
		pagerActiveRef.current = pagerActive;
		if (!pagerActive) {
			clearCopyToastTimer();
		}
	}, [pagerActive, clearCopyToastTimer]);

	useEffect(() => {
		return () => {
			clearCopyToastTimer();
		};
	}, [clearCopyToastTimer]);

	// Pager keyboard handler: scroll + exit
	useInput(
		(input, key) => {
			if (input === 'y' || input === 'Y') {
				const content = pagerLinesRef.current
					.map(line => stripAnsi(line).trimEnd())
					.join('\n');
				copyToClipboard(content);
				// Flash "Copied!" in pager footer
				const margin = ' '.repeat(PAGER_MARGIN);
				const rows = process.stdout.rows ?? 24;
				process.stdout.write(`\x1B[${rows};1H`);
				process.stdout.write(
					margin + chalk.bold.green('Copied to clipboard!') + '\x1B[K',
				);
				clearCopyToastTimer();
				copyToastTimerRef.current = setTimeout(() => {
					copyToastTimerRef.current = null;
					if (pagerActiveRef.current) {
						paintPager();
					}
				}, 1500);
				return;
			}

			if (key.escape || input === 'q' || input === 'Q') {
				clearCopyToastTimer();
				pagerLinesRef.current = [];
				pagerScrollRef.current = 0;
				// Disable mouse tracking, then leave alternate screen
				process.stdout.write('\x1B[?1006l\x1B[?1000l');
				process.stdout.write('\x1B[?1049l');
				setPagerActive(false);
				return;
			}

			if (key.upArrow || input === 'k' || input === 'K') {
				scrollPager(-1);
			} else if (key.downArrow || input === 'j' || input === 'J') {
				scrollPager(1);
			} else if (key.pageUp) {
				scrollPager(-Math.floor(pagerContentRows() / 2));
			} else if (key.pageDown) {
				scrollPager(Math.floor(pagerContentRows() / 2));
			} else if (key.home || input === 'g') {
				scrollPager(-Infinity);
			} else if (key.end || input === 'G') {
				scrollPager(Infinity);
			}
		},
		{isActive: pagerActive},
	);

	// Pager mouse wheel handler: listen for SGR mouse escape sequences on stdin.
	// Ink's useInput doesn't reliably pass multi-byte mouse sequences, so we
	// attach a raw 'data' listener that matches the SGR wheel pattern.
	useEffect(() => {
		if (!pagerActive) return;

		// SGR mouse format: \x1B[<button;col;rowM (press) or ...m (release)
		// Button 64 = wheel up, 65 = wheel down
		// eslint-disable-next-line no-control-regex
		const SGR_MOUSE_RE = /\x1B\[<(64|65);\d+;\d+[Mm]/g;

		const onData = (data: Buffer) => {
			const str = data.toString('utf8');
			let match: RegExpExecArray | null;
			while ((match = SGR_MOUSE_RE.exec(str)) !== null) {
				const button = match[1];
				if (button === '64') {
					scrollPager(-PAGER_MOUSE_SCROLL_LINES);
				} else if (button === '65') {
					scrollPager(PAGER_MOUSE_SCROLL_LINES);
				}
			}
		};

		process.stdin.on('data', onData);
		return () => {
			process.stdin.removeListener('data', onData);
		};
	}, [pagerActive, scrollPager]);

	return {pagerActive, handleExpandForPager};
}
