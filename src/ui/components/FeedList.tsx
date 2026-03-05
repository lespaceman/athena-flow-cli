import React, {useMemo} from 'react';
import {Box, Static, Text, useStdout} from 'ink';
import type {FeedItem} from '../../core/feed/items';
import {isExpandable} from '../../core/feed/expandable';
import HookEvent from './HookEvent';
import Message from './Message';
import ErrorBoundary from './ErrorBoundary';

type Props = {
	items: FeedItem[];
	focusedId: string | undefined;
	expandedSet: ReadonlySet<string>;
	verbose?: boolean;
	dialogActive: boolean;
};

const VIEWPORT_RESERVE = 10;

export const FEEDLIST_ROW_OVERHEAD = 4;

function renderItem(
	item: FeedItem,
	focusedId: string | undefined,
	expandedSet: ReadonlySet<string>,
	verbose?: boolean,
	parentWidth?: number,
): React.ReactNode {
	if (item.type === 'message') {
		return <Message key={item.data.id} message={item.data} />;
	}

	const event = item.data;
	const expandable = isExpandable(event);
	const isFocused = focusedId === event.event_id;

	return (
		<Box key={event.event_id} flexDirection="row">
			{/* Cursor indicator — 2 chars wide */}
			<Text>{isFocused && expandable ? '› ' : '  '}</Text>
			<Box flexDirection="column" flexGrow={1}>
				<ErrorBoundary
					fallback={<Text color="red">[Error rendering event]</Text>}
				>
					<HookEvent
						event={event}
						verbose={verbose}
						expanded={expandedSet.has(event.event_id)}
						parentWidth={parentWidth}
					/>
				</ErrorBoundary>
			</Box>
			{/* Expand affordance */}
			{expandable && (
				<Text dimColor>{expandedSet.has(event.event_id) ? ' ▾' : ' ▸'}</Text>
			)}
		</Box>
	);
}

export default function FeedList({
	items,
	focusedId,
	expandedSet,
	verbose,
	dialogActive,
}: Props): React.ReactNode {
	const {stdout} = useStdout();
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- columns/rows can be undefined in non-TTY
	const terminalWidth = stdout?.columns ?? 80;
	const contentWidth = terminalWidth - FEEDLIST_ROW_OVERHEAD;
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	const viewportSize = Math.max(10, (stdout?.rows ?? 24) - VIEWPORT_RESERVE);

	// Find the index of the focused item to ensure it's in the viewport
	const focusedIndex = focusedId
		? items.findIndex(
				item => item.type === 'feed' && item.data.event_id === focusedId,
			)
		: -1;

	// Compute viewport start: ensure focused item is visible
	const viewportStart = useMemo(() => {
		if (items.length <= viewportSize) return 0;

		// Default: show the last viewportSize items
		let start = Math.max(0, items.length - viewportSize);

		// If focused item exists, ensure it's in the viewport
		if (focusedIndex >= 0) {
			if (focusedIndex < start) {
				start = focusedIndex;
			} else if (focusedIndex >= start + viewportSize) {
				start = focusedIndex - viewportSize + 1;
			}
		}

		return start;
	}, [items.length, viewportSize, focusedIndex]);

	// Split items into scrollback and viewport
	const scrollbackItems = items.slice(0, viewportStart);
	const viewportItems = items.slice(
		viewportStart,
		viewportStart + viewportSize,
	);

	return (
		<Box flexDirection="column">
			{/* Scrollback: write-once, no cursor indicators */}
			<Static items={scrollbackItems}>
				{(item: FeedItem) =>
					renderItem(item, undefined, expandedSet, verbose, contentWidth)
				}
			</Static>
			{/* Viewport: dynamic, cursor indicators update here */}
			{viewportItems.map(item =>
				renderItem(
					item,
					dialogActive ? undefined : focusedId,
					expandedSet,
					verbose,
					contentWidth,
				),
			)}
		</Box>
	);
}
