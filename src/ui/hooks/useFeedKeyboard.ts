import {useInput} from 'ink';
import {startInputMeasure} from '../../shared/utils/perf';

export type FeedKeyboardCallbacks = {
	moveFeedCursor: (delta: number) => void;
	jumpToTail: () => void;
	jumpToTop: () => void;
	expandAtCursor: () => void;
	yankAtCursor: () => void;
	cycleFocus: () => void;
	setFocusMode: (mode: 'feed' | 'input' | 'todo') => void;
	setInputMode: (mode: 'normal' | 'search' | 'command') => void;
	setInputValue: (value: string) => void;
	setShowRunOverlay: (show: boolean) => void;
	setSearchQuery: (query: string) => void;
	setSearchMatchPos: React.Dispatch<React.SetStateAction<number>>;
	setFeedCursor: (cursor: number) => void;
	setTailFollow: (follow: boolean) => void;
};

export type FeedKeyboardOptions = {
	isActive: boolean;
	pageStep: number;
	searchMatches: number[];
	callbacks: FeedKeyboardCallbacks;
};

export function useFeedKeyboard({
	isActive,
	pageStep,
	searchMatches,
	callbacks,
}: FeedKeyboardOptions): void {
	useInput(
		(input, key) => {
			const done = startInputMeasure('feed.keyboard', input, key);
			try {
				// Escape
				if (key.escape) {
					callbacks.setShowRunOverlay(false);
					return;
				}

				// Feed navigation mode
				if (key.tab) {
					callbacks.cycleFocus();
					return;
				}

				if (input === '/') {
					callbacks.setFocusMode('input');
					callbacks.setInputMode('command');
					callbacks.setInputValue('/');
					return;
				}

				if (input === ':') {
					callbacks.setFocusMode('input');
					callbacks.setInputMode('search');
					callbacks.setInputValue(':');
					return;
				}

				if (key.home) {
					callbacks.jumpToTop();
					return;
				}
				if (key.end) {
					callbacks.jumpToTail();
					return;
				}
				if (key.pageUp) {
					callbacks.moveFeedCursor(-pageStep);
					return;
				}
				if (key.pageDown) {
					callbacks.moveFeedCursor(pageStep);
					return;
				}
				if (key.upArrow) {
					callbacks.moveFeedCursor(-1);
					return;
				}
				if (key.downArrow) {
					callbacks.moveFeedCursor(1);
					return;
				}

				if (key.return || (key.ctrl && key.rightArrow)) {
					callbacks.expandAtCursor();
					return;
				}

				if (input === 'y' || input === 'Y') {
					callbacks.yankAtCursor();
					return;
				}

				if ((input === 'n' || input === 'N') && searchMatches.length > 0) {
					const direction = input === 'n' ? 1 : -1;
					callbacks.setSearchMatchPos(prev => {
						const count = searchMatches.length;
						const next = (prev + direction + count) % count;
						const target = searchMatches[next]!;
						callbacks.setFeedCursor(target);
						callbacks.setTailFollow(false);
						return next;
					});
					return;
				}

				if (key.ctrl && input === 'l') {
					callbacks.setSearchQuery('');
					callbacks.setShowRunOverlay(false);
					callbacks.jumpToTail();
					return;
				}
			} finally {
				done();
			}
		},
		{isActive},
	);
}
