import {Static, Text} from 'ink';
import chalk from 'chalk';
import {type TimelineEntry} from '../../core/feed/timeline';
import {type Theme} from '../theme/types';
import {type FeedColumnWidths, formatFeedRowLine} from './FeedRow';

type Props = {
	entries: TimelineEntry[];
	startIndex: number;
	searchMatchSet: Set<number>;
	ascii: boolean;
	theme: Theme;
	innerWidth: number;
	cols: FeedColumnWidths;
	wrapLine: (content: string) => string;
};

export function FeedScrollback({
	entries,
	startIndex,
	searchMatchSet,
	ascii,
	theme,
	innerWidth,
	cols,
	wrapLine,
}: Props) {
	if (entries.length === 0) return null;
	const stripeBg = theme.feed.stripeBackground;

	return (
		<Static items={entries}>
			{(entry, index) => {
				const globalIndex = startIndex + index;
				const isMatched = searchMatchSet.has(globalIndex);
				const isStriped = globalIndex % 2 === 1;
				const rowBg =
					isStriped && stripeBg
						? chalk.bgHex(stripeBg)
						: (text: string) => text;
				return (
					<Text key={`feed-scrollback-row-${entry.id}`}>
						{wrapLine(
							rowBg(
								formatFeedRowLine({
									entry,
									cols,
									focused: false,
									expanded: false,
									matched: isMatched,
									isDuplicateActor: entry.duplicateActor,
									ascii,
									theme,
									innerWidth,
								}),
							),
						)}
					</Text>
				);
			}}
		</Static>
	);
}
